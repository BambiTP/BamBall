// overlayRenderer.js - the paint-mode freehand drawing overlay: one canvas
// spanning the whole map plus lazily-created per-tile canvases, wrapped as
// nearest-neighbor Pixi textures so pixels stay crisp at any zoom. Strokes
// are integer-pixel Bresenham + square stamps with no anti-aliasing, so
// every client that replays the same stroke log gets an identical bitmap.

Object.assign(Renderer.prototype, {

  // Frees the previous map's overlay canvases and their GPU textures.
  // Nulling the references (all initMapOverlay used to do) doesn't get there:
  // the sprites are gone with the old layer, but each ImageSource still holds
  // an uploaded texture, and the whole-map canvas is up to MAX_CANVAS_DIM
  // square - 4096x4096 is 64MB of pixels held per map change, on both the CPU
  // and the GPU side. Zeroing the canvas dimensions is what actually hands
  // the backing bitmap back.
  destroyOverlays() {
    const overlays = [this.mapOverlay].concat(Object.values(this.tileOverlays || {}));
    for (const overlay of overlays) {
      if (!overlay) continue;
      overlay.source.destroy();
      overlay.canvas.width  = 0;
      overlay.canvas.height = 0;
    }
    this.mapOverlay   = null;
    this.tileOverlays = {};
  },

  // Called from createMap (boot and map change) - fixes the overlay's pixel
  // grid, rebuilds a canvas for each target that has strokes to replay
  // (game.mapOverlayStrokes / game.tileOverlayStrokes), and honors the
  // personal visibility toggle.
  initMapOverlay() {
    // Resets mapOverlay/tileOverlays ("x,y" -> { canvas, ctx, source, ppt }
    // per drawn-on cell), releasing the outgoing map's canvases first.
    this.destroyOverlays();

    const layer = this.getLayer('overlay');
    const cols  = game.map[0] ? game.map[0].length : 0;
    const rows  = game.map.length;
    this.overlaySize = null;
    if (!cols || !rows) return;

    // Just the dimensions up front - the canvas itself waits for something
    // to actually draw on it (resolveOverlay). It's the single biggest
    // allocation on the load path, up to MAX_CANVAS_DIM square (4096x4096 =
    // 64MB) plus a texture upload of the same, and the overwhelmingly common
    // case is a map nobody has drawn on, where all of that was spent on a
    // fully transparent bitmap.
    this.overlaySize = { cols, rows, ppt: OverlayCoords.pixelsPerTile(cols, rows) };
    layer.visible         = localSettings.showDrawings;
    layer.sortableChildren = true; // honors the zIndex createOverlaySurface sets

    if (game.mapOverlayStrokes && game.mapOverlayStrokes.length) this.redrawOverlay('map');

    for (const key in game.tileOverlayStrokes) {
      const coords = key.split(',');
      this.redrawOverlay({ x: Number(coords[0]), y: Number(coords[1]) });
    }
  },

  // One overlay surface: a canvas, its nearest-neighbor texture on the
  // overlay layer scaled to cover `tiles` map cells, and the 2d context
  // strokes are rasterized into.
  createOverlaySurface(pixels, tiles, x, y, zIndex) {
    const canvas = document.createElement('canvas');
    canvas.width  = pixels.w;
    canvas.height = pixels.h;

    const source = new PIXI.ImageSource({ resource: canvas, scaleMode: 'nearest' });
    const sprite = new PIXI.Sprite(new PIXI.Texture({ source }));
    sprite.scale.set(GRID_SIZE * tiles.w / pixels.w, GRID_SIZE * tiles.h / pixels.h);
    sprite.x = x;
    sprite.y = y;
    // Explicit z instead of creation order: per-tile drawings have always
    // sat on top of map-wide ones, and now that surfaces are created on
    // first use rather than all at init, creation order no longer says
    // anything about which is which.
    sprite.zIndex = zIndex;
    this.getLayer('overlay').addChild(sprite);

    return { canvas, ctx: canvas.getContext('2d'), source, ppt: pixels.w / tiles.w };
  },

  // The canvas/texture bundle an overlay target draws into, created on first
  // use. Nothing calls this to "check" for an overlay - every caller is about
  // to draw - so allocating here is exactly as eager as it needs to be.
  resolveOverlay(target) {
    if (!this.overlaySize) return null;
    const { cols, rows, ppt } = this.overlaySize;

    if (target === 'map') {
      if (!this.mapOverlay) {
        this.mapOverlay = this.createOverlaySurface(
          { w: cols * ppt, h: rows * ppt }, { w: cols, h: rows }, 0, 0, 0);
      }
      return this.mapOverlay;
    }
    if (!target) return null;

    const key = target.x + ',' + target.y;
    if (!this.tileOverlays[key]) {
      const px = OverlayCoords.TILE_PIXELS;
      this.tileOverlays[key] = this.createOverlaySurface(
        { w: px, h: px }, { w: 1, h: 1 }, target.x * GRID_SIZE, target.y * GRID_SIZE, 1);
    }
    return this.tileOverlays[key];
  },

  setOverlayVisible(visible) {
    if (this.layers['overlay']) this.layers['overlay'].visible = visible;
  },

  // Bresenham line of size x size square stamps, centered on each pixel -
  // deterministic integer math only, the ONE rasterization rule both live
  // drawing and log replay share. Callers set ctx.fillStyle first.
  overlayStampLine(ctx, x0, y0, x1, y1, size) {
    const off = size >> 1;
    let dx  = Math.abs(x1 - x0);
    let dy  = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    for (;;) {
      ctx.fillRect(x0 - off, y0 - off, size, size);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  },

  // Live-drawing increment: one segment of the in-progress stroke.
  drawOverlaySegment(target, x0, y0, x1, y1, color, size) {
    const overlay = this.resolveOverlay(target);
    if (!overlay) return;
    overlay.ctx.fillStyle = color;
    this.overlayStampLine(overlay.ctx, x0, y0, x1, y1, size);
    overlay.source.update();
  },

  // One whole stroke (a broadcast from another client's pen, or replay).
  drawOverlayStroke(target, stroke, deferUpdate) {
    const overlay = this.resolveOverlay(target);
    if (!overlay) return;
    const ctx = overlay.ctx;
    ctx.fillStyle = stroke.color;

    const pts = stroke.points;
    for (let i = 0; i < pts.length; i++) {
      const from = pts[i - 1] || pts[i]; // single-point stroke still stamps
      this.overlayStampLine(ctx, from[0], from[1], pts[i][0], pts[i][1], stroke.size);
    }
    if (!deferUpdate) overlay.source.update();
  },

  // Full rebuild of one target's canvas from its log - undo/clear can't be
  // incremental (an erased stroke may sit under later ones).
  redrawOverlay(target) {
    const overlay = this.resolveOverlay(target);
    if (!overlay) return;
    const { ctx, canvas, source } = overlay;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const strokes = target === 'map'
      ? game.mapOverlayStrokes
      : (game.tileOverlayStrokes[target.x + ',' + target.y] || []);
    for (const stroke of strokes) this.drawOverlayStroke(target, stroke, true);
    source.update();
  },
});
