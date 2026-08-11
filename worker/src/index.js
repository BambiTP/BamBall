// api.bambipro.workers.dev - the one piece of always-on infrastructure this project
// uses. Deliberately small: room codes, permanent replay storage, and
// WebRTC signaling (roomSignal.js) today; the TagPro-login verification
// endpoint (designed, not yet built) will live here too. None of these
// carry game state through the Worker - once two peers' data channel is
// open (see roomSignal.js's header comment), gameplay traffic goes
// directly between them.
//
// Routes:
//   POST /api/rooms                 -> { code } - mints a fresh, unique room code
//   GET  /api/replays               -> paginated list of every stored replay's summary
//   PUT  /api/replays/:code         -> stores a finished match's replay in R2, forever
//   GET  /replays/:code             -> serves it back, byte for byte
//   PUT  /api/settings/:name        -> stores a settings-maker file (overwritable - unlike
//                                       replays, a named preset is meant to be iterated on)
//   GET  /settings/:name            -> serves it back
//   GET  /api/signal/:code          -> WebSocket upgrade, relayed to that room's RoomSignal
//                                       Durable Object (roomSignal.js) for WebRTC signaling
//   GET  /api/fortunatemaps/:id/png  -> proxies fortunatemaps.herokuapp.com's map PNG
//   GET  /api/fortunatemaps/:id/json -> proxies its JSON sidecar (wiring/spawn data)
//     Browsers can't fetch() a third-party site directly unless THAT site
//     opts in with its own CORS headers, which isn't ours to add - a
//     Worker fetch has no such restriction (CORS is a browser-only rule),
//     so this just relays the bytes with our own CORS headers attached.

import { RoomSignal } from './roomSignal.js';
export { RoomSignal };

const ROOM_CODE_ALPHABET  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids look-alikes when read aloud or typed by hand
// 32^6 = ~1.07 billion possible codes - plenty for a hobby project, even
// though codes are permanent keys that never get reused (replays are
// kept forever). Confirmed fine as-is after checking the actual math.
const ROOM_CODE_LENGTH    = 6;
const REPLAY_KEY_PREFIX   = 'replays/';
const SETTINGS_KEY_PREFIX = 'settings/';
const FORTUNATE_BASE      = 'https://fortunatemaps.herokuapp.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, X-Replay-Gzip',
  };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
  });
}

function randomRoomCode() {
  var out = '';
  var bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  for (var i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9]{4,12}$/.test(code);
}

// Settings-file names are user-chosen (e.g. "fun-superspeed"), not
// server-minted like room codes - constrained to a safe slug shape since
// it goes straight into an R2 key and a URL path.
function isValidSettingsName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

async function handleUploadSettings(request, env, name) {
  if (!isValidSettingsName(name)) return json({ error: 'invalid name - use letters, numbers, - and _ only' }, 400);

  var body = await request.text();
  try { JSON.parse(body); } catch (e) { return json({ error: 'body must be valid JSON' }, 400); }

  await env.REPLAYS.put(SETTINGS_KEY_PREFIX + name + '.json', body, {
    httpMetadata: { contentType: 'application/json' },
  });
  return json({ ok: true, name: name, url: '/settings/' + name });
}

async function handleGetSettings(env, name) {
  if (!isValidSettingsName(name)) return json({ error: 'invalid name' }, 400);

  var object = await env.REPLAYS.get(SETTINGS_KEY_PREFIX + name + '.json');
  if (!object) return json({ error: 'not found' }, 404);

  var headers = new Headers(corsHeaders());
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'public, max-age=60'); // short cache - unlike replays, these are meant to be overwritten
  return new Response(object.body, { headers: headers });
}

async function handleCreateRoom(env) {
  // Retries on the (extremely unlikely, ~33^6 possibilities) chance of a
  // collision with an existing replay key - R2 has no atomic
  // "create if absent" primitive, but a plain head()-then-decide race is
  // an acceptable risk here: two rooms minting the same code in the same
  // instant is astronomically rarer than the collision itself.
  for (var attempt = 0; attempt < 5; attempt++) {
    var code = randomRoomCode();
    var existing = await env.REPLAYS.head(REPLAY_KEY_PREFIX + code + '.ndjson.gz')
      || await env.REPLAYS.head(REPLAY_KEY_PREFIX + code + '.ndjson');
    if (!existing) return json({ code: code });
  }
  return json({ error: 'could not allocate a room code, try again' }, 503);
}

async function handleUploadReplay(request, env, code) {
  if (!isValidRoomCode(code)) return json({ error: 'invalid room code' }, 400);

  // The upload is already gzip'd bytes (localReplayRecorder.js's
  // CompressionStream output) or plain NDJSON text if the browser has no
  // CompressionStream - either way it's stored and served as opaque
  // binary content, deliberately NOT as an HTTP Content-Encoding. Letting
  // the transport layer interpret Content-Encoding on an already-compressed
  // body is exactly what produced a double-decode mismatch during local
  // testing (Miniflare's dev server re-wrapping an already-gzip'd body) -
  // sidestepped entirely by never claiming a transport encoding at all.
  // The client compresses explicitly and must decompress explicitly too.
  var isGzip = request.headers.get('X-Replay-Gzip') === '1';
  var key = REPLAY_KEY_PREFIX + code + (isGzip ? '.ndjson.gz' : '.ndjson');

  var body = await request.arrayBuffer();
  if (!body.byteLength) return json({ error: 'empty body' }, 400);

  // Stored once, kept forever (confirmed requirement) - no overwrite guard
  // needed beyond "the room already has one", since a room's replay is
  // written exactly once, when its match ends.
  var already = await env.REPLAYS.head(key);
  if (already) return json({ error: 'replay already stored for this room' }, 409);

  // Small, sortable summary for the future public replay-browsing page
  // (mapName/scores/finishedAt at minimum) - R2 customMetadata values must
  // be strings, so it travels as one JSON blob under a single key rather
  // than one field each. R2's own list() (see handleListReplays) is enough
  // to browse/sort by this at the current scale; a real database (D1) is
  // the upgrade path if the replay count ever gets large enough that
  // listing+client-side sorting stops being fast enough.
  var metaHeader = request.headers.get('X-Replay-Meta');
  var meta = {};
  if (metaHeader) { try { meta = JSON.parse(metaHeader); } catch (e) {} }

  await env.REPLAYS.put(key, body, {
    httpMetadata: {
      contentType: isGzip ? 'application/gzip' : 'application/x-ndjson',
    },
    customMetadata: { summary: JSON.stringify(meta) },
  });

  return json({ ok: true, code: code, url: '/replays/' + code });
}

// Every stored replay's code + summary metadata, newest first - the data
// source for the future public browsing/sorting page. Paginated via R2's
// own cursor (list() caps at 1000 per call) rather than trying to fetch
// everything at once as the bucket grows.
async function handleListReplays(env, cursor) {
  var page = await env.REPLAYS.list({ prefix: REPLAY_KEY_PREFIX, cursor: cursor || undefined, limit: 100 });
  var items = page.objects.map(function (obj) {
    var code = obj.key.slice(REPLAY_KEY_PREFIX.length).replace(/\.ndjson(\.gz)?$/, '');
    var summary = {};
    if (obj.customMetadata && obj.customMetadata.summary) {
      try { summary = JSON.parse(obj.customMetadata.summary); } catch (e) {}
    }
    return Object.assign({ code: code, uploadedAt: obj.uploaded }, summary);
  });
  items.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  return json({ replays: items, cursor: page.truncated ? page.cursor : null });
}

async function handleGetReplay(env, code) {
  if (!isValidRoomCode(code)) return json({ error: 'invalid room code' }, 400);

  var gzipObject = await env.REPLAYS.get(REPLAY_KEY_PREFIX + code + '.ndjson.gz');
  var object = gzipObject || await env.REPLAYS.get(REPLAY_KEY_PREFIX + code + '.ndjson');
  if (!object) return json({ error: 'not found' }, 404);

  var headers = new Headers(corsHeaders());
  headers.set('Content-Type', gzipObject ? 'application/gzip' : 'application/x-ndjson');
  headers.set('X-Replay-Gzip', gzipObject ? '1' : '0'); // tells the client whether to run it through DecompressionStream itself
  headers.set('Cache-Control', 'public, max-age=31536000, immutable'); // written once, never changes
  return new Response(object.body, { headers: headers });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      return handleCreateRoom(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/replays') {
      return handleListReplays(env, url.searchParams.get('cursor'));
    }

    var replayUpload = url.pathname.match(/^\/api\/replays\/([A-Za-z0-9]+)$/);
    if (request.method === 'PUT' && replayUpload) {
      return handleUploadReplay(request, env, replayUpload[1].toUpperCase());
    }

    var replayFetch = url.pathname.match(/^\/replays\/([A-Za-z0-9]+)$/);
    if (request.method === 'GET' && replayFetch) {
      return handleGetReplay(env, replayFetch[1].toUpperCase());
    }

    // WebSocket upgrade, forwarded as-is to that room's RoomSignal Durable
    // Object - idFromName means the same room code always resolves to the
    // same DO instance, so every peer using that code lands in the same
    // signaling session without any other coordination needed.
    var signalMatch = url.pathname.match(/^\/api\/signal\/([A-Za-z0-9]+)$/);
    if (request.method === 'GET' && signalMatch) {
      if (!isValidRoomCode(signalMatch[1].toUpperCase())) return json({ error: 'invalid room code' }, 400);
      var doId = env.ROOM_SIGNAL.idFromName(signalMatch[1].toUpperCase());
      var stub = env.ROOM_SIGNAL.get(doId);
      return stub.fetch(request);
    }

    var settingsUpload = url.pathname.match(/^\/api\/settings\/([A-Za-z0-9_-]+)$/);
    if (request.method === 'PUT' && settingsUpload) {
      return handleUploadSettings(request, env, settingsUpload[1]);
    }

    var settingsFetch = url.pathname.match(/^\/settings\/([A-Za-z0-9_-]+)$/);
    if (request.method === 'GET' && settingsFetch) {
      return handleGetSettings(env, settingsFetch[1]);
    }

    return json({ error: 'not found' }, 404);
  },
};
