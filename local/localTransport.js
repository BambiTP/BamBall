// localTransport.js - replaces net/socket.js. Runs the real, authoritative
// GameInstance in this same tab and feeds the client's existing packet
// pipeline (packetRouter -> packetApplier -> state/render) exactly the
// packets a real server would send, built by the same, unmodified
// packetBuilders.js the server uses. Nothing downstream of packetRouter
// knows or cares that these packets never touched a WebSocket - that's the
// whole point: this is also the seam a future webrtcTransport.js drops
// into unchanged for peer-to-peer play (same packet shapes, same
// packetRouter.dispatch() calls, different origin).
//
// The `socket` global below exists only so client/game/app/actions.js
// (reused verbatim) has something to call .send() on - it mirrors
// server/packets/incoming.js's HANDLERS table, just calling straight into
// GameInstance instead of through session/input managers, since there's
// only ever one local client here.

var localTransport = (function () {
  var WORKER_URL = 'https://api.bambipro.workers.dev';

  var gi = null;
  var recorder = null;
  var roomCode = null; // minted by the Worker at boot - see requestRoomCode()
  var localId = 1;
  var client = { id: localId, team: 'spectator' };
  var account = { display_name: 'Player' };

  // Every room gets a unique, permanent code from the Worker (confirmed
  // requirement) - it's what a finished replay gets stored/found under
  // (WORKER_URL + '/replays/' + roomCode). Best-effort: if the Worker is
  // unreachable, the game still boots and plays fine, it just has no
  // replay home to upload to (recorder.finish() still works, the download
  // fallback still fires - see the matchEnd handler below).
  function requestRoomCode() {
    return fetch(WORKER_URL + '/api/groups', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        roomCode = data.code || null;
        if (roomCode) console.log('[localTransport] room code: ' + roomCode + ' (replay will be at ' + WORKER_URL + '/replays/' + roomCode + ')');
        appEvents.emit('roomCode:ready', roomCode);
        return roomCode;
      })
      .catch(function (err) {
        console.warn('[localTransport] could not reach the room server, playing without one:', err);
        return null;
      });
  }

  // Uploads a finished recording to its room's permanent URL, if this
  // session got a room code at all. Failures are logged, not thrown - a
  // player's local download (matchEnd handler below) is never blocked on
  // the network round-trip to the Worker succeeding.
  function persistRecording(result, meta) {
    if (!roomCode) return Promise.resolve(null);
    return uploadReplay(WORKER_URL, roomCode, result.blob, result.gzip, meta)
      .then(function (data) {
        console.log('[localTransport] replay saved at ' + WORKER_URL + data.url);
        return data;
      })
      .catch(function (err) {
        console.warn('[localTransport] replay upload failed:', err);
        return null;
      });
  }

  // engine event name -> packet builder, the same table
  // server/packets/outgoing.js's EVENT_MAP uses - kept in sync by hand
  // since this build has no server file to import it from.
  var EVENT_MAP = {
    score:                packetBuilders.score,
    setTile:               packetBuilders.setTile,
    connectionsChanged:    packetBuilders.connections,
    spawnPointsChanged:    packetBuilders.spawnPoints,
    capture:               packetBuilders.capture,
    physicsChanged:        packetBuilders.physicsChanged,
    playerPhysicsChanged:  packetBuilders.playerPhysicsChanged,
    tileSettingsChanged:   packetBuilders.tileSettingsChanged,
    overlayStroke:         packetBuilders.overlayStroke,
    overlayUndo:           packetBuilders.overlayUndo,
    overlayClear:          packetBuilders.overlayClear,
    matchEnd:               packetBuilders.matchEnd,
    powerupPreview:        packetBuilders.powerupPreview,
    customTileUpsert:      packetBuilders.customTileUpsert,
    customTileCatalog:     packetBuilders.customTileCatalog,
    customTileDeleted:     packetBuilders.customTileDeleted,
    chat:                   packetBuilders.chat,
  };

  function wireEngineEvents() {
    Object.keys(EVENT_MAP).forEach(function (event) {
      var builder = EVENT_MAP[event];
      gi.emitter.on(event, function () {
        var packet = builder.apply(null, arguments);
        packetRouter.dispatch(packet);
        recorder.recordBroadcast(packet);
      });
    });

    gi.emitter.on('matchStateChanged', function () {
      packetRouter.dispatch(packetBuilders.matchState(gi.gameState));
      recorder.recordBroadcast(packetBuilders.matchState(gi.gameState));
      appEvents.emit('matchStateApplied', gi.gameState.state);

      // Matches the real server's rule (server/packets/outgoing.js): a
      // fresh match going live always starts recording.
      if (gi.gameState.state === 'countdown' && !recorder.isRecording() && !recorder.isEnded()) {
        recorder.start(mapDataFrom(gi.gameState));
      }

      // Confirmed behavior: picking a team is enough - anyone on red/blue
      // who hasn't explicitly joined yet is auto-spawned the moment a
      // match actually starts, rather than requiring a separate Join Game
      // click. (Join Game still exists for jumping in mid-pregame, or
      // after Leave Game, without waiting for the next match.)
      if (gi.gameState.state === 'countdown' && !gi.gameState.getPlayer(localId)
          && (client.team === 'red' || client.team === 'blue')) {
        joinGame();
      }
    });

    gi.emitter.on('matchEnd', function (data) {
      if (!recorder.isRecording()) return;
      var meta = {
        mapName: gi.gameState.mapName,
        mapId:   gi.gameState.mapId,
        winner:  data.winner,
        reason:  data.reason,
        scores:  data.scores,
      };
      recorder.finish(data).then(function (result) {
        downloadBlob(result.blob, result.filename);
        persistRecording(result, meta);
      });
    });

    // Only the collecting player needs their own effect timer.
    gi.emitter.on('powerupCollected', function (playerId, key, timerMs) {
      if (playerId !== localId) return;
      packetRouter.dispatch(packetBuilders.powerupCollected(key, timerMs));
    });

    // Snapshots are per-viewer server-side; there's only one viewer here.
    gi.emitter.on('snapshot', function (deltas, immediate) {
      var delta = deltas.get(localId);
      if (delta) packetRouter.dispatch(packetBuilders.snapshot(delta, immediate));
    });

    // The un-culled, globally-deduplicated equivalent of 'snapshot' - see
    // game/snapshotFactory.js's buildReplayDelta - fed to the recorder
    // regardless of whether anyone's watching live, same as the server.
    gi.emitter.on('replayPlayers', function (delta) {
      recorder.recordPlayerDelta(delta);
    });
  }

  function mapDataFrom(gameState) {
    return {
      map: gameState.map,
      wallMap: gameState.wallMap,
      wells: gameState.wells,
      mapId: gameState.mapId,
      mapName: gameState.mapName,
      mapAuthor: gameState.mapAuthor,
      switches: gameState.switches,
      portals: gameState.portals,
      tileOverrides: gameState.tileOverrides,
      spawnPoints: gameState.spawnPoints,
      mapOverlayStrokes: gameState.mapOverlayStrokes,
      tileOverlayStrokes: gameState.tileOverlayStrokes,
    };
  }

  // ---- outgoing packet handling (client/game/app/actions.js calls into
  // this via the `socket` global below) - mirrors server/packets/
  // incoming.js's HANDLERS table, minus everything this build's UI never
  // sends (settings panels, leader controls, map editor - all dropped).

  // Matches playerSessionManager.setTeam: switching team while already
  // spawned kills the old body and respawns fresh on the new team
  // immediately, rather than leaving a red body standing around for a
  // player who's now blue.
  function setTeam(team) {
    var previousTeam = client.team;
    client.team = team;
    packetRouter.dispatch({ type: 'team', team: team });

    if (team === previousTeam) return;
    var player = gi.gameState.getPlayer(localId);
    if (player) {
      gi.gameHelpers.removePlayer(localId);
      packetRouter.dispatch({ type: 'leftGame' });
      if (team === 'red' || team === 'blue') {
        var respawned = gi.gameHelpers.spawnPlayer(localId, team, account.display_name);
        packetRouter.dispatch({ type: 'joinedGame', player: serializePlayer(respawned) });
      }
    }
  }

  function joinGame() {
    if (gi.gameState.getPlayer(localId)) return;
    if (client.team !== 'red' && client.team !== 'blue') {
      packetRouter.dispatch({ type: 'error', message: 'select red or blue before joining the game' });
      return;
    }
    var player = gi.gameHelpers.spawnPlayer(localId, client.team, account.display_name);
    packetRouter.dispatch({ type: 'joinedGame', player: serializePlayer(player) });

    // Confirmed default: auto-start the moment the first (only) player
    // joins, since there's no leader/lobby step in this build.
    if (gi.gameState.state === 'pregame') gi.matchManager.startMatch();
  }

  function leaveGame() {
    var player = gi.gameState.getPlayer(localId);
    if (!player) {
      packetRouter.dispatch({ type: 'error', message: 'not currently in the game' });
      return;
    }
    gi.gameHelpers.removePlayer(localId);
    packetRouter.dispatch({ type: 'leftGame' });
  }

  function setInput(packet) {
    var player = gi.gameState.getPlayer(localId);
    if (!player) return;
    player.left  = !!packet.left;
    player.right = !!packet.right;
    player.up    = !!packet.up;
    player.down  = !!packet.down;
    recorder.recordInput(localId, packet);
  }

  function handleOutgoing(packet) {
    switch (packet.type) {
      case 'join_red':       return setTeam('red');
      case 'join_blue':      return setTeam('blue');
      case 'join_spectator': return setTeam('spectator');
      case 'join_game':      return joinGame();
      case 'leave_game':     return leaveGame();
      case 'input':          return setInput(packet);
      case 'ping':            return packetRouter.dispatch({ type: 'pong', t: packet.t });
      case 'detonateBomb': {
        var player = gi.gameState.getPlayer(localId);
        if (!player || player.dead || player.frozen || player.matchFrozen) return;
        var affected = gi.gameHelpers.detonateRollingBomb(player);
        if (affected) gi.emitter.emit('update', affected);
        return;
      }
      case 'chat': {
        // Meaningless with one player, but shouldn't dead-end either - same
        // round-trip-through-the-log every other transport gives it.
        var text = typeof packet.text === 'string' ? packet.text.trim().slice(0, 240) : '';
        if (!text) return;
        var chatPacket = packetBuilders.chat({ id: localId, name: account.display_name, text: text });
        packetRouter.dispatch(chatPacket);
        recorder.recordBroadcast(chatPacket);
        return;
      }
      default:
        // Everything else (settings/leader/editor packets) has no handler
        // in this build - the UI that would send them was dropped.
        return;
    }
  }

  // client/game/app/actions.js references the bare global `socket` -
  // this is the whole of that surface this build needs.
  var socket = {
    send: function (packet) { handleOutgoing(packet); return true; },
    connect: function () {},
    closeByUser: function () {},
    isOpen: function () { return true; },
    setSimulatedLatency: function () { return 0; },
    simulatedLatency: function () { return 0; },
  };
  globalThis.socket = socket;

  // Boots the engine, loads the bundled default map, and seeds client
  // state exactly like a real 'joined' packet would (built by the same,
  // unmodified packetBuilders.joined - trivial local stand-ins for
  // room/client/account are all it needs). Starts the engine's own 60Hz
  // authoritative tick+snapshot loop; the caller (main.js) is responsible
  // for starting the client's own prediction loop (client/game/loop.js)
  // separately, same as the real client does against a real server.
  async function boot() {
    requestRoomCode(); // fire-and-forget in parallel - never blocks the map/game from loading
    var res    = await fetch('./assets/maps/default.json');
    var mapDoc = await res.json();

    gi = new GameInstance(gameConfig, 'game');
    recorder = createLocalReplayRecorder(gi);
    wireEngineEvents();

    // The authoritative (engine) physics world: one Box2D body per wall
    // tile on the whole map (~1200+ for the default map). Tried chunking
    // this across frames (40 tiles/frame) to guarantee no single frame
    // could ever block - measured cost: ~35 extra frame-waits, ~500-600ms
    // of pure waiting on top of the ~200-300ms the work itself takes,
    // nearly tripling load time. Reverted: the defer'd scripts, the
    // loading overlay, and antialias:false (client/render/renderer.js)
    // already fixed the actual reported freeze - that was GPU/driver cost
    // from forced MSAA on a live tab that otherwise loaded clean and fast
    // (confirmed directly: <20MB heap, no errors). Straightforward
    // synchronous build is faster and was never the real problem.
    gi.loadMap(mapDoc);

    // The separate client-side prediction physics world (client/
    // physicsWorld.js, built inside applyJoined below) - same map, its own
    // Box2D bodies, needed so the local player's own movement predicts
    // correctly.
    var room = { instance: gi, kind: 'game', leaderId: localId };
    var joinedPacket = packetBuilders.joined(room, client, account, mapDataFrom(gi.gameState));
    packetApplier.applyJoined(joinedPacket);

    gi.start();
    return gi;
  }

  // Switches the live game to a different bundled map (assets/maps/<file>)
  // - the Settings Maker's map picker uses this. Reuses the client's
  // existing 'mapChanged' handler (client/game/app/packetApplier.js)
  // unchanged: it already tears down every player sprite/body and rebuilds
  // the renderer from a mapChanged-shaped packet, exactly what a real
  // server-driven map change does. Players have to rejoin (Join Red/Blue)
  // after switching, same as the real game.
  function switchMap(mapFile) {
    if (!gi) return Promise.reject(new Error('not booted yet'));
    return fetch('./assets/maps/' + mapFile)
      .then(function (res) { return res.json(); })
      .then(function (mapDoc) {
        gi.gameState.players.slice().forEach(function (p) { gi.gameHelpers.removePlayer(p.id); });
        gi.loadMap(mapDoc);
        client.team = 'spectator';
        packetRouter.dispatch(Object.assign({ type: 'mapChanged' }, mapDataFrom(gi.gameState)));
      });
  }

  return {
    boot: boot, localId: localId,
    getRoomCode: function () { return roomCode; },
    gameInstance: function () { return gi; },
    matchState: function () { return gi ? gi.gameState.state : null; },
    switchMap: switchMap,
    workerUrl: WORKER_URL,
  };
})();
