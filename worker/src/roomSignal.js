// roomSignal.js - WebRTC signaling relay, one Durable Object instance per
// room code (env.ROOM_SIGNAL.idFromName(code) in index.js). This is the one
// part of P2P that genuinely can't be a plain stateless Worker fetch: SDP
// offer/answer and ICE candidates trickle in over several seconds from
// multiple peers who all need to reach each other, so something has to
// hold live state and push messages, not just answer one request at a
// time. No game state ever passes through here - once a peer's data
// channel to the host is open, gameplay traffic goes directly between
// them; this only exists to get that connection established in the first
// place.
//
// Host-authoritative, not full mesh (matches the rest of this project's
// design): every non-host peer only ever needs ONE WebRTC connection - to
// the host - so this relay only needs to get each (peer, host) pair
// talking, not every pair of peers.
//
// Protocol (JSON text frames over one WebSocket per connected peer):
//   client -> DO   { type: 'signal', to: <peerId>, data: <SDP/ICE payload> }
//   client -> DO   { type: 'ban', peerId: <peerId> } - host-only (silently
//                    ignored from anyone else), see handleMessage
//   client -> DO   { type: 'resolve-duplicate', choice: 'guest'|'replace' }
//                    - reply to a duplicate-device prompt, see below
//   DO -> client   { type: 'duplicate-device' } - sent instead of 'welcome'
//                    when this connection's ?deviceId= matches one already
//                    connected to this room (the same browser opening a
//                    second tab) - the new connection stays paused (no
//                    'welcome', no further messages) until it replies with
//                    resolve-duplicate. 'guest' just proceeds normally,
//                    leaving both connected; 'replace' closes the OLDER
//                    connection first (its own 'peer-left'/cleanup fires
//                    from that close, same as any other disconnect) and
//                    then proceeds. Defaults to 'guest' after 15s if the
//                    client never answers, rather than hanging forever.
//   DO -> client   { type: 'welcome', peerId, hostId, peers: [id, ...] }
//   DO -> client   { type: 'peer-joined', peerId }
//   DO -> client   { type: 'peer-left', peerId }
//   DO -> client   { type: 'signal', from: <peerId>, data: <...> }
//
// The DO never inspects `data` - it's an opaque relay for whatever the
// WebRTC API on either end produces (RTCSessionDescriptionInit /
// RTCIceCandidateInit), so this file has zero WebRTC-specific logic and
// never needs to change if that shape does.
//
// Also tells roomDirectory.js's singleton DO about this room's lifecycle
// (register on host claim, update on join/leave, deregister on host
// disconnect) so the homepage's open-rooms list stays live - see
// notifyDirectory, below.

// SHA-256 hex digest via Web Crypto (available in Workers, no dependency) -
// plenty for a casual room password (not an account credential, no need
// for bcrypt-grade slow hashing). Passwords never touch storage in plain
// text, only this digest of them.
async function sha256Hex(text) {
  var bytes = new TextEncoder().encode(text);
  var digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// Pauses a new connection that shares a deviceId with one still connected
// to this room, asking the CLIENT (not assuming) how to resolve it - see
// this file's own header comment for the message shapes. Defaults to
// 'guest' if the client never answers (15s), rather than leaving the
// connection hanging forever on a client that doesn't understand the
// message (or a non-browser caller, like node-host, which never sends a
// deviceId in the first place and so never reaches this at all).
function waitForDuplicateResolution(ws) {
  return new Promise(function (resolve) {
    var done = false;
    var timeout = setTimeout(function () { finish('guest'); }, 15000);
    function finish(choice) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      ws.removeEventListener('message', onMessage);
      resolve(choice);
    }
    function onMessage(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === 'resolve-duplicate' && (msg.choice === 'guest' || msg.choice === 'replace')) finish(msg.choice);
    }
    ws.addEventListener('message', onMessage);
    try { ws.send(JSON.stringify({ type: 'duplicate-device' })); } catch (e) { finish('guest'); }
  });
}

export class RoomSignal {
  constructor(state, env) {
    this.state = state;
    this.env = env; // for talking to RoomDirectory (roomDirectory.js) - never used for anything else
    this.sockets = new Map(); // peerId -> WebSocket
    // In-memory only, not persisted - only needed to resolve a host's ban
    // request ("ban whoever peerId X is") to the IP that request actually
    // has to act on, for as long as that peerId is still connected. A ban
    // is always issued against someone currently in the room (see the
    // Ban button in local/menu.js, which only exists for players the host
    // can currently see), so there's no case that needs this to survive a
    // hibernation cycle the way bannedIps itself (in storage) does.
    this.ipsByPeerId = new Map();
    // deviceId -> peerId (currently connected) and its reverse, so a
    // browser opening a second tab into the same group can be detected -
    // see waitForDuplicateResolution and the duplicate-device handling in
    // handleSession. In-memory only, same lifetime as sockets/ipsByPeerId -
    // meaningless without a live connection to match against.
    this.peerIdByDevice = new Map();
    this.deviceByPeerId = new Map();
  }

  async fetch(request) {
    var url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }

    var peerId = url.searchParams.get('peerId');
    if (!peerId || !/^[A-Za-z0-9_-]{1,64}$/.test(peerId)) {
      return new Response('missing or invalid peerId', { status: 400 });
    }
    if (this.sockets.has(peerId)) {
      return new Response('peerId already connected in this room', { status: 409 });
    }

    // Explicit, not inferred from arrival order: the client that clicked
    // "Create Group" knows it wants to be host and says so directly
    // (?role=host). Letting "whichever WebSocket happens to finish its
    // handshake first" decide instead is a real race - verified live: in
    // testing, a peer connection created 500ms AFTER the intended host's
    // still won host status, purely from network/cold-start timing having
    // nothing to do with who actually clicked "create."
    var role = url.searchParams.get('role') === 'host' ? 'host' : 'peer';
    var password = url.searchParams.get('password') || '';
    var hostName = url.searchParams.get('name') || 'Host'; // only meaningful for role=host, see handleSession
    var ip = request.headers.get('CF-Connecting-IP') || '';
    // Optional - node-host (no browser, no localStorage) never sends one,
    // which is fine: the duplicate-device check below just never triggers
    // for it. A malformed value is treated the same as absent rather than
    // rejecting the connection over it.
    var deviceId = url.searchParams.get('deviceId') || null;
    if (deviceId && !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) deviceId = null;

    // This DO is never told its own room code any other way - index.js
    // forwards the original /api/signal/:code request unchanged, so it's
    // still right there in the URL this fetch() itself received. Cached on
    // the instance (not just this call) since handleClose, later, needs it
    // too for the same reason. Uppercased to match what index.js already
    // used to resolve this DO instance's id (idFromName(code.toUpperCase()))
    // - every normal client always sends an uppercase code already (room
    // codes are minted uppercase, and joinGroup() uppercases whatever's
    // typed in), but without this, a hand-crafted lowercase request could
    // still land on this same instance and overwrite this.roomCode with a
    // differently-cased value than an earlier connection registered with
    // roomDirectory.js under, desyncing later update/deregister calls from
    // that original registration.
    var codeMatch = url.pathname.match(/\/api\/signal\/([A-Za-z0-9]+)/);
    this.roomCode = codeMatch ? codeMatch[1].toUpperCase() : null;

    // Deliberately NOT awaited: a WebSocketPair's server side only actually
    // starts exchanging messages with the real client once this fetch()
    // call returns the 101 Response below - verified live, the hard way.
    // handleSession's duplicate-device path needs to receive a reply
    // message on this exact socket (waitForDuplicateResolution) before it
    // can finish, so awaiting it here would deadlock: fetch() can't return
    // until handleSession finishes, handleSession can't finish until it
    // gets a message, and that message can never arrive because fetch()
    // hasn't returned yet. Every send/receive handleSession does still
    // works fine happening after this return - accept() and the listener
    // registrations inside it all run synchronously before handleSession
    // hits its first await, well before control gets back here.
    var pair = new WebSocketPair();
    var client = pair[0];
    var server = pair[1];
    this.handleSession(server, peerId, role, password, ip, hostName, deviceId).catch(function (err) {
      try { server.close(1011, 'internal error'); } catch (e) {}
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Best-effort, fire-and-forget: the open-rooms homepage list
  // (roomDirectory.js) is a nice-to-have, and must never be able to break
  // or delay the actual signaling this DO exists for - if ROOM_DIRECTORY
  // isn't bound yet (e.g. mid-deploy) or the call fails for any reason,
  // signaling carries on exactly as if this never happened.
  notifyDirectory(path, body) {
    if (!this.env.ROOM_DIRECTORY) return;
    var id = this.env.ROOM_DIRECTORY.idFromName('global');
    var stub = this.env.ROOM_DIRECTORY.get(id);
    stub.fetch('https://internal/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function () {});
  }

  // hostId is null until someone actually claims it with ?role=host -
  // peers who connect first just wait (told hostId: null in 'welcome',
  // and 'host-assigned' once one shows up) rather than one of them being
  // silently drafted into the role. Persisted so it survives this DO
  // hibernating between messages; cleared on the host's disconnect (see
  // handleClose) so a stale, unreachable hostId never lingers.
  //
  // passwordHash: undefined until the room's very first host claim, which
  // is the one moment that decides it (whoever creates a room sets its
  // password, or leaves it empty for none) - stored as null rather than
  // never-set once decided, so "no password" and "not decided yet" stay
  // distinguishable. Every connection after that first claim - another
  // peer, or a second host claim once the original host has left - has to
  // present a password that hashes to the same value.
  //
  // Gated on hostEverClaimed, NOT on "is hostId currently unset" - those
  // sound the same but aren't: hostId is cleared on every host disconnect
  // (see handleClose), including an ordinary WiFi blip or a backgrounded
  // tab, which happens constantly to an otherwise-still-live room. Gating
  // on hostId alone (an earlier version of this code did) meant that
  // exact moment let ANY subsequent role=host claimant - not the original
  // host - get treated as a fresh first claim and silently overwrite
  // passwordHash, including clearing it to no-password. hostEverClaimed
  // is set once, on the room's actual first claim, and never cleared, so
  // a later reclaim after a disconnect always falls through to the normal
  // "present the existing password" check below instead.
  async handleSession(ws, peerId, role, password, ip, hostName, deviceId) {
    ws.accept();
    this.sockets.set(peerId, ws);
    this.ipsByPeerId.set(peerId, ip);

    // IP-based, not peerId-based: peerId is a fresh random value the client
    // mints on every connection (webrtcTransport.js's newPeerId()), so a
    // ban keyed to it would be trivially bypassed by just reconnecting.
    // Shared IPs/VPNs make this an imperfect, not security-grade, tool -
    // fine for a hobby game's moderation, not meant to be airtight.
    var bannedIps = (await this.state.storage.get('bannedIps')) || [];
    if (ip && bannedIps.indexOf(ip) !== -1) {
      ws.close(4003, 'banned from this room');
      this.sockets.delete(peerId);
      return;
    }

    var hostId = await this.state.storage.get('hostId');
    if (role === 'host' && hostId && this.sockets.has(hostId) && hostId !== peerId) {
      ws.close(4001, 'room already has a host');
      this.sockets.delete(peerId);
      return;
    }

    var passwordHash = await this.state.storage.get('passwordHash');
    var hostEverClaimed = await this.state.storage.get('hostEverClaimed');
    var isFirstHostClaim = role === 'host' && !hostEverClaimed;
    if (isFirstHostClaim) {
      passwordHash = password ? await sha256Hex(password) : null;
      await this.state.storage.put('passwordHash', passwordHash);
      await this.state.storage.put('hostEverClaimed', true);
    } else if (passwordHash) {
      var suppliedHash = await sha256Hex(password);
      if (suppliedHash !== passwordHash) {
        ws.close(4002, 'wrong password');
        this.sockets.delete(peerId);
        return;
      }
    }

    // Same browser already has a connection open in this room (a second
    // tab, most often) - pause and let the CLIENT decide how to resolve
    // it rather than silently allowing or silently blocking. See this
    // file's header comment for the message shapes and
    // waitForDuplicateResolution for the timeout/default. Deliberately
    // sits after the password/ban checks above (so a wrong password is
    // rejected outright, never reaching a prompt) and before hostId/
    // welcome below (so 'replace' can freely close the old connection
    // first without it having already been counted anywhere).
    if (deviceId) {
      var existingPeerId = this.peerIdByDevice.get(deviceId);
      if (existingPeerId && existingPeerId !== peerId && this.sockets.has(existingPeerId)) {
        var choice = await waitForDuplicateResolution(ws);
        if (choice === 'replace') {
          var oldWs = this.sockets.get(existingPeerId);
          if (oldWs) oldWs.close(4005, 'replaced by a new tab');
        }
        // 'guest' (or a timeout defaulting to it): just fall through and
        // proceed normally, leaving both connections in place.
      }
      this.peerIdByDevice.set(deviceId, peerId);
      this.deviceByPeerId.set(peerId, deviceId);
    }

    if (role === 'host') {
      hostId = peerId;
      await this.state.storage.put('hostId', hostId);
      this.broadcast({ type: 'host-assigned', hostId: hostId }, peerId);
      this.notifyDirectory('register', { code: this.roomCode, hostName: hostName, hasPassword: !!passwordHash });
    }

    var peers = Array.from(this.sockets.keys()).filter(function (id) { return id !== peerId; });
    this.send(ws, { type: 'welcome', peerId: peerId, hostId: hostId || null, peers: peers });
    this.broadcast({ type: 'peer-joined', peerId: peerId }, peerId);
    this.notifyDirectory('update', { code: this.roomCode, playerCount: this.sockets.size });

    var self = this;
    ws.addEventListener('message', function (event) {
      self.handleMessage(peerId, event.data);
    });
    ws.addEventListener('close', function () { self.handleClose(peerId); });
    ws.addEventListener('error', function () { self.handleClose(peerId); });
  }

  async handleMessage(fromId, raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'signal' && typeof msg.to === 'string') {
      var target = this.sockets.get(msg.to);
      if (!target) return; // target already disconnected - sender will time out and retry via its own logic
      this.send(target, { type: 'signal', from: fromId, data: msg.data });
      return;
    }

    if (msg.type === 'ban' && typeof msg.peerId === 'string') {
      var hostId = await this.state.storage.get('hostId');
      if (fromId !== hostId) return; // only the room's current host may ban

      var ip = this.ipsByPeerId.get(msg.peerId);
      if (ip) {
        var bannedIps = (await this.state.storage.get('bannedIps')) || [];
        if (bannedIps.indexOf(ip) === -1) {
          bannedIps.push(ip);
          await this.state.storage.put('bannedIps', bannedIps);
        }
      }
      var targetWs = this.sockets.get(msg.peerId);
      if (targetWs) targetWs.close(4003, 'banned from this room');
      return;
    }
  }

  async handleClose(peerId) {
    if (!this.sockets.has(peerId)) return; // already handled (close+error can both fire)
    this.sockets.delete(peerId);
    this.ipsByPeerId.delete(peerId);
    // Only clear peerIdByDevice if it still points at THIS peerId - a
    // 'replace' choice (see handleSession) closes the OLD connection
    // after the NEW one has already claimed the device slot, so the old
    // connection's own belated close event must not delete the new
    // mapping out from under it.
    var deviceId = this.deviceByPeerId.get(peerId);
    this.deviceByPeerId.delete(peerId);
    if (deviceId && this.peerIdByDevice.get(deviceId) === peerId) this.peerIdByDevice.delete(deviceId);
    this.broadcast({ type: 'peer-left', peerId: peerId }, null);

    var hostId = await this.state.storage.get('hostId');
    if (hostId === peerId) {
      // Host disconnected - matches this project's accepted tradeoff (see
      // the original plan): no automatic handoff, the match just ends for
      // everyone. Clearing hostId here means if the DO's room is reused
      // later, the next connector cleanly becomes the new host rather than
      // every peer being stuck waiting on a hostId that can never come
      // back online.
      await this.state.storage.delete('hostId');
      this.notifyDirectory('deregister', { code: this.roomCode });
    } else {
      this.notifyDirectory('update', { code: this.roomCode, playerCount: this.sockets.size });
    }
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ }
  }

  broadcast(obj, exceptPeerId) {
    var json = JSON.stringify(obj);
    for (var entry of this.sockets) {
      var id = entry[0], ws = entry[1];
      if (id === exceptPeerId) continue;
      try { ws.send(json); } catch (e) { /* socket already gone, handleClose will catch up */ }
    }
  }
}
