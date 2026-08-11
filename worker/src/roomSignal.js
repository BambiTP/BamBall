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
//   DO -> client   { type: 'welcome', peerId, hostId, peers: [id, ...] }
//   DO -> client   { type: 'peer-joined', peerId }
//   DO -> client   { type: 'peer-left', peerId }
//   DO -> client   { type: 'signal', from: <peerId>, data: <...> }
//
// The DO never inspects `data` - it's an opaque relay for whatever the
// WebRTC API on either end produces (RTCSessionDescriptionInit /
// RTCIceCandidateInit), so this file has zero WebRTC-specific logic and
// never needs to change if that shape does.

export class RoomSignal {
  constructor(state, env) {
    this.state = state;
    this.sockets = new Map(); // peerId -> WebSocket
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

    var pair = new WebSocketPair();
    var client = pair[0];
    var server = pair[1];
    await this.handleSession(server, peerId, role);
    return new Response(null, { status: 101, webSocket: client });
  }

  // hostId is null until someone actually claims it with ?role=host -
  // peers who connect first just wait (told hostId: null in 'welcome',
  // and 'host-assigned' once one shows up) rather than one of them being
  // silently drafted into the role. Persisted so it survives this DO
  // hibernating between messages; cleared on the host's disconnect (see
  // handleClose) so a stale, unreachable hostId never lingers.
  async handleSession(ws, peerId, role) {
    ws.accept();
    this.sockets.set(peerId, ws);

    var hostId = await this.state.storage.get('hostId');
    if (role === 'host') {
      if (hostId && this.sockets.has(hostId) && hostId !== peerId) {
        ws.close(4001, 'room already has a host');
        this.sockets.delete(peerId);
        return;
      }
      hostId = peerId;
      await this.state.storage.put('hostId', hostId);
      this.broadcast({ type: 'host-assigned', hostId: hostId }, peerId);
    }

    var peers = Array.from(this.sockets.keys()).filter(function (id) { return id !== peerId; });
    this.send(ws, { type: 'welcome', peerId: peerId, hostId: hostId || null, peers: peers });
    this.broadcast({ type: 'peer-joined', peerId: peerId }, peerId);

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
    if (msg.type !== 'signal' || typeof msg.to !== 'string') return;

    var target = this.sockets.get(msg.to);
    if (!target) return; // target already disconnected - sender will time out and retry via its own logic
    this.send(target, { type: 'signal', from: fromId, data: msg.data });
  }

  async handleClose(peerId) {
    if (!this.sockets.has(peerId)) return; // already handled (close+error can both fire)
    this.sockets.delete(peerId);
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
