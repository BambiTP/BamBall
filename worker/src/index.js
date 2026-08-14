// api.bamball.workers.dev - the one piece of always-on infrastructure this project
// uses. Deliberately small: group codes, permanent replay storage, WebRTC
// signaling (roomSignal.js), the open-groups directory (roomDirectory.js),
// and TagPro flair-login verification (tagproAuth.js). None of these carry
// game state through the Worker - once two peers' data channel is open
// (see roomSignal.js's header comment), gameplay traffic goes directly
// between them. "Room"/"Group" naming note: user-facing text, the wire
// format, and this route table all say "group" - the underlying Durable
// Objects (roomSignal.js's RoomSignal, roomDirectory.js's RoomDirectory)
// and their storage keys keep the older "room" naming internally, since
// renaming a deployed DO class needs an explicit wrangler migration, not
// just a find-replace, and nothing about that internal name is ever
// user-visible.
//
// Routes:
//   POST /api/groups                -> { code } - mints a fresh, unique group code
//   GET  /api/groups                -> { groups } - every currently-open group (roomDirectory.js),
//                                       for the homepage's live join-with-one-click list
//   GET  /api/replays               -> paginated list of every stored replay's summary
//   PUT  /api/replays/:code         -> stores a finished match's replay in R2, forever
//   GET  /replays/:code             -> serves it back, byte for byte
//   PUT  /api/settings/:name        -> stores a settings-maker file (overwritable - unlike
//                                       replays, a named preset is meant to be iterated on)
//   GET  /api/settings              -> lists every stored settings file's name
//   GET  /settings/:name            -> serves it back
//   GET  /api/signal/:code          -> WebSocket upgrade, relayed to that group's RoomSignal
//                                       Durable Object (roomSignal.js) for WebRTC signaling
//   POST /api/tagpro/login/start    -> begins "login with your real TagPro flair" (tagproAuth.js)
//   POST /api/tagpro/login/cancel   -> the session holder abandons an in-progress attempt early
//   POST /api/tagpro/login/check    -> checked by the client (a "Confirm" click) until the flair sequence completes
//   POST /api/tagpro/verify         -> a host checks a joining peer's claimed identity token
//   GET  /api/fortunatemaps/:id/png  -> proxies fortunatemaps.herokuapp.com's map PNG
//   GET  /api/fortunatemaps/:id/json -> proxies its JSON sidecar (wiring/spawn data)
//     Browsers can't fetch() a third-party site directly unless THAT site
//     opts in with its own CORS headers, which isn't ours to add - a
//     Worker fetch has no such restriction (CORS is a browser-only rule),
//     so this just relays the bytes with our own CORS headers attached.

import { RoomSignal } from './roomSignal.js';
import { RoomDirectory } from './roomDirectory.js';
import { json, corsHeaders } from './http.js';
import { handleLoginStart, handleLoginCancel, handleLoginCheck, handleVerifyToken } from './tagproAuth.js';
export { RoomSignal, RoomDirectory };

const ROOM_CODE_ALPHABET  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids look-alikes when read aloud or typed by hand
// 32^6 = ~1.07 billion possible codes - plenty for a hobby project, even
// though codes are permanent keys that never get reused (replays are
// kept forever). Confirmed fine as-is after checking the actual math.
const ROOM_CODE_LENGTH    = 6;
const REPLAY_KEY_PREFIX   = 'replays/';
const ISSUED_KEY_PREFIX   = 'issued/'; // marks a code as actually minted by handleCreateRoom - see handleUploadReplay
const SETTINGS_KEY_PREFIX = 'settings/';
const FORTUNATE_BASE      = 'https://fortunatemaps.herokuapp.com';

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

// A replay's summary rides in on the client-set X-Replay-Meta header -
// attacker-suppliable content, not anything the server itself computed -
// and gets stored forever, then served back verbatim to every visitor of
// the public /replays page (replays.html). Constrained to a known-safe
// shape before storage: caps string lengths, restricts `winner` to an
// actual enum, and - critically - has no `code`/`uploadedAt` keys in its
// output no matter what the input contains, so handleListReplays' later
// `Object.assign({code, uploadedAt}, summary)` can never have those
// server-computed fields overwritten by forged metadata.
var REPLAY_WINNERS = ['red', 'blue', 'tie'];
function sanitizeReplayMeta(raw) {
  if (!raw || typeof raw !== 'object') return {};
  var meta = {};
  if (typeof raw.mapName === 'string') meta.mapName = raw.mapName.slice(0, 80);
  if (typeof raw.mapId === 'string' || typeof raw.mapId === 'number') meta.mapId = String(raw.mapId).slice(0, 40);
  if (typeof raw.reason === 'string') meta.reason = raw.reason.slice(0, 40);
  if (REPLAY_WINNERS.indexOf(raw.winner) !== -1) meta.winner = raw.winner;
  if (raw.scores && typeof raw.scores === 'object') {
    var red  = Number(raw.scores.red);
    var blue = Number(raw.scores.blue);
    if (Number.isFinite(red) && Number.isFinite(blue)) meta.scores = { red: red, blue: blue };
  }
  return meta;
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

// Every stored settings file's name, newest first - lets the Settings
// Maker tab actually browse/load what's already been saved, instead of
// requiring the exact name to be remembered and typed back in by hand.
async function handleListSettings(env) {
  var page = await env.REPLAYS.list({ prefix: SETTINGS_KEY_PREFIX, limit: 1000 });
  var items = page.objects.map(function (obj) {
    return { name: obj.key.slice(SETTINGS_KEY_PREFIX.length).replace(/\.json$/, ''), uploadedAt: obj.uploaded };
  });
  items.sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
  return json({ settings: items });
}

function roomDirectoryStub(env) {
  return env.ROOM_DIRECTORY.get(env.ROOM_DIRECTORY.idFromName('global'));
}

async function handleListRooms(env) {
  var res = await roomDirectoryStub(env).fetch('https://internal/list');
  var data = await res.json();
  return json(data); // re-wrapped through the shared helper so this response carries CORS headers too - the DO's own is never hit directly by a browser, so it doesn't bother
}

async function handleCreateRoom(env) {
  // Retries on the (extremely unlikely, ~33^6 possibilities) chance of a
  // collision with an existing replay key - R2 has no atomic
  // "create if absent" primitive, but a plain head()-then-decide race is
  // an acceptable risk here: two groups minting the same code in the same
  // instant is astronomically rarer than the collision itself.
  for (var attempt = 0; attempt < 5; attempt++) {
    var code = randomRoomCode();
    var existing = await env.REPLAYS.head(REPLAY_KEY_PREFIX + code + '.ndjson.gz')
      || await env.REPLAYS.head(REPLAY_KEY_PREFIX + code + '.ndjson')
      || await env.REPLAYS.head(ISSUED_KEY_PREFIX + code);
    if (!existing) {
      // Marks this code as legitimately ours before handing it out, so
      // handleUploadReplay (below) can refuse an upload for a code nobody
      // actually requested. Without this, the public GET /api/groups
      // listing (which shows a real match's code while it's still in
      // progress, see roomDirectory.js) combined with this route having
      // no upload auth at all would let anyone squat any code - real or
      // entirely invented - to either block a real match's replay from
      // ever saving (a squatted code makes the real upload 409 later) or
      // just pollute the permanent public archive with fabricated matches.
      await env.REPLAYS.put(ISSUED_KEY_PREFIX + code, '');
      return json({ code: code });
    }
  }
  return json({ error: 'could not allocate a group code, try again' }, 503);
}

async function handleUploadReplay(request, env, code) {
  if (!isValidRoomCode(code)) return json({ error: 'invalid room code' }, 400);

  var issued = await env.REPLAYS.head(ISSUED_KEY_PREFIX + code);
  if (!issued) return json({ error: 'unknown group code - create one via POST /api/groups first' }, 403);

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
  if (metaHeader) { try { meta = sanitizeReplayMeta(JSON.parse(metaHeader)); } catch (e) {} }

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

    if (request.method === 'POST' && url.pathname === '/api/groups') {
      return handleCreateRoom(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/groups') {
      return handleListRooms(env);
    }

    if (request.method === 'POST' && url.pathname === '/api/tagpro/login/start') {
      return handleLoginStart(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/tagpro/login/cancel') {
      return handleLoginCancel(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/tagpro/login/check') {
      return handleLoginCheck(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/tagpro/verify') {
      return handleVerifyToken(request, env);
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

    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return handleListSettings(env);
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
