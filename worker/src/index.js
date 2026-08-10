// bamball-worker - the one piece of always-on infrastructure this project
// uses. Deliberately small: room codes + permanent replay storage today;
// WebRTC signaling and the TagPro-login verification endpoint (both
// designed, not yet built) will live here too, but neither carries game
// state through the Worker - once two peers are introduced, gameplay
// traffic goes directly between them.
//
// Routes:
//   POST /api/rooms                 -> { code } - mints a fresh, unique room code
//   PUT  /api/replays/:code         -> stores a finished match's replay in R2, forever
//   GET  /replays/:code             -> serves it back, byte for byte

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - avoids look-alikes when read aloud or typed by hand
const ROOM_CODE_LENGTH   = 6;
const REPLAY_KEY_PREFIX  = 'replays/';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding',
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

  await env.REPLAYS.put(key, body, {
    httpMetadata: {
      contentType: isGzip ? 'application/gzip' : 'application/x-ndjson',
    },
  });

  return json({ ok: true, code: code, url: '/replays/' + code });
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

    var replayUpload = url.pathname.match(/^\/api\/replays\/([A-Za-z0-9]+)$/);
    if (request.method === 'PUT' && replayUpload) {
      return handleUploadReplay(request, env, replayUpload[1].toUpperCase());
    }

    var replayFetch = url.pathname.match(/^\/replays\/([A-Za-z0-9]+)$/);
    if (request.method === 'GET' && replayFetch) {
      return handleGetReplay(env, replayFetch[1].toUpperCase());
    }

    return json({ error: 'not found' }, 404);
  },
};
