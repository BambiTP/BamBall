// fortunateMapsImport.js - browser-side "give me a Fortunate Maps id, get a
// mapFormat document" used by the Settings tab's map field
// (local/controlPanel.js) and both switchMap()s (localTransport.js,
// webrtcTransport.js). fortunatemaps.herokuapp.com sends no
// Access-Control-Allow-Origin header (confirmed against the live site), so
// a browser can't fetch() it directly - api.bamball.workers.dev's
// /api/fortunatemaps/:id/png|json routes (worker/src/index.js) relay the
// bytes with our own CORS headers instead. The actual PNG-colour -> tile-id
// decode is environment-agnostic (engine/tiles/mapLoader.js); this file's
// only job is turning PNG bytes into pixels, which in a browser means a
// canvas, not a decode library.

function importFortunateMap(id) {
  var base = activeTransport.workerUrl + '/api/fortunatemaps/' + id + '/';

  return Promise.all([
    fetch(base + 'png').then(function (res) {
      if (!res.ok) throw new Error('map not found');
      return res.blob();
    }),
    fetch(base + 'json').then(function (res) { return res.ok ? res.json() : {}; }).catch(function () { return {}; }),
  ]).then(function (result) {
    var pngBlob = result[0];
    var json    = result[1];

    return createImageBitmap(pngBlob).then(function (bitmap) {
      var canvas = document.createElement('canvas');
      canvas.width  = bitmap.width;
      canvas.height = bitmap.height;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      var data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;

      function getPixel(col, row) {
        var i = (row * bitmap.width + col) * 4;
        return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
      }

      return MapLoader.buildMapDocument({
        width: bitmap.width, height: bitmap.height, getPixel: getPixel, json: json, id: id,
      });
    });
  });
}
