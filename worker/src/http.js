// http.js - the tiny JSON response + CORS helper every route in this
// Worker uses, pulled out of index.js so tagproAuth.js can share it
// instead of duplicating the CORS header list a second place it'd need to
// be kept in sync by hand.

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, X-Replay-Gzip',
  };
}

export function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders()),
  });
}
