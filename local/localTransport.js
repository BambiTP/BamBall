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
  var gi = null;
  var localId = 1;
  var client = { id: localId, team: 'spectator' };
  var account = { display_name: 'Player' };

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
        packetRouter.dispatch(builder.apply(null, arguments));
      });
    });

    gi.emitter.on('matchStateChanged', function () {
      packetRouter.dispatch(packetBuilders.matchState(gi.gameState));
    });

    // Only the collecting player needs their own effect timer.
    gi.emitter.on('powerupCollected', function (playerId, key, timerMs) {
      if (playerId !== localId) return;
      packetRouter.dispatch(packetBuilders.powerupCollected(key, timerMs));
    });

    // Snapshots are per-viewer server-side; there's only one viewer here.
    gi.emitter.on('snapshot', function (deltas) {
      var delta = deltas.get(localId);
      if (delta) packetRouter.dispatch(packetBuilders.snapshot(delta));
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

  function setTeam(team) {
    client.team = team;
    packetRouter.dispatch({ type: 'team', team: team });
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

  function setInput(packet) {
    var player = gi.gameState.getPlayer(localId);
    if (!player) return;
    player.left  = !!packet.left;
    player.right = !!packet.right;
    player.up    = !!packet.up;
    player.down  = !!packet.down;
  }

  function handleOutgoing(packet) {
    switch (packet.type) {
      case 'join_red':       return setTeam('red');
      case 'join_blue':      return setTeam('blue');
      case 'join_spectator': return setTeam('spectator');
      case 'join_game':      return joinGame();
      case 'input':          return setInput(packet);
      case 'ping':            return packetRouter.dispatch({ type: 'pong', t: packet.t });
      case 'detonateBomb': {
        var player = gi.gameState.getPlayer(localId);
        if (!player || player.dead || player.frozen || player.matchFrozen) return;
        var affected = gi.gameHelpers.detonateRollingBomb(player);
        if (affected) gi.emitter.emit('update', affected);
        return;
      }
      default:
        // Everything else (settings/leader/editor/chat packets) has no
        // handler in this build - the UI that would send them was dropped.
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
  function boot() {
    return fetch('./assets/maps/default.json')
      .then(function (res) { return res.json(); })
      .then(function (mapDoc) {
        gi = new GameInstance(gameConfig, 'game');
        wireEngineEvents();
        gi.loadMap(mapDoc);

        var room = { instance: gi, kind: 'game', leaderId: localId };
        var joinedPacket = packetBuilders.joined(room, client, account, mapDataFrom(gi.gameState));
        packetApplier.applyJoined(joinedPacket);

        gi.start();
        return gi;
      });
  }

  return { boot: boot, localId: localId };
})();
