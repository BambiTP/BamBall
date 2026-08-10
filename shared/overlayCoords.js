// overlayCoords.js - shared paint-mode (DO-NEXT-014) resolution rule.
// Required by the server (server/managers/leaderManager.js validates
// stroke points against the canvas bounds) and loaded as a <script> by
// the client (client/game/renderer.js sizes the overlay canvas), so both
// sides agree on the exact pixel grid - strokes are integer pixel
// coordinates on this grid, rasterized identically everywhere
// (pixel-perfect, per the owner's 2026-07-11 direction).
var OverlayCoords = {

  // Hard cap on either canvas dimension. Full tile resolution (40px, one
  // overlay pixel per screen pixel at zoom 1) would exceed safe browser
  // canvas limits on very large maps, so resolution steps down instead.
  MAX_CANVAS_DIM: 4096,

  // Per-tile overlays (stage 2) are one 40x40 canvas per cell - always
  // full resolution, no step-down needed for a single tile.
  TILE_PIXELS: 40,

  // Overlay pixels per map tile: full GRID_SIZE resolution unless the
  // map is so large the canvas would blow past MAX_CANVAS_DIM, never
  // below 1. Deterministic from map dimensions alone - no negotiation.
  pixelsPerTile: function (cols, rows) {
    var largest = Math.max(cols, rows, 1);
    return Math.max(1, Math.min(40, Math.floor(this.MAX_CANVAS_DIM / largest)));
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OverlayCoords;
}
