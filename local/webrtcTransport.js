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
  var WORKER_URL = 'https://api.bamball.workers.dev';
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
  var hostClient = { id: LOCAL_CLIENT_ID, team: 'spectator', muted: false };
  var hostAccount = { display_name: 'Host', authed: false };

  // ---- PEER-only state -------------------------------------------------
  var hostSignalId = null;
  var hostPc = null;
  var hostDc = null;
  var joinedApplied = false;
  var hostLastSeenMs = null; // backs startHostStaleCheck, below

  function newPeerId() {
    return 'p' + Math.random().toString(36).slice(2, 10);
  }

  // Stable per-BROWSER id (unlike peerId, which is fresh every connection) -
  // localStorage is shared across every tab of the same origin, so this is
  // how the signaling DO (worker/src/roomSignal.js) can tell "this is the
  // same browser opening a second tab into this group" apart from "this is
  // actually a different player" and prompt accordingly. Generated once,
  // reused forever after.
  var DEVICE_ID_KEY = 'bamball_device_id';
  function getDeviceId() {
    try {
      var id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    } catch (err) { return null; } // localStorage unavailable (private mode, etc.) - just skip duplicate-device detection
  }

  // ---- shared: room code + replay persistence (same as localTransport.js) ----

  function requestRoomCode() {
    return fetch(WORKER_URL + '/api/groups', { method: 'POST' })
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
  function connectSignal(code, wantRole, password, name) {
    myPeerId = newPeerId();
    role = wantRole;
    var deviceId = getDeviceId();
    var url = SIGNAL_URL + code + '?peerId=' + myPeerId + '&role=' + wantRole
      + (password ? '&password=' + encodeURIComponent(password) : '')
      + (name ? '&name=' + encodeURIComponent(name) : '') // host only - seeds roomDirectory.js's hostName, see bootAsHost
      + (deviceId ? '&deviceId=' + encodeURIComponent(deviceId) : '');
    signalWs = new WebSocket(url);

    signalReady = new Promise(function (resolve, reject) {
      signalWs.addEventListener('message', function onMessage(event) {
        var msg = JSON.parse(event.data);
        if (msg.type === 'duplicate-device') {
          // Same browser already has a connection open in this room (see
          // worker/src/roomSignal.js's header comment) - pause here and
          // ask the UI (local/main.js's duplicate-tab modal) rather than
          // silently picking for the player. The DO holds this connection
          // open with no further messages until it gets a reply.
          appEvents.emit('duplicateDevice:ask', function (choice) {
            signalWs.send(JSON.stringify({ type: 'resolve-duplicate', choice: choice }));
          });
          return;
        }
        if (msg.type === 'welcome') {
          signalWs.removeEventListener('message', onMessage);
          resolve(msg);
        }
      });
      // Any abnormal close before 'welcome' ever arrives means the DO
      // rejected the connection outright (room already has a host - 4001,
      // wrong password - 4002, or anything else) - generalized rather than
      // matching specific codes one at a time, so a new rejection reason
      // added to roomSignal.js later doesn't also need a matching update
      // here to actually surface instead of hanging silently.
      signalWs.addEventListener('close', function (event) {
        if (event.code !== 1000) reject(new Error(event.reason || 'signaling connection closed (code ' + event.code + ')'));
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
      // Only ever trust signals actually sent by the host - the signaling
      // DO relays a 'signal' message between any two connected peers, not
      // just peer<->host (see roomSignal.js's handleMessage), so without
      // this check another peer in the room could send a forged offer here
      // and corrupt this connection's negotiation state with the real host.
      if (!hostPc || fromPeerId !== hostSignalId) return;
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
    broadcastRoster();
  }

  // ---- host moderation: kick/mute/ban + leader promotion ------------------
  //
  // Two roles above plain player, both host-only concepts (never touch
  // gameState - "leader" here is who gets to call these functions, not
  // anything the engine or other players' physics prediction needs to know):
  //   MAIN LEADER - always LOCAL_CLIENT_ID (whoever is hosting this room).
  //     Every permission below, permanently, and can't be kicked/banned/
  //     muted/demoted by anyone (see the LOCAL_CLIENT_ID guards in
  //     handleOutgoingFor's kick_player/ban_player/mute_player/
  //     demote_leader cases) - the alternative (a promoted leader locking
  //     the actual host out of their own room) is worse than the
  //     restriction.
  //   LEADER - zero or more players the main leader (or another leader)
  //     promoted. Identical powers to the main leader (isLeader() below
  //     doesn't distinguish them) EXCEPT demoting: only the mainLeader flag
  //     (see buildRoster) is exempt from demote_leader, so a leader can
  //     promote/demote other leaders freely but never touches the host.
  //
  // Finer-grained, per-permission control (e.g. a leader who can mute but
  // not kick) isn't modeled here on purpose - that level of tuning is a CLI
  // concern (node-host/hostCli.js's REPL, run by whoever has terminal
  // access to the process), not a live in-browser one.

  function findPeerEntry(clientId) {
    for (var id in peers) {
      if (peers[id].clientId === clientId) return { peerId: id, entry: peers[id] };
    }
    return null;
  }

  function isLeader(clientId) {
    if (clientId === LOCAL_CLIENT_ID) return true;
    var found = findPeerEntry(clientId);
    return !!(found && found.entry.client.leader);
  }

  // Everyone currently connected, host included - see engine/packetBuilders.js's
  // roomState for the wire shape. This is the only place a peer who's still
  // spectating (never spawned, so absent from gi.gameState.players) shows up
  // to anyone at all, which is why leader promotion has to read from here
  // rather than the game roster.
  function buildRoster() {
    var list = [{
      id: LOCAL_CLIENT_ID, name: hostAccount.display_name, team: hostClient.team,
      inGame: !!gi.gameState.getPlayer(LOCAL_CLIENT_ID),
      leader: true, mainLeader: true, muted: !!hostClient.muted, authed: !!hostAccount.authed,
    }];
    for (var id in peers) {
      var entry = peers[id];
      if (!entry.ready) continue;
      list.push({
        id: entry.clientId, name: entry.account.display_name, team: entry.client.team,
        inGame: !!gi.gameState.getPlayer(entry.clientId),
        leader: !!entry.client.leader, mainLeader: false,
        muted: !!entry.client.muted, authed: !!entry.account.authed,
      });
    }
    return list;
  }

  function broadcastRoster() {
    if (!gi) return; // called from handlePeerLeft before bootAsHost finishes in principle - guard, not expected in practice
    var packet = packetBuilders.roomState(buildRoster());
    packetRouter.dispatch(packet);
    broadcastToPeers(packet);
  }

  function kickClient(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return;
    var peerId = found.peerId;
    safeSend(found.entry, { type: 'kicked', message: 'You have been kicked from this room.' });
    // A brief delay, not an immediate close - closing an RTCPeerConnection
    // right after send() risks the message never actually flushing to the
    // wire before the local side tears down, which would leave the kicked
    // player's screen just silently frozen instead of explaining why.
    setTimeout(function () { handlePeerLeft(peerId); }, 300);
  }

  function setMuted(clientId, muted) {
    if (clientId === LOCAL_CLIENT_ID) { hostClient.muted = !!muted; } else {
      var found = findPeerEntry(clientId);
      if (found) found.entry.client.muted = !!muted;
    }
    broadcastRoster();
  }

  // Same disconnect as kickClient, plus telling the signaling DO (over the
  // already-open signalWs, not a new HTTP call) to remember this peer's IP
  // so they can't just reconnect with a fresh peerId - see
  // worker/src/roomSignal.js's handleMessage for the 'ban' case and why
  // this is IP-based rather than peerId-based.
  function banClient(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return;
    var peerId = found.peerId;
    safeSend(found.entry, { type: 'kicked', message: 'You have been banned from this room.' });
    signalWs.send(JSON.stringify({ type: 'ban', peerId: peerId }));
    setTimeout(function () { handlePeerLeft(peerId); }, 300);
  }

  function promoteToLeader(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return;
    found.entry.client.leader = true;
    broadcastRoster();
  }

  // The main leader (LOCAL_CLIENT_ID) is never a peer entry, so this is
  // naturally a no-op against them - callers still check explicitly
  // (handleOutgoingFor) so a demote attempt gets a real error reply instead
  // of silently doing nothing.
  function demoteFromLeader(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return;
    found.entry.client.leader = false;
    broadcastRoster();
  }

  // ---- HOST role -----------------------------------------------------

  function handlePeerJoined(peerId) {
    var clientId = nextClientId++;
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // lastSeenMs backs the stale-connection sweep (see startStalePeerCheck)
    // - a WebRTC data channel has no reliable prompt "the other end is
    // gone" signal the way a clean close does; on a real network drop
    // (not a clean tab close) the browser's own failure detection can take
    // a long time, leaving a "ghost" player that looks connected but isn't.
    // Set at creation (not left undefined) so a peer that never finishes
    // connecting at all still ages out via the same sweep.
    var entry = { pc: pc, dc: null, clientId: clientId, client: { id: clientId, team: 'spectator', muted: false, leader: false }, account: { display_name: 'Player ' + clientId, authed: false }, ready: false, lastSeenMs: Date.now() };
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
      broadcastRoster();
    });
    entry.dc.addEventListener('message', function (event) {
      entry.lastSeenMs = Date.now();
      var packet = JSON.parse(event.data);
      handleOutgoingFor(entry.clientId, entry, packet);
    });
    entry.dc.addEventListener('close', function () { handlePeerLeft(peerId); });
  }

  // Every ready peer already sends a 'ping' every couple of seconds
  // (client/ui/hud.js's own RTT probe) even with no player input at all,
  // so "anything at all heard recently" is a reliable liveness signal, not
  // just an approximation. STALE_TIMEOUT_MS is generous versus that ~2s
  // cadence (a few missed beats, not a hair trigger) so a slow tick or one
  // dropped packet doesn't falsely kick someone.
  var STALE_TIMEOUT_MS = 10000;
  var STALE_CHECK_INTERVAL_MS = 3000;

  function startStalePeerCheck() {
    setInterval(function () {
      var now = Date.now();
      for (var id in peers) {
        var entry = peers[id];
        if (entry.ready && now - entry.lastSeenMs > STALE_TIMEOUT_MS) {
          console.warn('[webrtcTransport] peer ' + id + ' (clientId ' + entry.clientId + ') timed out - no message in ' + STALE_TIMEOUT_MS + 'ms');
          if (entry.pc) entry.pc.close();
          handlePeerLeft(id);
        }
      }
    }, STALE_CHECK_INTERVAL_MS);
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
    saveStatesChanged:     packetBuilders.saveStatesChanged,
    overlayStroke:         packetBuilders.overlayStroke,
    overlayUndo:           packetBuilders.overlayUndo,
    overlayClear:          packetBuilders.overlayClear,
    matchEnd:               packetBuilders.matchEnd,
    powerupPreview:        packetBuilders.powerupPreview,
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

    gi.emitter.on('snapshot', function (deltas, immediate) {
      var localDelta = deltas.get(LOCAL_CLIENT_ID);
      if (localDelta) packetRouter.dispatch(packetBuilders.snapshot(localDelta, immediate));
      for (var id in peers) {
        var entry = peers[id];
        var delta = deltas.get(entry.clientId);
        if (delta) safeSend(entry, packetBuilders.snapshot(delta, immediate));
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
    broadcastRoster();

    if (team === previousTeam) return;
    var player = gi.gameState.getPlayer(clientId);
    if (player) {
      gi.gameHelpers.removePlayer(clientId);
      dispatch({ type: 'leftGame' });
      if (team === 'red' || team === 'blue') {
        var respawned = gi.gameHelpers.spawnPlayer(clientId, team, accountRec.display_name, accountRec.authed);
        dispatch({ type: 'joinedGame', player: serializePlayer(respawned) });
      }
      broadcastRoster();
    }
  }

  function joinGameFor(clientId, clientRec, accountRec) {
    if (gi.gameState.getPlayer(clientId)) return;
    if (clientRec.team !== 'red' && clientRec.team !== 'blue') return;
    var player = gi.gameHelpers.spawnPlayer(clientId, clientRec.team, accountRec.display_name, accountRec.authed);
    var packet = { type: 'joinedGame', player: serializePlayer(player) };
    if (clientId === LOCAL_CLIENT_ID) packetRouter.dispatch(packet);
    else broadcastToOne(clientId, packet);
    broadcastRoster();
    if (gi.gameState.state === 'pregame') gi.matchManager.startMatch();
  }

  function broadcastToOne(clientId, packet) {
    for (var id in peers) {
      if (peers[id].clientId === clientId) safeSend(peers[id], packet);
    }
  }

  // A browser can't safely hold AUTH_SECRET itself, so a peer's
  // self-reported TagPro token has to be checked against the Worker (which
  // does hold it) before the host trusts `authed: true` for them - see
  // worker/src/tagproAuth.js's handleVerifyToken. Reused for the host's
  // own identity too (see createGroup, below) rather than trusting
  // localStorage unconditionally, in case it's ever tampered with.
  // TagproAuth (local/tagproAuthLib.js) is the portable drop-in client for
  // this - shared here rather than duplicated so the verify logic only
  // exists in one place.
  function verifyTagproToken(tagpro) {
    return TagproAuth.verifyToken(WORKER_URL, tagpro);
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
      case 'chat': {
        if (clientRec.muted) { dispatch({ type: 'error', message: 'You are muted in this room.' }); return; }
        var text = typeof packet.text === 'string' ? packet.text.trim().slice(0, 240) : '';
        if (!text) return;
        var chatPacket = packetBuilders.chat({ id: clientId, name: accountRec.display_name, text: text });
        packetRouter.dispatch(chatPacket);
        recorder.recordBroadcast(chatPacket);
        broadcastToPeers(chatPacket);
        return;
      }
      // A peer's one-time self-introduction, sent right after they apply
      // the 'joined' packet (see wirePeerDataChannel) - a freely-chosen
      // display name applies immediately; a claimed TagPro identity only
      // takes effect once verifyTagproToken confirms it (async - if the
      // player's already spawned by the time it resolves, poke their live
      // player object directly so the roster's green name isn't stuck
      // waiting for their next team change to show it).
      case 'identify': {
        if (typeof packet.name === 'string' && packet.name.trim()) {
          accountRec.display_name = packet.name.trim().slice(0, 20);
        }
        broadcastRoster();
        if (packet.tagpro && packet.tagpro.token) {
          verifyTagproToken(packet.tagpro).then(function (valid) {
            if (!valid) return;
            accountRec.authed = true;
            accountRec.display_name = packet.tagpro.reservedName;
            var p = gi.gameState.getPlayer(clientId);
            if (p) { p.authed = true; gi.emitter.emit('update', p); }
            broadcastRoster();
          });
        }
        return;
      }

      // ---- leader-gated moderation + match control -------------------
      // Every case below requires isLeader(clientId) - the sender, not the
      // target. A rejected attempt gets a real 'error' reply rather than a
      // silent drop, same as every other guarded case above (e.g. 'chat'
      // while muted) - the requester's own UI can then surface it instead
      // of just looking like the button did nothing.
      case 'kick_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can kick players' }); return; }
        if (packet.targetId === LOCAL_CLIENT_ID) { dispatch({ type: 'error', message: 'cannot kick the main leader' }); return; }
        kickClient(packet.targetId);
        return;
      }
      case 'ban_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can ban players' }); return; }
        if (packet.targetId === LOCAL_CLIENT_ID) { dispatch({ type: 'error', message: 'cannot ban the main leader' }); return; }
        banClient(packet.targetId);
        return;
      }
      case 'mute_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can mute players' }); return; }
        if (packet.targetId === LOCAL_CLIENT_ID) { dispatch({ type: 'error', message: 'cannot mute the main leader' }); return; }
        setMuted(packet.targetId, !!packet.muted);
        return;
      }
      case 'promote_leader': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can promote players' }); return; }
        promoteToLeader(packet.targetId);
        return;
      }
      case 'demote_leader': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can demote players' }); return; }
        if (packet.targetId === LOCAL_CLIENT_ID) { dispatch({ type: 'error', message: 'the main leader cannot be demoted' }); return; }
        demoteFromLeader(packet.targetId);
        return;
      }
      case 'start_match': {
        if (!isLeader(clientId)) return;
        gi.matchManager.startMatch();
        return;
      }
      case 'pause_match': {
        if (!isLeader(clientId)) return;
        gi.matchManager.pauseMatch();
        return;
      }
      case 'resume_match': {
        if (!isLeader(clientId)) return;
        gi.matchManager.resumeMatch();
        return;
      }
      case 'reset_game': {
        if (!isLeader(clientId)) return;
        gi.matchManager.resetMatch();
        return;
      }
      case 'end_match': {
        if (!isLeader(clientId)) return;
        gi.matchManager.endMatch('leaderEnded');
        return;
      }

      // ---- leader-gated settings edits --------------------------------
      // Each of these calls into matchManager, which mutates config/
      // gameState directly and emits its own 'physicsChanged' /
      // 'matchStateChanged' / etc - wireHostEngineEvents' EVENT_MAP already
      // turns those into broadcasts, so nothing here sends a packet itself.
      case 'update_physics': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change physics settings' }); return; }
        gi.matchManager.updatePhysics(packet.settings);
        return;
      }
      case 'update_player_physics': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change player settings' }); return; }
        var targetPlayer = gi.gameState.getPlayer(packet.targetId);
        if (!targetPlayer) return;
        gi.matchManager.updatePlayerPhysics(targetPlayer, packet.settings);
        return;
      }
      case 'update_settings': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change match settings' }); return; }
        gi.matchManager.updateSettings(packet.settings);
        return;
      }
      case 'update_tile_settings': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change tile settings' }); return; }
        gi.matchManager.updateTileSettings(packet.x, packet.y, packet.settings);
        return;
      }
      case 'changeMap': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change the map' }); return; }
        switchMap(packet.mapId).catch(function (err) {
          dispatch({ type: 'error', message: 'could not load map: ' + err.message });
        });
        return;
      }
      case 'save_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can save game states' }); return; }
        gi.matchManager.captureSaveState(packet.name);
        return;
      }
      case 'load_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can load game states' }); return; }
        if (!gi.matchManager.restoreSaveState(packet.name)) dispatch({ type: 'error', message: 'no save state named "' + packet.name + '"' });
        return;
      }
      case 'delete_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can delete game states' }); return; }
        gi.matchManager.deleteSaveState(packet.name);
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

  async function bootAsHost(code, password, identity) {
    roomCode = code; // already set + 'roomCode:ready' emitted by requestRoomCode() (see createGroup below)
    // Set directly rather than through the 'identify' round trip peers use
    // (handleOutgoingFor) - there's no network hop for the host's own
    // identity, but a claimed TagPro token still goes through the same
    // verifyTagproToken check a peer's would, rather than trusting
    // localStorage unconditionally.
    if (identity && identity.name) hostAccount.display_name = identity.name;
    if (identity && identity.tagpro && identity.tagpro.token) {
      var valid = await verifyTagproToken(identity.tagpro);
      if (valid) { hostAccount.authed = true; hostAccount.display_name = identity.tagpro.reservedName; }
    }
    await connectSignal(code, 'host', password, hostAccount.display_name);
    globalThis.socket = hostSocket;

    var res    = await fetch(GAME_BASE_PATH + 'assets/maps/default.json');
    var mapDoc = await res.json();

    gi = new GameInstance(gameConfig, 'game');
    recorder = createLocalReplayRecorder(gi);
    wireHostEngineEvents();
    gi.loadMap(mapDoc);

    var room = { instance: gi, kind: 'game', leaderId: LOCAL_CLIENT_ID };
    var joinedPacket = packetBuilders.joined(room, hostClient, hostAccount, mapDataFrom(gi.gameState));
    packetApplier.applyJoined(joinedPacket);
    broadcastRoster();

    gi.start();
    startStalePeerCheck();
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

  function wirePeerDataChannel(dc, onJoined, identity) {
    hostDc = dc;
    hostLastSeenMs = Date.now();
    dc.addEventListener('message', function (event) {
      hostLastSeenMs = Date.now();
      var packet = JSON.parse(event.data);
      if (!joinedApplied) {
        // First message from the host is always the 'joined' packet
        // (mirrors packetApplier's own header comment: applied directly,
        // not through packetRouter, same as the solo build's boot()).
        joinedApplied = true;
        packetApplier.applyJoined(packet);
        appEvents.emit('roomCode:ready', roomCode); // already known from the join-by-code UI, but keeps Teams tab consistent
        // This peer's one-time self-introduction, now that the channel is
        // definitely open (we just received the host's first message on
        // it) - see handleOutgoingFor's 'identify' case, host side.
        if (identity && (identity.name || identity.tagpro)) {
          dc.send(JSON.stringify({ type: 'identify', name: identity.name, tagpro: identity.tagpro }));
        }
        onJoined();
        return;
      }
      packetRouter.dispatch(packet);
    });
    // Previously missing entirely: nothing here ever reacted to the host
    // vanishing, so a peer whose host disconnected just silently froze -
    // no error, no way back except manually reloading. Reuses the exact
    // same "store a reason, reload to a clean mode-select" path
    // packetApplier.js's own 'kicked' handler already uses.
    dc.addEventListener('close', function () { handleHostLost(); });
    dc.addEventListener('error', function () { handleHostLost(); });
    startHostStaleCheck();
  }

  function handleHostLost() {
    try { sessionStorage.setItem('bamball_kicked_reason', 'Lost connection to the host.'); } catch (err) {}
    location.reload();
  }

  // Backup for handleHostLost's close/error listeners above: a WebRTC data
  // channel has no reliable prompt failure signal on a real network drop
  // (not a clean close) - the browser's own detection can take a long
  // time. The host already sends this peer a snapshot/message stream
  // continuously (at minimum its own ~2s ping from client/ui/hud.js), so
  // "nothing heard in a while" is a reliable enough signal to act on
  // sooner than waiting for the connection to formally fail.
  var HOST_STALE_TIMEOUT_MS = 10000;
  var hostStaleCheckStarted = false;
  function startHostStaleCheck() {
    if (hostStaleCheckStarted) return; // wirePeerDataChannel could in principle run more than once
    hostStaleCheckStarted = true;
    setInterval(function () {
      if (hostLastSeenMs !== null && Date.now() - hostLastSeenMs > HOST_STALE_TIMEOUT_MS) {
        handleHostLost();
      }
    }, 3000);
  }

  async function bootAsPeer(code, password, identity) {
    roomCode = code;
    globalThis.socket = peerSocket;

    var welcome = await connectSignal(code, 'peer', password);
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
        wirePeerDataChannel(event.channel, function () { clearTimeout(timeout); resolve(null); }, identity);
      });
    });
  }

  // ---- shared map switching (host only - matches localTransport.js) ------

  function switchMap(mapFile) {
    if (role !== 'host' || !gi) return Promise.reject(new Error('only the host can change the map'));
    return fetch(GAME_BASE_PATH + 'assets/maps/' + mapFile)
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
    createGroup: function (password, identity) {
      return requestRoomCode().then(function (code) { return bootAsHost(code, password, identity); });
    },
    joinGroup: function (code, password, identity) { return bootAsPeer(code.toUpperCase(), password, identity); },
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
