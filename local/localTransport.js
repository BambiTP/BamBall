// localTransport.js - replaces net/socket.js. Runs the real, authoritative
// GameInstance in this same tab and feeds the client's existing packet
// pipeline (packetRouter -> packetApplier -> state/render) exactly the
// packets a real server would send, built by the same, unmodified
// packetBuilders.js the server uses. Nothing downstream of packetRouter
// knows or cares that these packets never touched a WebSocket.
//
// Thin adapter over local/hostSession.js: a session with exactly one local
// client and never any peers. local/webrtcTransport.js's HOST role and
// node-host/hostCli.js are the same session logic, just with peers (and,
// for hostCli, no local client at all) - see hostSession.js's header.

var localTransport = (function () {
  var WORKER_URL = 'https://api.bamball.workers.dev';

  var gi = null;
  var recorder = null;
  var session = null;
  var roomCode = null; // minted by the Worker at boot - see requestRoomCode()
  var localId = 1;
  var client  = { team: 'spectator' };
  var account = { display_name: 'Player', flairIndex: null };

  // Every room gets a unique, permanent code from the Worker (confirmed
  // requirement) - it's what a finished replay gets stored/found under
  // (WORKER_URL + '/replays/' + roomCode). Best-effort: if the Worker is
  // unreachable, the game still boots and plays fine, it just has no
  // replay home to upload to (recorder.finish() still works, the download
  // fallback still fires).
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
  // player's local download is never blocked on the network round-trip to
  // the Worker succeeding.
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

  // client/app.js references the bare global `socket` - this is the whole
  // of that surface this build needs.
  var socket = {
    send: function (packet) { session.handleOutgoing(localId, packet); return true; },
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
  // for starting the client's own prediction loop separately, same as the
  // real client does against a real server.
  async function boot() {
    requestRoomCode(); // fire-and-forget in parallel - never blocks the map/game from loading

    // Solo still has a real (single-player) room underneath, and the same
    // flair picker (local/flairPicker.js) works on this build too - carry
    // over whatever this browser already has saved.
    if (typeof localSettings !== 'undefined' && typeof localSettings.flairIndex === 'number') {
      account.flairIndex = localSettings.flairIndex;
    }

    var res    = await fetch(GAME_BASE_PATH + 'assets/maps/default.json');
    var mapDoc = await res.json();

    gi = new GameInstance(gameConfig, 'game');
    recorder = createLocalReplayRecorder(gi);
    session = HostSession.createHostSession(gi, {
      recorder: recorder,
      workerUrl: WORKER_URL,
      localClient: { client: client, account: account, dispatch: packetRouter.dispatch },
      resolveMap: function (mapId) {
        return importFortunateMap(mapId).then(function (mapDoc) {
          return { mapDoc: mapDoc, mapMeta: { type: 'fortunatemaps', id: String(mapId) } };
        });
      },
      onReplayFinished: function (result, meta) {
        downloadBlob(result.blob, result.filename);
        persistRecording(result, meta);
      },
    });
    session.wireEngineEvents();

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
    var joinedPacket = packetBuilders.joined(room, client, account, HostSession.mapDataFrom(gi.gameState));
    packetApplier.applyJoined(joinedPacket);

    gi.start();
    return gi;
  }

  // Switches the live game to a Fortunate Maps id (local/
  // fortunateMapsImport.js) - the Settings tab's map field uses this.
  // Players have to rejoin (Join Red/Blue) after switching, same as the
  // real game.
  function switchMap(mapId) {
    if (!gi) return Promise.reject(new Error('not booted yet'));
    return importFortunateMap(mapId).then(function (mapDoc) {
      session.switchMap(mapDoc, { type: 'fortunatemaps', id: String(mapId) });
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
