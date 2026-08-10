(function () {
const TILE_SIZE = 40;

function tileToWorld(x, y) {
  return { x: x + 0.5, y: y + 0.5 };
}

function worldToTile(x, y) {
  return { x: Math.floor(x), y: Math.floor(y) };
}

function pixelsToTiles(px) {
  return px / TILE_SIZE;
}

function tilesToPixels(tiles) {
  return tiles * TILE_SIZE;
}

var Coords = { TILE_SIZE, tileToWorld, worldToTile, pixelsToTiles, tilesToPixels };
if (typeof module !== 'undefined' && module.exports) module.exports = Coords;
if (typeof globalThis !== 'undefined') globalThis.Coords = Coords;
})();
