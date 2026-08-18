// webrtcTransport.js - the P2P transport: host-authoritative, exactly the
// design localTransport.js's header comment already promised ("the seam a
// future webrtcTransport.js drops into unchanged for peer-to-peer play").
//
// Two roles, one file:
//   HOST - runs the real, authoritative GameInstance (same as
//     localTransport.js does for the solo build), for its own local
//     player AND every connected peer. Thin wrapper over
//     local/hostSession.js, which owns everything about running a
//     multi-client session (moderation, join/team, packet dispatch,
//     engine-event wiring, WebRTC peer connections) - identical to what
//     node-host/hostCli.js uses, just with a local client added. See
//     hostSession.js's own header for why this isn't hostCli-shaped or
//     browser-shaped, just session-shaped.
//   PEER - runs no GameInstance at all - just the same client rendering/
//     prediction pipeline (packetApplier/packetRouter/client physicsWorld)
//     the solo build's local player already uses, fed by packets arriving
//     over the data channel instead of from a local GameInstance. This
//     role is genuinely peer-specific (connecting TO someone else's host)
//     and has no shared-logic counterpart, so it stays entirely in this
//     file.
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
  var session = null; // HOST role only
  var roomCode = null;
  var role = null; // 'host' | 'peer'

  var LOCAL_CLIENT_ID = 1; // this tab's own local player, same convention as localTransport.js
  var hostClient  = { team: 'spectator', muted: false };
  var hostAccount = { display_name: 'Host', authed: false, flairIndex: null };

  // ---- PEER-only state -------------------------------------------------
  var myPeerId = null;
  var signalWs = null;
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

  function resolveMap(mapId) {
    return importFortunateMap(mapId).then(function (mapDoc) {
      return { mapDoc: mapDoc, mapMeta: { type: 'fortunatemaps', id: String(mapId) } };
    });
  }

  // ---- HOST role -----------------------------------------------------

  var hostSocket = {
    send: function (packet) { session.handleOutgoing(LOCAL_CLIENT_ID, packet); return true; },
    connect: function () {},
    closeByUser: function () {},
    isOpen: function () { return true; },
    setSimulatedLatency: function () { return 0; },
    simulatedLatency: function () { return 0; },
  };

  async function bootAsHost(code, password, identity) {
    role = 'host';
    roomCode = code; // already set + 'roomCode:ready' emitted by requestRoomCode() (see createGroup below)
    // Set directly rather than through the 'identify' round trip peers use -
    // there's no network hop for the host's own identity, but a claimed
    // TagPro token still goes through the same verifyToken check a peer's
    // would, rather than trusting localStorage unconditionally.
    if (identity && identity.name) hostAccount.display_name = identity.name;
    if (identity && (typeof identity.flairIndex === 'number' || identity.flairIndex === null)) {
      hostAccount.flairIndex = identity.flairIndex;
    }
    if (identity && identity.tagpro && identity.tagpro.token) {
      var valid = await TagproAuth.verifyToken(WORKER_URL, identity.tagpro);
      if (valid) { hostAccount.authed = true; hostAccount.display_name = identity.tagpro.reservedName; }
    }

    gi = new GameInstance(gameConfig, 'game');
    recorder = createLocalReplayRecorder(gi);
    session = HostSession.createHostSession(gi, {
      RTCPeerConnection: RTCPeerConnection,
      WebSocket: WebSocket,
      iceServers: ICE_SERVERS,
      workerUrl: WORKER_URL,
      signalUrl: SIGNAL_URL,
      recorder: recorder,
      localClient: { client: hostClient, account: hostAccount, dispatch: packetRouter.dispatch },
      getDeviceId: getDeviceId,
      resolveMap: resolveMap,
      onDuplicateDevice: function (respond) { appEvents.emit('duplicateDevice:ask', respond); },
      onMatchStateApplied: function (state) { appEvents.emit('matchStateApplied', state); },
      onReplayFinished: function (result, meta) {
        downloadBlob(result.blob, result.filename);
        persistRecording(result, meta);
      },
    });
    session.wireEngineEvents();
    globalThis.socket = hostSocket;

    await session.connectSignalAsHost(code, password, hostAccount.display_name);

    var res    = await fetch(GAME_BASE_PATH + 'assets/maps/default.json');
    var mapDoc = await res.json();
    gi.loadMap(mapDoc);

    var room = { instance: gi, kind: 'game', leaderId: LOCAL_CLIENT_ID };
    var joinedPacket = packetBuilders.joined(room, hostClient, hostAccount, HostSession.mapDataFrom(gi.gameState));
    packetApplier.applyJoined(joinedPacket);
    session.broadcastRoster();

    gi.start();
    session.startStalePeerCheck();
    return gi;
  }

  // ---- PEER role -------------------------------------------------------

  function sendSignal(toPeerId, data) {
    signalWs.send(JSON.stringify({ type: 'signal', to: toPeerId, data: data }));
  }

  function handleSignalMessage(fromPeerId, data) {
    // Only ever trust signals actually sent by the host - the signaling DO
    // relays a 'signal' message between any two connected peers, not just
    // peer<->host (see roomSignal.js's handleMessage), so without this
    // check another peer in the room could send a forged offer here and
    // corrupt this connection's negotiation state with the real host.
    if (!hostPc || fromPeerId !== hostSignalId) return;
    if (data.candidate) hostPc.addIceCandidate(data.candidate).catch(function () {});
    else if (data.type === 'offer') handleHostOffer(data);
  }

  function connectSignalAsPeer(code, password) {
    myPeerId = newPeerId();
    role = 'peer';
    var deviceId = getDeviceId();
    var url = SIGNAL_URL + code + '?peerId=' + myPeerId + '&role=peer'
      + (password ? '&password=' + encodeURIComponent(password) : '')
      + (deviceId ? '&deviceId=' + encodeURIComponent(deviceId) : '');
    signalWs = new WebSocket(url);

    var signalReady = new Promise(function (resolve, reject) {
      signalWs.addEventListener('message', function onMessage(event) {
        var msg = JSON.parse(event.data);
        if (msg.type === 'duplicate-device') {
          // Same browser already has a connection open in this room - pause
          // here and ask the UI (local/main.js's duplicate-tab modal) rather
          // than silently picking for the player. The DO holds this
          // connection open with no further messages until it gets a reply.
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
      // wrong password - 4002, or anything else).
      signalWs.addEventListener('close', function (event) {
        if (event.code !== 1000) reject(new Error(event.reason || 'signaling connection closed (code ' + event.code + ')'));
      });
      signalWs.addEventListener('error', function () { reject(new Error('signaling connection failed')); });
    });

    signalWs.addEventListener('message', function (event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'signal') handleSignalMessage(msg.from, msg.data);
      // peer-joined/peer-left: nothing to react to as a peer - only the
      // host tracks the room's connection roster.
    });

    return signalReady;
  }

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
        // it) - see hostSession.js's 'identify' case, host side.
        if (identity && (identity.name || identity.tagpro || typeof identity.flairIndex === 'number')) {
          dc.send(JSON.stringify({ type: 'identify', name: identity.name, tagpro: identity.tagpro, flairIndex: identity.flairIndex ?? null }));
        }
        onJoined();
        return;
      }
      packetRouter.dispatch(packet);
    });
    // Reuses the exact same "store a reason, reload to a clean mode-select"
    // path packetApplier.js's own 'kicked' handler already uses.
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
  // continuously (at minimum its own ~2s ping from client/net.js), so
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

    var welcome = await connectSignalAsPeer(code, password);
    // Known limitation: if a peer connects before anyone has ever claimed
    // the host role for this room code, this gives up immediately rather
    // than waiting/retrying for a host to show up later. Fine in practice
    // - "Join Group" only makes sense once someone has already created
    // the group and shared its code, and creating IS claiming host.
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

  // ---- shared map switching (host only) -----------------------------
  // mapId is a Fortunate Maps id (see local/fortunateMapsImport.js) - the
  // Settings tab's only way to pick a map now.

  function switchMap(mapId) {
    if (role !== 'host' || !gi) return Promise.reject(new Error('only the host can change the map'));
    return resolveMap(mapId).then(function (resolved) {
      session.switchMap(resolved.mapDoc, resolved.mapMeta);
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
    peerCount: function () { return session ? session.peerCount() : 0; },
  };
})();
