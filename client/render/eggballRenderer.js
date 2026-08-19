// eggballRenderer.js - draws Eggball's one projectile: a small yellow
// circle (20px/0.25-tile radius, matching engine/gameConfig.js's
// eggballRadius default - see engine/eggball.js) attached to whoever's
// carrying it, or free-flying in world space while thrown. Same
// composition-over-Renderer.prototype pattern as playerRenderer.js.

const EGGBALL_COLOR  = 0xffdd00;
const EGGBALL_RADIUS = 10; // px - 0.25 tiles * GRID_SIZE(40); not read from
                            // settingsState since a leader can retune
                            // eggballRadius without this needing to redraw.

Object.assign(Renderer.prototype, {

  // Free-flying sprite only - the carried case parents a separate small
  // circle onto the carrier's own player.container (see attachEgg below),
  // which already moves with them for free.
  initEggballSprite() {
    if (this.eggballSprite && !this.eggballSprite.destroyed) return;
    const gfx = new PIXI.Graphics();
    gfx.beginFill(EGGBALL_COLOR);
    gfx.drawCircle(0, 0, EGGBALL_RADIUS);
    gfx.endFill();
    gfx.visible = false;
    this.getLayer('players').addChild(gfx);
    this.eggballSprite = gfx;
  },

  // Called once per rendered frame (renderer.js's ticker) - game.eggball is
  // the last eggballChanged packet (see client/app.js),
  // snapped to directly rather than lerped: while thrown, the server
  // broadcasts a fresh position every physics tick (engine/eggball.js's
  // syncEggball), fine-grained enough that interpolation isn't needed the
  // way it is for players (whose updates are comparatively sparse).
  updateEggball() {
    // game.eggball defaults to {carrierId: null, x: 0, y: 0} (client/state.js)
    // and only gets real coordinates once a server 'joined'/'eggballChanged'
    // packet actually carries them - which never happens outside Eggball
    // mode. Without this gate, every non-Eggball map/mode rendered that
    // default straight through as a free-flying egg sitting at world (0,0),
    // the map's top-left corner, forever.
    if (!settingsState.physics.eggballEnabled) {
      if (this.eggballSprite) this.eggballSprite.visible = false;
      this.clearEggIcon();
      return;
    }

    this.initEggballSprite();
    const egg = game.eggball;

    if (egg.carrierId !== null) {
      this.eggballSprite.visible = false;
      this.ensureEggIcon(egg.carrierId);
      return;
    }

    this.clearEggIcon();
    this.eggballSprite.visible = true;
    this.eggballSprite.x = egg.x * GRID_SIZE;
    this.eggballSprite.y = egg.y * GRID_SIZE;
  },

  // A small dot riding on the carrier's own container - same "parent it
  // onto the ball's container so it moves for free" trick as
  // playerRenderer.js's attachFlag, just without a texture/flagLayer.
  ensureEggIcon(playerId) {
    if (this.eggIconPlayerId === playerId) return;
    this.clearEggIcon();

    const player = getPlayer(playerId);
    if (!player?.container) return;

    const dot = new PIXI.Graphics();
    dot.beginFill(EGGBALL_COLOR);
    dot.drawCircle(0, 0, EGGBALL_RADIUS);
    dot.endFill();
    dot.position.set(0, -22); // just above the ball, clear of the KOTH dot/name label
    player.container.addChild(dot);

    player.eggIcon      = dot;
    this.eggIconPlayerId = playerId;
  },

  clearEggIcon() {
    if (this.eggIconPlayerId === null || this.eggIconPlayerId === undefined) return;
    const player = getPlayer(this.eggIconPlayerId);
    if (player?.eggIcon && !player.eggIcon.destroyed) {
      player.container?.removeChild(player.eggIcon);
      player.eggIcon.destroy();
    }
    if (player) player.eggIcon = null;
    this.eggIconPlayerId = null;
  },
});
