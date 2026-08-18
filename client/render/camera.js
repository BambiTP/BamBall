// camera.js - camera positioning plus the per-frame follow logic. The old
// loop.js called renderer.setCamera directly from inside the physics tick,
// coupling the core simulation loop to the render layer. Instead,
// simulation/loop.js emits a 'frame' event once per animation frame and
// this module - not the simulation loop - decides where the camera goes.

// The view at camera zoom 1, in world pixels. The canvas fills the browser
// viewport (game.css #viewport is fixed inset:0, app.init's resizeTo follows
// it), so without a reference the amount of MAP you see would be decided by
// your window: a bigger monitor, a taller window, or Ctrl+- (which enlarges
// the CSS pixel viewport) would each reveal more of it. That's a real
// advantage in a game about seeing people coming, so the view is locked to
// this reference and the canvas size only decides how big the pixels are.
//
// 1280x800 - the default view, 32x20 tiles. This is also gameConfig's
// viewportWidth/viewportHeight, which game/snapshotFactory.js culls against
// when deciding which players are worth sending you at all, and the two must
// stay equal: render wider than the server culls and the extra area is a
// dead zone where other balls don't appear until they come closer. Change
// one, change the other.
//
// This used to be 1920x1080 (48x27 tiles) on the theory that a maximized
// 1080p browser was the common case - but that is a *window* size, not a
// view size, so it put 1.5x as much map on screen as the default zoom should
// show, which read as everything being permanently zoomed out.
const REFERENCE_VIEW_WIDTH  = 1280;
const REFERENCE_VIEW_HEIGHT = 800;

Object.assign(Renderer.prototype, {

  // The larger of the two axis fits, so neither ever exceeds the reference:
  // an unusually wide or tall window sees LESS on the other axis rather than
  // more on this one. Nobody gains by reshaping their window.
  viewScale() {
    return Math.max(
      this.app.renderer.width  / REFERENCE_VIEW_WIDTH,
      this.app.renderer.height / REFERENCE_VIEW_HEIGHT
    );
  },

  // What the world container is ACTUALLY scaled by: the player's zoom
  // multiplied by the viewport fit. camera.zoom on its own stays the
  // logical zoom level (what the settings and the wheel operate on) - any
  // screen<->world conversion needs this instead.
  worldScale() {
    return this.camera.zoom * this.viewScale();
  },

  setCamera(x, y, zoom = 1) {
    this.camera.x = x;
    this.camera.y = y;
    this.camera.zoom = zoom;

    const scale = this.worldScale();
    this.world.scale.set(scale);
    this.world.x = (this.app.renderer.width  / 2) - (x * GRID_SIZE * scale);
    this.world.y = (this.app.renderer.height / 2) - (y * GRID_SIZE * scale);
  },

  // Re-apply the current camera at the new viewport size. A player's camera
  // is recomputed every frame by cameraController and would self-correct,
  // but a free/spectator camera is only set on demand and would otherwise
  // keep a stale scale until something moved it.
  handleViewportResize() {
    this.setCamera(this.camera.x, this.camera.y, this.camera.zoom);
  },

  // Edit-mode free camera zoom - zooms around the current center rather
  // than the cursor, fine for a free-floating edit-mode camera.
  zoomCamera(factor) {
    const newZoom = Math.min(3, Math.max(0.3, this.camera.zoom * factor));
    this.setCamera(this.camera.x, this.camera.y, newZoom);
  },
});

var cameraController = {
  update() {
    var me = game.myId !== null ? getPlayer(game.myId) : null;

    if (me) {
      var pos = interpolatedFollowPosition(me);
      // The camera follows your ball exactly as it does in a game room.
      // Zoom is the one difference: an editor room lets you zoom freely
      // while playing (client/inputs.js zoomIsFree), so re-applying
      // the room's allowed zoom every frame here would undo it instantly.
      var zoom = game.roomKind === 'editor'
        ? renderer.camera.zoom
        : settingsState.allowedCameraZoom();
      renderer.setCamera(pos.x, pos.y, zoom);
      game.spectateFollowId = null;
      game.spectateCameraReady = false;
      return;
    }

    // Spectating (or not in-game yet): movement keys can pin the camera to
    // a specific player (client/inputs.js spectateFollow) - keep
    // tracking them every frame, preserving whatever zoom the spectator
    // has set. Otherwise leave the camera alone (they may be dragging/
    // zooming it freely) - only set an initial position once.
    if (game.spectateFollowId !== null) {
      var followed = getPlayer(game.spectateFollowId);
      if (followed) {
        var followedPos = interpolatedFollowPosition(followed);
        renderer.setCamera(followedPos.x, followedPos.y, renderer.camera.zoom);
        return;
      }
      game.spectateFollowId = null; // followed player despawned/disconnected
    }

    if (!game.spectateCameraReady && game.map.length) {
      renderer.setCamera(game.map[0].length / 2, game.map.length / 2, renderer.camera.zoom || 1);
      game.spectateCameraReady = true;
    }
  },
};

// Same lerp renderer.js's ticker uses for sprites, applied to whoever the
// camera is following - otherwise the ball would glide smoothly while the
// camera centered on it still jumped in fixed 60Hz steps, which looks worse
// than both moving in steps together. renderAlpha/prevX/Y only exist on the
// live game page (simulation/loop.js); replay.html wires this same
// cameraController.update straight to its own ticker with neither defined,
// so the fallbacks make it read raw x/y there, unchanged from before.
function interpolatedFollowPosition(player) {
  var alpha = typeof renderAlpha !== 'undefined' ? renderAlpha : 1;
  return {
    x: player.prevX !== undefined ? player.prevX + (player.x - player.prevX) * alpha : player.x,
    y: player.prevY !== undefined ? player.prevY + (player.y - player.prevY) * alpha : player.y,
  };
}
