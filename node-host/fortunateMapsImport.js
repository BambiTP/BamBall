// fortunateMapsImport.js - Node-side "give me a Fortunate Maps id, get a
// mapFormat document", mirroring local/fortunateMapsImport.js (the browser
// version). Goes through the same api.bamball.workers.dev CORS-proxy
// routes (worker/src/index.js) rather than fetching
// fortunatemaps.herokuapp.com directly, so there's one URL-building path
// shared by both environments - even though Node's own fetch has no CORS
// restriction to work around, unlike a browser's. The only real difference
// from the browser version is how PNG bytes become pixels: no canvas here,
// so pngjs decodes them instead.

const { PNG } = require('pngjs');
const MapLoader = require('../engine/tiles/mapLoader.js');

async function importFortunateMap(workerUrl, id) {
  var base = workerUrl + '/api/fortunatemaps/' + id + '/';

  var pngRes = await fetch(base + 'png');
  if (!pngRes.ok) throw new Error('map not found');
  var pngBuffer = Buffer.from(await pngRes.arrayBuffer());
  var png = PNG.sync.read(pngBuffer);

  var json = {};
  try {
    var jsonRes = await fetch(base + 'json');
    if (jsonRes.ok) json = await jsonRes.json();
  } catch (e) {
    // Tolerated, same as the browser importer - the PNG alone is enough
    // for a playable map.
  }

  function getPixel(col, row) {
    var i = (row * png.width + col) * 4;
    return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
  }

  return MapLoader.buildMapDocument({ width: png.width, height: png.height, getPixel: getPixel, json: json, id: id });
}

module.exports = { importFortunateMap };
