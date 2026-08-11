// webrtcTransport.js - the P2P transport: host-authoritative, exactly the
// design localTransport.js's header comment already promised ("the seam a
// future webrtcTransport.js drops into unchanged for peer-to-peer play").
//
// Two roles, one file:
//   HOST - runs the real, authoritative GameInstance (same as
//     localTransport.js does for the solo build), for its own local
//     player AND every connected peer. Broadcasts every packet to every
//     peer's data channel in addition to its own local packetRouter.
//   PEER - runs no GameInstance at all - just the same client rendering/
//     prediction pipeline (packetApplier/packetRouter/client physicsWorld)
//     the solo build's local player already uses, fed by packets arriving
//     over the data channel instead of from a local GameInstance. This is
//     structurally identical to what the ORIGINAL (pre-local-pivot)
//     networked client did against a real WebSocket server - only the
//     transport underneath is different.
//
// Deliberately a separate file from localTransport.js rather than a deep
// shared refactor of it: the solo build is proven and actively played -
// generalizing its single-client assumptions (bare `client`/`localId`)
// into a multi-client model risked regressing it for a feature (P2P) that
// needs its own careful, separate verification anyway. Some logic
// (mapDataFrom, the EVENT_MAP table, setTeam/joinGame/leaveGame/setInput
// shape) is intentionally duplicated here in generalized (per-clientId)
// form rather than imported - worth unifying later once this is proven
// stable, not before.
//
// Signaling: worker/src/roomSignal.js (Durable Object, one per room code).
// No TURN server (accepted gap from the original plan - Cloudflare has no
// managed TURN today): peers behind symmetric NAT/strict firewalls may
// fail to connect directly. Free public STUN only.

var webrtcTransport = (function () {
  var WORKER_URL = 'https://api.bambipro.workers.dev';
  var SIGNAL_URL = WORKER_URL.replace(/^http/, 'ws') + '/api/signal/';
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  var gi = null;
  var recorder = null;
  var roomCode = null;
  var role = null; // 'host' | 'peer'
  var myPeerId = null;
  var signalWs = null;
  var signalReady = null; // Promise, resolves with the 'welcome' payload

  var LOCAL_CLIENT_ID = 1; // this tab's own local player, same convention as localTransport.js

  // ---- HOST-only state -----------------------------------------------
  var nextClientId = 2; // 1 is reserved for the host's own local player
  var peers = {}; // signalPeerId -> { pc, dc, clientId, client: {team, account}, ready:boolean }
  var hostClient = { id: LOCAL_CLIENT_ID, team: 'spectator' };
  var hostAccount = { display_name: 'Host' };

  // ---- PEER-only state -------------------------------------------------
  var hostSignalId = null;
  var hostPc = null;
  var hostDc = null;
  var joinedApplied = false;

  function newPeerId() {
    return 'p' + Math.random().toString(36).slice(2, 10);
  }

  // ---- shared: room code + replay persistence (same as localTransport.js) ----

  function requestRoomCode() {
    return fetch(WORKER_URL + '/api/rooms', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        roomCode = data.code || null;
        appEvents.emit('roomCode:ready', roomCode);
        return roomCode;
      });
  }

  function persistRecording(result, meta) {
    if (!roomCode) return Promise.resolve(null);
    return uploadReplay(WORKER_URL, roomCode, result.blob, result.gzip, meta)
      .catch(function (err) { console.warn('[webrtcTransport] replay upload failed:', err); return null; });
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

  // ---- signaling ---------------------------------------------------------

  // Resolves once 'welcome' arrives (peerId assigned, hostId known, current
  // peer list) - both boot paths below need that before doing anything else.
  function connectSignal(code, wantRole) {
    myPeerId = newPeerId();
    role = wantRole;
    var url = SIGNAL_URL + code + '?peerId=' + myPeerId + '&role=' + wantRole;
    signalWs = new WebSocket(url);

    signalReady = new Promise(function (resolve, reject) {
      signalWs.addEventListener('message', function onMessage(event) {
        var msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
          signalWs.removeEventListener('message', onMessage);
          resolve(msg);
        }
      });
      signalWs.addEventListener('close', function (event) {
        if (event.code === 4001) reject(new Error(event.reason || 'room already has a host'));
      });
      signalWs.addEventListener('error', function () { reject(new Error('signaling connection failed')); });
    });

    signalWs.addEventListener('message', function (event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'signal') handleSignalMessage(msg.from, msg.data);
      else if (msg.type === 'peer-joined' && role === 'host') handlePeerJoined(msg.peerId);
      else if (msg.type === 'peer-left') handlePeerLeft(msg.peerId);
    });

    return signalReady;
  }

  function sendSignal(toPeerId, data) {
    signalWs.send(JSON.stringify({ type: 'signal', to: toPeerId, data: data }));
  }

  function handleSignalMessage(fromPeerId, data) {
    if (role === 'host') {
      var entry = peers[fromPeerId];
      if (!entry) return; // shouldn't happen - we create the entry on peer-joined before any signal arrives
      if (data.candidate) entry.pc.addIceCandidate(data.candidate).catch(function () {});
      else if (data.type === 'answer') entry.pc.setRemoteDescription(data).catch(function () {});
    } else {
      if (!hostPc) return;
      if (data.candidate) hostPc.addIceCandidate(data.candidate).catch(function () {});
      else if (data.type === 'offer') handleHostOffer(data);
    }
  }

  function handlePeerLeft(peerId) {
    if (role !== 'host') return;
    var entry = peers[peerId];
    if (!entry) return;
    if (entry.pc) entry.pc.close();
    if (entry.ready) {
      var clientId = entry.clientId;
      var player = gi.gameState.getPlayer(clientId);
      if (player) gi.gameHelpers.removePlayer(clientId);
    }
    delete peers[peerId];
  }

  // ---- HOST role -----------------------------------------------------

  function handlePeerJoined(peerId) {
    var clientId = nextClientId++;
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    var entry = { pc: pc, dc: null, clientId: clientId, client: { id: clientId, team: 'spectator' }, account: { display_name: 'Player ' + clientId }, ready: false };
    peers[peerId] = entry;

    pc.addEventListener('icecandidate', function (event) {
      if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
    });

    var dc = pc.createDataChannel('game', { ordered: true });
    entry.dc = dc;
    wireHostDataChannel(peerId, entry);

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () { sendSignal(peerId, offer); });
    });
  }

  function wireHostDataChannel(peerId, entry) {
    entry.dc.addEventListener('open', function () {
      entry.ready = true;
      // Seed the new peer's client state exactly like localTransport.js's
      // boot() seeds the local player - same packetBuilders.joined, same
      // room/account shape, just sent over the wire instead of applied
      // in-process.
      var room = { instance: gi, kind: 'game', leaderId: LOCAL_CLIENT_ID };
      var joinedPacket = packetBuilders.joined(room, entry.client, entry.account, mapDataFrom(gi.gameState));
      entry.dc.send(JSON.stringify(joinedPacket));
    });
    entry.dc.addEventListener('message', function (event) {
      var packet = JSON.parse(event.data);
      handleOutgoingFor(entry.clientId, entry, packet);
    });
    entry.dc.addEventListener('close', function () { handlePeerLeft(peerId); });
  }

  // Every send to a peer's data channel goes through this - a channel can
  // close (peer navigated away, connection dropped) at any moment between
  // an engine event firing and this line running, and an unguarded
  // .send() throwing here isn't safe to let propagate: several of these
  // call sites run inside gi.emitter listeners fired from
  // gameInstance.js's pushSnapshots(), which is itself wrapped in a
  // try/catch that calls crash() (stops the whole match, for every
  // player) on ANY exception. One peer's data channel closing at the
  // wrong instant must never be able to end the match for everyone else.
  function safeSend(entry, packet) {
    if (!entry.ready || entry.dc.readyState !== 'open') return;
    try { entry.dc.send(JSON.stringify(packet)); } catch (e) { /* dropped, peer-left will clean up */ }
  }

  function broadcastToPeers(packet) {
    for (var id in peers) safeSend(peers[id], packet);
  }

  // Same event table as localTransport.js's EVENT_MAP - broadcasts to the
  // host's own screen AND every connected peer, instead of just its own
  // screen.
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

  function wireHostEngineEvents() {
    Object.keys(EVENT_MAP).forEach(function (event) {
      var builder = EVENT_MAP[event];
      gi.emitter.on(event, function () {
        var packet = builder.apply(null, arguments);
        packetRouter.dispatch(packet);
        recorder.recordBroadcast(packet);
        broadcastToPeers(packet);
      });
    });

    gi.emitter.on('matchStateChanged', function () {
      var packet = packetBuilders.matchState(gi.gameState);
      packetRouter.dispatch(packet);
      recorder.recordBroadcast(packet);
      broadcastToPeers(packet);
      appEvents.emit('matchStateApplied', gi.gameState.state);

      if (gi.gameState.state === 'countdown' && !recorder.isRecording() && !recorder.isEnded()) {
        recorder.start(mapDataFrom(gi.gameState));
      }

      // Auto-join on match start, generalized to every connected client
      // (host's own local player AND every ready peer) who's picked a
      // team but hasn't spawned yet - same rule localTransport.js applies
      // to the one local player in the solo build.
      if (gi.gameState.state === 'countdown') {
        if (!gi.gameState.getPlayer(LOCAL_CLIENT_ID) && (hostClient.team === 'red' || hostClient.team === 'blue')) {
          joinGameFor(LOCAL_CLIENT_ID, hostClient, hostAccount);
        }
        for (var id in peers) {
          var entry = peers[id];
          if (entry.ready && !gi.gameState.getPlayer(entry.clientId) && (entry.client.team === 'red' || entry.client.team === 'blue')) {
            joinGameFor(entry.clientId, entry.client, entry.account);
          }
        }
      }
    });

    gi.emitter.on('matchEnd', function (data) {
      if (!recorder.isRecording()) return;
      var meta = { mapName: gi.gameState.mapName, mapId: gi.gameState.mapId, winner: data.winner, reason: data.reason, scores: data.scores };
      recorder.finish(data).then(function (result) {
        downloadBlob(result.blob, result.filename);
        persistRecording(result, meta);
      });
    });

    // Per-viewer events: sent to whichever client actually owns them, not
    // broadcast to everyone - same distinction the server makes.
    gi.emitter.on('powerupCollected', function (playerId, key, timerMs) {
      var packet = packetBuilders.powerupCollected(key, timerMs);
      if (playerId === LOCAL_CLIENT_ID) { packetRouter.dispatch(packet); return; }
      for (var id in peers) {
        if (peers[id].clientId === playerId) safeSend(peers[id], packet);
      }
    });

    gi.emitter.on('snapshot', function (deltas) {
      var localDelta = deltas.get(LOCAL_CLIENT_ID);
      if (localDelta) packetRouter.dispatch(packetBuilders.snapshot(localDelta));
      for (var id in peers) {
        var entry = peers[id];
        var delta = deltas.get(entry.clientId);
        if (delta) safeSend(entry, packetBuilders.snapshot(delta));
      }
    });

    gi.emitter.on('replayPlayers', function (delta) {
      recorder.recordPlayerDelta(delta);
    });
  }

  // Generalized localTransport.js setTeam/joinGame/leaveGame/setInput,
  // parameterized by clientId + the client's own {team}/{account} record
  // instead of the single hardcoded local ones.
  function setTeamFor(clientId, clientRec, accountRec, team, dispatch) {
    var previousTeam = clientRec.team;
    clientRec.team = team;
    dispatch({ type: 'team', team: team });

    if (team === previousTeam) return;
    var player = gi.gameState.getPlayer(clientId);
    if (player) {
      gi.gameHelpers.removePlayer(clientId);
      dispatch({ type: 'leftGame' });
      if (team === 'red' || team === 'blue') {
        var respawned = gi.gameHelpers.spawnPlayer(clientId, team, accountRec.display_name);
        dispatch({ type: 'joinedGame', player: serializePlayer(respawned) });
      }
    }
  }

  function joinGameFor(clientId, clientRec, accountRec) {
    if (gi.gameState.getPlayer(clientId)) return;
    if (clientRec.team !== 'red' && clientRec.team !== 'blue') return;
    var player = gi.gameHelpers.spawnPlayer(clientId, clientRec.team, accountRec.display_name);
    var packet = { type: 'joinedGame', player: serializePlayer(player) };
    if (clientId === LOCAL_CLIENT_ID) packetRouter.dispatch(packet);
    else broadcastToOne(clientId, packet);
    if (gi.gameState.state === 'pregame') gi.matchManager.startMatch();
  }

  function broadcastToOne(clientId, packet) {
    for (var id in peers) {
      if (peers[id].clientId === clientId) safeSend(peers[id], packet);
    }
  }

  // dispatch: where THIS client's own reply packets go - packetRouter.dispatch
  // for the host's own local player, or straight back over their data
  // channel for a peer.
  function handleOutgoingFor(clientId, entry, packet) {
    var clientRec  = entry ? entry.client  : hostClient;
    var accountRec = entry ? entry.account : hostAccount;
    var dispatch = entry ? function (p) { safeSend(entry, p); } : packetRouter.dispatch;

    switch (packet.type) {
      case 'join_red':       return setTeamFor(clientId, clientRec, accountRec, 'red', dispatch);
      case 'join_blue':      return setTeamFor(clientId, clientRec, accountRec, 'blue', dispatch);
      case 'join_spectator': return setTeamFor(clientId, clientRec, accountRec, 'spectator', dispatch);
      case 'join_game':      return joinGameFor(clientId, clientRec, accountRec);
      case 'leave_game': {
        var player = gi.gameState.getPlayer(clientId);
        if (!player) { dispatch({ type: 'error', message: 'not currently in the game' }); return; }
        gi.gameHelpers.removePlayer(clientId);
        dispatch({ type: 'leftGame' });
        return;
      }
      case 'input': {
        var p = gi.gameState.getPlayer(clientId);
        if (!p) return;
        p.left = !!packet.left; p.right = !!packet.right; p.up = !!packet.up; p.down = !!packet.down;
        recorder.recordInput(clientId, packet);
        return;
      }
      case 'ping': return dispatch({ type: 'pong', t: packet.t });
      case 'detonateBomb': {
        var pl = gi.gameState.getPlayer(clientId);
        if (!pl || pl.dead || pl.frozen || pl.matchFrozen) return;
        var affected = gi.gameHelpers.detonateRollingBomb(pl);
        if (affected) gi.emitter.emit('update', affected);
        return;
      }
      default: return;
    }
  }

  // client/game/app/actions.js's `socket` contract, for the HOST's own
  // local player - identical to localTransport.js's, just routed through
  // the generalized handleOutgoingFor(LOCAL_CLIENT_ID, ...) instead.
  var hostSocket = {
    send: function (packet) { handleOutgoingFor(LOCAL_CLIENT_ID, null, packet); return true; },
    connect: function () {},
    closeByUser: function () {},
    isOpen: function () { return true; },
    setSimulatedLatency: function () { return 0; },
    simulatedLatency: function () { return 0; },
  };

  async function bootAsHost(code) {
    roomCode = code; // already set + 'roomCode:ready' emitted by requestRoomCode() (see createGroup below)
    await connectSignal(code, 'host');
    globalThis.socket = hostSocket;

    var res    = await fetch('./assets/maps/default.json');
    var mapDoc = await res.json();

    gi = new GameInstance(gameConfig, 'game');
    recorder = createLocalReplayRecorder(gi);
    wireHostEngineEvents();
    gi.loadMap(mapDoc);

    var room = { instance: gi, kind: 'game', leaderId: LOCAL_CLIENT_ID };
    var joinedPacket = packetBuilders.joined(room, hostClient, hostAccount, mapDataFrom(gi.gameState));
    packetApplier.applyJoined(joinedPacket);

    gi.start();
    return gi;
  }

  // ---- PEER role -------------------------------------------------------

  function handleHostOffer(offer) {
    hostPc.setRemoteDescription(offer)
      .then(function () { return hostPc.createAnswer(); })
      .then(function (answer) { return hostPc.setLocalDescription(answer).then(function () { sendSignal(hostSignalId, answer); }); });
  }

  var peerSocket = {
    send: function (packet) {
      if (hostDc && hostDc.readyState === 'open') hostDc.send(JSON.stringify(packet));
      return true;
    },
    connect: function () {},
    closeByUser: function () {},
    isOpen: function () { return !!hostDc && hostDc.readyState === 'open'; },
    setSimulatedLatency: function () { return 0; },
    simulatedLatency: function () { return 0; },
  };

  function wirePeerDataChannel(dc, onJoined) {
    hostDc = dc;
    dc.addEventListener('message', function (event) {
      var packet = JSON.parse(event.data);
      if (!joinedApplied) {
        // First message from the host is always the 'joined' packet
        // (mirrors packetApplier's own header comment: applied directly,
        // not through packetRouter, same as the solo build's boot()).
        joinedApplied = true;
        packetApplier.applyJoined(packet);
        appEvents.emit('roomCode:ready', roomCode); // already known from the join-by-code UI, but keeps Teams tab consistent
        onJoined();
        return;
      }
      packetRouter.dispatch(packet);
    });
  }

  async function bootAsPeer(code) {
    roomCode = code;
    globalThis.socket = peerSocket;

    var welcome = await connectSignal(code, 'peer');
    // Known limitation: if a peer connects before anyone has ever claimed
    // the host role for this room code, this gives up immediately rather
    // than waiting/retrying for a host to show up later. Fine in practice
    // - "Join Group" only makes sense once someone has already created
    // the group and shared its code, and creating IS claiming host - but
    // worth knowing if this ever needs to support "share a code in
    // advance, host joins later."
    if (!welcome.hostId) throw new Error('no host has joined this room yet');
    hostSignalId = welcome.hostId;

    hostPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    hostPc.addEventListener('icecandidate', function (event) {
      if (event.candidate) sendSignal(hostSignalId, { candidate: event.candidate });
    });

    // Resolves once packetApplier.applyJoined has actually run (the data
    // channel the host creates fires 'datachannel' here once the
    // connection completes, and its first message is always 'joined') -
    // so the caller doesn't start the render/physics loops before there's
    // a map to render.
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { reject(new Error('timed out connecting to host')); }, 20000);
      hostPc.addEventListener('datachannel', function (event) {
        wirePeerDataChannel(event.channel, function () { clearTimeout(timeout); resolve(null); });
      });
    });
  }

  // ---- shared map switching (host only - matches localTransport.js) ------

  function switchMap(mapFile) {
    if (role !== 'host' || !gi) return Promise.reject(new Error('only the host can change the map'));
    return fetch('./assets/maps/' + mapFile)
      .then(function (res) { return res.json(); })
      .then(function (mapDoc) {
        gi.gameState.players.slice().forEach(function (p) { gi.gameHelpers.removePlayer(p.id); });
        gi.loadMap(mapDoc);
        hostClient.team = 'spectator';
        for (var id in peers) peers[id].client.team = 'spectator';
        var packet = Object.assign({ type: 'mapChanged' }, mapDataFrom(gi.gameState));
        packetRouter.dispatch(packet);
        broadcastToPeers(packet);
      });
  }

  return {
    createGroup: function () {
      return requestRoomCode().then(function (code) { return bootAsHost(code); });
    },
    joinGroup: function (code) { return bootAsPeer(code.toUpperCase()); },
    role: function () { return role; },
    localId: LOCAL_CLIENT_ID,
    getRoomCode: function () { return roomCode; },
    gameInstance: function () { return gi; }, // null for a peer - it never runs one
    matchState: function () { return gi ? gi.gameState.state : null; },
    switchMap: switchMap,
    workerUrl: WORKER_URL,
    peerCount: function () { return Object.keys(peers).filter(function (id) { return peers[id].ready; }).length; },
  };
})();
