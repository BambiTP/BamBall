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
      var rooms = Array.from(entries.values());
      rooms.sort(function (a, b) { return b.createdAt - a.createdAt; });
      return new Response(JSON.stringify({ rooms: rooms }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  }
}
