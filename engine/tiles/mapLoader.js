(function () {
// mapLoader.js - turns a Fortunate Maps PNG+JSON pair into a mapFormat
// document. Fortunate Maps stores a map as a colour-coded PNG (one pixel
// per tile) plus a JSON sidecar holding what colour can't express: gate
// default states, portal destinations, switch wiring, spawn points, and
// the map's name/author.
//
// Deliberately has ZERO I/O of its own - no fetch, no PNG decode. Every
// environment that can produce pixels (browser canvas, a Node PNG decoder)
// feeds them through the same getPixel(col, row) -> {r,g,b,a} shape, so
// this table/logic exists exactly once instead of once per environment.
// See local/fortunateMapsImport.js (browser) and
// node-host/fortunateMapsImport.js (Node) for the two current callers.
//
// The decode happens ONCE, at import. After that the map is stored as tile
// ids in our own format (engine/tiles/mapFormat.js) and this file is not
// involved in loading it again - which is what lets a stored map carry
// tiles Fortunate Maps has no colour for.

var MapFormat = (typeof require === 'function') ? require('./mapFormat') : globalThis.MapFormat;

var COLOR_TO_ID = {
  '787878': 1,     // Wall
  '408050': 1.2,   // 45TL
  '405080': 1.3,   // 45TR
  '807040': 1.1,   // 45BL
  '804070': 1.4,   // 45BR
  'd4d4d4': 2,     // Floor
  '808000': 16,    // YellowFlag
  'ff0000': 3,     // RedFlag
  '0000ff': 4,     // BlueFlag
  '373737': 7,     // Spike
  '202020': 22,    // GravityWell
  '656500': 21,    // YellowPotato
  'ff8080': 19,    // RedPotato
  '8080ff': 20,    // BluePotato
  'b90000': 17,    // RedGoal
  '190094': 18,    // BlueGoal
  'dcbaba': 11,    // RedTile
  'bbb8dd': 12,    // BlueTile
  'dcdcba': 23,    // YellowTile
  'ff8000': 10,    // Bomb
  'b97a57': 8,     // Button
  '007500': 9,     // Gate (overridden by JSON)
  '00ff00': 6,     // Powerup
  'cac000': 13,    // Portal
  'cc3300': 24,    // RedPortal
  '0066cc': 25,    // BluePortal
  'ffff00': 5,     // Boost
  'ff7373': 14,    // RedBoost
  '7373ff': 15,    // BlueBoost
};

var GATE_HEX     = '007500';
var PORTAL_HEXES = ['cac000', 'cc3300', '0066cc'];

function toHex(n) {
  var s = n.toString(16);
  return s.length < 2 ? '0' + s : s;
}

// One pixel -> one tile id. The two colours whose meaning depends on the
// JSON sidecar (gates carry a default state, portals may or may not be
// linked) resolve to a decimal variant of their base id.
function decodeTile(getPixel, col, row, fields, portals) {
  var rgba = getPixel(col, row);
  if (rgba.a === 0) return 0;

  var hex = toHex(rgba.r) + toHex(rgba.g) + toHex(rgba.b);
  var tileKey = col + ',' + row;

  if (hex === GATE_HEX) {
    var state = fields[tileKey] && fields[tileKey].defaultState ? fields[tileKey].defaultState.toLowerCase() : null;
    return state === 'on'   ? 9.1
         : state === 'red'  ? 9.2
         : state === 'blue' ? 9.3
         : 9;
  }

  if (PORTAL_HEXES.indexOf(hex) !== -1) {
    var baseId = COLOR_TO_ID[hex];
    var portal = portals[tileKey];
    return (portal && portal.destination != null) ? baseId : baseId + 0.1;
  }

  return COLOR_TO_ID[hex] !== undefined ? COLOR_TO_ID[hex] : 0;
}

// { width, height, getPixel(col,row)->{r,g,b,a}, json, id } -> a normalized
// mapFormat document. `json` is Fortunate Maps' sidecar (info/fields/
// portals/switches/spawnPoints) - tolerant of it being {} (a missing or
// unparseable sidecar), since the PNG alone is enough for a playable map
// (gates default closed, portals unlinked, spawns fall back to the flags).
function buildMapDocument(options) {
  var width    = options.width;
  var height   = options.height;
  var getPixel = options.getPixel;
  var json     = options.json || {};
  var fields   = json.fields   || {};
  var portals  = json.portals  || {};
  var switches = json.switches || {};

  var tiles = [];
  for (var row = 0; row < height; row++) {
    tiles[row] = [];
    for (var col = 0; col < width; col++) {
      tiles[row][col] = decodeTile(getPixel, col, row, fields, portals);
    }
  }

  return MapFormat.normalizeDocument({
    tiles: tiles,
    name:   (json.info && json.info.name)   || null,
    author: (json.info && json.info.author) || null,
    portals: portals,
    switches: switches,
    spawnPoints: json.spawnPoints || {},
    source: { type: 'fortunatemaps', id: String(options.id) },
  });
}

var MapLoader = { COLOR_TO_ID, decodeTile, buildMapDocument };
if (typeof module !== 'undefined' && module.exports) module.exports = MapLoader;
if (typeof globalThis !== 'undefined') globalThis.MapLoader = MapLoader;

})();
