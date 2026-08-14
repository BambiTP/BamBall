// roomDirectory.js - a single, singleton Durable Object
// (env.ROOM_DIRECTORY.idFromName('global')) holding the list of currently-
// open rooms, so the homepage can show a live "join with one click" list
// instead of requiring someone to already have an out-of-band code.
//
// Never touched directly by any browser - a room's own RoomSignal instance
// tells it about that room's lifecycle (register on the first host claim,
// update on player-count changes, deregister once the host disconnects)
// via plain DO-to-DO fetch() calls. Strongly consistent and cheap for this
// size of aggregate state, unlike R2 list() (this project's other listing
// pattern, used for replays/settings) which is eventually consistent -
// wrong tradeoff for "which rooms are open right now," where staleness
// would show phantom or missing rooms.

var ROOM_KEY_PREFIX = 'room:';

export class RoomDirectory {
  constructor(state, env) {
    this.state = state;
  }

  async fetch(request) {
    var url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/register') {
      var body = await request.json();
      if (!body.code) return new Response('missing code', { status: 400 });
      await this.state.storage.put(ROOM_KEY_PREFIX + body.code, {
        code: body.code,
        hostName: body.hostName || 'Host',
        hasPassword: !!body.hasPassword,
        playerCount: 1, // the host themself
        createdAt: Date.now(),
      });
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/update') {
      var updateBody = await request.json();
      // playerCount reaching 0 here (rather than a clean /deregister) means
      // the host's own disconnect never got to fire one - a killed process,
      // a crashed tab, a network drop mid-teardown - and this was the last
      // remaining peer's ordinary leave (roomSignal.js's handleClose)
      // finding out. The room is exactly as gone either way, so treat it
      // the same as a real deregister instead of leaving a 0-player ghost
      // sitting in the open-groups list forever.
      if (updateBody.playerCount <= 0) {
        await this.state.storage.delete(ROOM_KEY_PREFIX + updateBody.code);
        return new Response('ok');
      }
      var existing = await this.state.storage.get(ROOM_KEY_PREFIX + updateBody.code);
      if (existing) {
        existing.playerCount = updateBody.playerCount;
        await this.state.storage.put(ROOM_KEY_PREFIX + updateBody.code, existing);
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/deregister') {
      var deregisterBody = await request.json();
      await this.state.storage.delete(ROOM_KEY_PREFIX + deregisterBody.code);
      return new Response('ok');
    }

    if (request.method === 'GET' && url.pathname === '/list') {
      var entries = await this.state.storage.list({ prefix: ROOM_KEY_PREFIX });
      var groups = Array.from(entries.values());
      groups.sort(function (a, b) { return b.createdAt - a.createdAt; });
      return new Response(JSON.stringify({ groups: groups }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  }
}
