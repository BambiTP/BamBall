// replayFormat.js - shared record-envelope encoding between
// server/replay/replayRecorder.js (writes) and client/replay/'s reader
// (client/replay/state/replayIndex.js), so the two can never silently
// drift on what a type code or input bitmask means.
//
// Each NDJSON line is a 4-element array, not an object: [typeCode,
// deltaStep, deltaMs, payload]. Positional fields instead of named keys -
// "type"/"step"/"ms"/"data" repeated as literal text on every single line
// was the single biggest source of bytes in the original object-per-line
// format. deltaStep/deltaMs are relative to the PREVIOUS line, not
// absolute - consecutive records are almost always close together in both
// clocks, so the deltas run far shorter (often 1-2 digits) than the
// absolute step counter (5+ digits) or wall-clock ms ever did.
//
// Isomorphic module (CommonJS + plain global), same pattern as
// movement.js/forceFields.js in this directory: required
// by the server, <script>-tagged by the client.
var RECORD_TYPE = {
  SETUP:     0,
  BROADCAST: 1,
  PLAYERS:   2,
  INPUT:     3,
  END:       4,
};

// Input packets are 4 booleans (left/right/up/down) - as named JSON keys
// that's ~50 bytes ({"id":1,"left":true,"right":false,"up":true,"down":false}),
// as [id, bitmask] it's a handful. Bit order is arbitrary, just shared.
var INPUT_BITS = { left: 1, right: 2, up: 4, down: 8 };

function encodeInputMask(input) {
  var mask = 0;
  if (input.left)  mask |= INPUT_BITS.left;
  if (input.right) mask |= INPUT_BITS.right;
  if (input.up)    mask |= INPUT_BITS.up;
  if (input.down)  mask |= INPUT_BITS.down;
  return mask;
}

function decodeInputMask(mask) {
  return {
    left:  !!(mask & INPUT_BITS.left),
    right: !!(mask & INPUT_BITS.right),
    up:    !!(mask & INPUT_BITS.up),
    down:  !!(mask & INPUT_BITS.down),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RECORD_TYPE: RECORD_TYPE, encodeInputMask: encodeInputMask, decodeInputMask: decodeInputMask };
}
