// renderer.js - the Pixi application, layer stack, and core map drawing.
// This file defines the Renderer class; render/spriteAtlas.js,
// render/wallAutotile.js, render/playerRenderer.js, render/overlayRenderer.js,
// render/editorOverlay.js and render/camera.js each attach more methods onto
// Renderer.prototype (composition across files, no bundler, same pattern the
// rest of this codebase already uses for script-tag loading) so the drawing
// pipeline stays one cohesive object (layers/sprites/camera are genuinely
// shared mutable state) while each concern still lives in its own file.
//
// Renderer reads gameState (state/ is below render/ in the
// layer order, so this dependency direction is fine) but never calls back
// into state mutation functions - state/gameState.js emits events instead
// of calling this class, closing the old bidirectional coupling.

const GRID_SIZE = 40;

const GRAVITY_WELL_TILE_ID = 22;

// Largest dimension of a single baked-background texture (bakeBackground).
// 2048 is comfortably inside every WebGL2 implementation's max texture size,
// with room to spare for the atlas and overlay textures alongside it.
const MAX_BAKE_DIM = 2048;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;

    this.camera = { x: 0, y: 0, zoom: 1 };
    this.layers = {};

    this.renderLookup = {};
    for (const sd of renderData) {
      this.renderLookup[sd.id] = sd;
    }

    this.spriteSheets = {};  // { [key]: PIXI.ImageSource }
    this.sprites      = {};  // { [id]: PIXI.Texture }

    this.app   = new PIXI.Application();
    this.world = new PIXI.Container();
  }

  async init() {
    // antialias:false - MSAA buys nothing for flat, axis-aligned pixel tiles,
    // but it's real GPU cost every frame. On a software-rendered or weak/
    // integrated GPU (common without full hardware acceleration, e.g. some
    // Linux setups) that cost can be severe enough to peg a whole CPU core
    // and stall the OS, not just the tab - reported as the page load
    // "freezing the whole computer." powerPreference:'low-power' additionally
    // steers dual-GPU laptops away from spinning up the discrete GPU just to
    // draw flat sprites.
    await this.app.init({ resizeTo: this.canvas, backgroundAlpha: 0, antialias: false, powerPreference: 'low-power' });
    this.canvas.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);

    // The canvas follows the viewport, and the world's scale is derived
    // from the canvas size (render/camera.js viewScale), so a resize - or a
    // browser zoom, which resizes the CSS viewport - has to re-apply the
    // camera. Without this a free camera keeps the old scale until
    // something else happens to move it.
    window.addEventListener('resize', () => this.handleViewportResize());
  }

  getLayer(name) {
    if (!this.layers[name]) {
      const container = new PIXI.Container();
      this.layers[name] = container;
      this.world.addChild(container);
    }
    return this.layers[name];
  }

  drawTile(x, y, id) {
    const sd = this.renderLookup[id];
    if (!sd) return;
    const tex = this.sprites[id];
    if (!tex) return;
    const entry = game.dataMap[y][x];
    game.dataMap[y][x].id = id;

    if (sd.hasBackground) {
      const floor = new PIXI.Sprite(this.sprites[2]);
      floor.x = x * GRID_SIZE;
      floor.y = y * GRID_SIZE;
      this.getLayer('background').addChild(floor);
      if (entry) entry.backgroundSprite = floor;
    }

    const sprite = new PIXI.Sprite(tex);
    sprite.x = x * GRID_SIZE;
    sprite.y = y * GRID_SIZE;
    this.getLayer(sd.layer).addChild(sprite);
    if (entry) entry.sprite = sprite;

    if (id === GRAVITY_WELL_TILE_ID) {
      const circle = this.drawWellCircle(x, y);
      if (entry) entry.gravityCircle = circle;
    }

    return sprite;
  }

  // The shaded pull radius under a gravity well tile. The radius is the
  // server's - it rides in on the map seed and on every physicsChanged
  // packet (see game/matchManager.js, which emits one for a well settings
  // change specifically so this can follow it) - so a cell with no matching
  // well entry has no radius to draw and gets no circle, rather than a
  // guessed one. It used to fall back to `gameConfig.gravityWellRadius`,
  // which is a server-side global that has never existed on the client: the
  // fallback didn't draw a default circle, it threw a ReferenceError.
  drawWellCircle(x, y) {
    const cx   = x + 0.5;
    const cy   = y + 0.5;
    const well = game.wells.find(w => Math.abs(w.x - cx) < 0.01 && Math.abs(w.y - cy) < 0.01);
    if (!well) return null;

    const circle = new PIXI.Graphics();
    circle.beginFill(0x000000, 0.3);
    circle.drawCircle(0, 0, well.radius * GRID_SIZE);
    circle.endFill();
    circle.x = x * GRID_SIZE + GRID_SIZE / 2;
    circle.y = y * GRID_SIZE + GRID_SIZE / 2;
    this.getLayer(this.renderLookup[GRAVITY_WELL_TILE_ID].layer).addChild(circle);
    return circle;
  }

  // Re-draws every well's radius ring from the current game.wells. Called on
  // physicsChanged: a leader retuning gravityWellRadius, and a well tile
  // whose entry arrived after the tile itself was drawn, both land here.
  refreshWellCircles() {
    if (!game.dataMap) return;
    for (let y = 0; y < game.dataMap.length; y++) {
      for (let x = 0; x < game.dataMap[y].length; x++) {
        const entry = game.dataMap[y][x];
        if (!entry || entry.id !== GRAVITY_WELL_TILE_ID) continue;
        if (entry.gravityCircle && !entry.gravityCircle.destroyed) entry.gravityCircle.destroy();
        entry.gravityCircle = this.drawWellCircle(x, y);
      }
    }
  }

  drawFloorAt(x, y) {
    const floorTex = this.sprites[2];
    if (!floorTex) return;

    const floor = new PIXI.Sprite(floorTex);
    floor.x = x * GRID_SIZE;
    floor.y = y * GRID_SIZE;

    this.getLayer('background').addChild(floor);

    const entry = game.dataMap[y][x];
    if (entry) entry.backgroundSprite = floor;
  }

  createMap() {
    // Detaching the old scene is not the same as freeing it: removeChildren()
    // leaves every sprite and Graphics of the previous map alive, and a
    // Graphics holds its own GPU geometry/texture. texture:false is
    // deliberate - tile sprites share the atlas texture, which must survive.
    // (The baked background texture isn't shared, and is released in
    // bakeBackground; the overlay canvases in initMapOverlay below.)
    for (const child of this.world.removeChildren()) {
      if (!child.destroyed) child.destroy({ children: true });
    }
    this.layers = {};
    // Not left to the bake below: an empty map has no background children,
    // so bakeBackground bails early and the outgoing map's textures would
    // stay resident with nothing referencing them.
    this.destroyBakedBackground();

    for (let y = 0; y < game.map.length; y++) {
      for (let x = 0; x < game.map[y].length; x++) {
        const id = game.map[y][x];

        if (id !== 1 && tileCatalog.isWallTile(id)) this.drawFloorAt(x, y); // diagonal wall slope - its triangular gap needs floor showing through
        if (id !== 1 && id !== 0) this.drawTile(x, y, id);
        this.drawWallTile(x, y);
      }
    }

    this.bakeBackground();

    // Paint-mode overlay: built here so its layer slot lands above every
    // tile layer and below players (getLayer order is creation order).
    this.initMapOverlay();
  }

  // Full tile redraw through the exact drawing loop createMap uses - called
  // by map edit mode when a wall changes (autotiled wall art can't be
  // patched per cell: neighbors' edges change with it). Unlike createMap
  // (map load/change, full wipe), this keeps the player/particle layers
  // alive so balls in play aren't destroyed by a wall edit.
  //
  // Every destroyed-and-recreated layer's cached Graphics/Sprite references
  // (connectionGfx, tileSelectionGfx, tileHover - see render/editorOverlay.js)
  // are NOT manually nulled here. They don't need to be: those modules check
  // `.destroyed` (a flag Pixi itself sets when .destroy() runs) before
  // reusing a cached ref, so a reference into a just-destroyed layer is
  // detected and replaced automatically the next time it's touched - one
  // generic rule instead of remembering to reset every cached ref by hand
  // at every destruction site (which is exactly how painting a wall used to
  // permanently kill the tile-selection highlight and connect-tool overlay
  // for the rest of the session: this function's predecessor destroyed the
  // 'connections' layer but only nulled those refs in createMap, not here).
  redrawTiles() {
    const keepNames = ['overlay', 'players', 'particles', 'editHover'];
    const kept = [];
    for (const name of Object.keys(this.layers)) {
      const container = this.layers[name];
      if (keepNames.includes(name)) {
        kept.push(container);
        continue;
      }
      this.world.removeChild(container);
      container.destroy({ children: true });
      delete this.layers[name];
    }

    for (const row of game.dataMap) {
      for (const entry of row) {
        if (!entry) continue;
        entry.sprite           = null;
        entry.backgroundSprite = null;
        entry.previewSprite    = null;
        entry.coverSprite      = null;
        entry.gravityCircle    = null;
      }
    }

    for (let y = 0; y < game.map.length; y++) {
      for (let x = 0; x < game.map[y].length; x++) {
        const id = game.map[y][x];
        if (id !== 1 && tileCatalog.isWallTile(id)) this.drawFloorAt(x, y); // diagonal wall slope - its triangular gap needs floor showing through
        if (id !== 1 && id !== 0) this.drawTile(x, y, id);
        this.drawWallTile(x, y);
      }
    }
    this.bakeBackground();

    for (const container of kept) this.world.addChild(container);
  }

  changeTile(x, y, newId) {
    const entry = game.dataMap[y]?.[x];
    if (!entry) return;

    // .destroyed guards: sprites for map-load tiles were already destroyed
    // by bakeBackground (their pixels live on in the baked texture), and a
    // second destroy() throws in Pixi v8.
    if (entry.sprite) { if (!entry.sprite.destroyed) entry.sprite.destroy(); entry.sprite = null; }
    if (entry.backgroundSprite) { if (!entry.backgroundSprite.destroyed) entry.backgroundSprite.destroy(); entry.backgroundSprite = null; }
    if (entry.previewSprite) { if (!entry.previewSprite.destroyed) entry.previewSprite.destroy(); entry.previewSprite = null; }
    if (entry.gravityCircle) { if (!entry.gravityCircle.destroyed) entry.gravityCircle.destroy(); entry.gravityCircle = null; }

    entry.id = newId || 0;

    // Erased back to empty: art that loaded with the map is baked into the
    // background texture, so there may be nothing left to destroy - cover
    // the baked pixels with an empty-black square instead.
    if (!newId && !entry.coverSprite) {
      const cover = new PIXI.Graphics();
      cover.beginFill(0x23262c); // page background (game.css body) = "empty"
      cover.drawRect(0, 0, GRID_SIZE, GRID_SIZE);
      cover.endFill();
      cover.x = x * GRID_SIZE;
      cover.y = y * GRID_SIZE;
      this.getLayer('background').addChild(cover);
      entry.coverSprite = cover;
    }

    if (newId) this.drawTile(x, y, newId);
  }

  // The baked background's textures are GPU memory this renderer owns
  // outright, and destroying their sprites doesn't free them: Pixi's
  // destroy() leaves textures alone unless asked, and asking (texture: true)
  // on these layers is not an option - every tile sprite points at the one
  // SHARED atlas texture, which that would take down with it. So the textures
  // that genuinely belong to nobody else are released by hand.
  //
  // This matters because a wall paint re-bakes up to 20x/second (redrawTiles,
  // debounced in app/packetApplier.js): leaking a map's worth of texture per
  // redraw ran the GPU out of memory within seconds of a paint drag, which is
  // a hard crash of the tab and, on many drivers, of the machine.
  destroyBakedBackground() {
    for (const chunk of this.bakedBackground || []) {
      if (!chunk.texture.destroyed) chunk.texture.destroy(true);
    }
    this.bakedBackground = [];
  }

  bakeBackground() {
    const bgLayer = this.layers['background'];
    if (!bgLayer || bgLayer.children.length === 0) return;

    const width  = game.map[0].length * GRID_SIZE;
    const height = game.map.length * GRID_SIZE;

    this.destroyBakedBackground();

    // Baked in capped chunks rather than as one map-sized texture. A single
    // texture doesn't scale: mapFormat's MAX_DIMENSION is 500 tiles, which
    // bakes to 20000x20000 - about 1.6GB, and past the max texture size of
    // every GPU, so a large map didn't load slowly, it took the machine down
    // trying. Chunking also turns the peak allocation of an ordinary map into
    // several small ones, which is what makes the load stop hitching.
    const bakedSprites = [];
    for (let oy = 0; oy < height; oy += MAX_BAKE_DIM) {
      for (let ox = 0; ox < width; ox += MAX_BAKE_DIM) {
        const chunkWidth  = Math.min(MAX_BAKE_DIM, width  - ox);
        const chunkHeight = Math.min(MAX_BAKE_DIM, height - oy);

        const texture = PIXI.RenderTexture.create({ width: chunkWidth, height: chunkHeight });
        // Shifts the map so this chunk's region lands on the texture's
        // origin. Passing `transform` REPLACES the container's own transform
        // rather than composing with it, which is exactly right here (layers
        // never move - the camera lives on this.world, their parent).
        this.app.renderer.render({
          container: bgLayer,
          target:    texture,
          transform: new PIXI.Matrix().translate(-ox, -oy),
        });

        this.bakedBackground.push({ texture, x: ox, y: oy });

        const sprite = new PIXI.Sprite(texture);
        sprite.x = ox;
        sprite.y = oy;
        bakedSprites.push(sprite);
      }
    }

    for (let i = bgLayer.children.length - 1; i >= 0; i--) bgLayer.children[i].destroy();
    bgLayer.removeChildren();

    for (const sprite of bakedSprites) bgLayer.addChild(sprite);

    // No cacheAsBitmap here: the layer is already pre-baked sprites, so
    // caching it only renders them into a SECOND map-sized texture (v8
    // forwards the deprecated flag to cacheAsTexture) for no gain - doubling
    // exactly the allocation this method just went to trouble over.
  }

  start() {
    this.createMap();

    // TEMP DEBUG - remove once the teleport bug is found.
    const debugLastRender = {};

    this.app.ticker.add(() => {
      try {
        // renderAlpha only exists on the live game page (set by
        // simulation/loop.js, which the replay page doesn't load) - falling
        // back to 1 (and to player.x/y/a when prevX/Y/A were never stamped)
        // makes replay render exactly as before, un-interpolated.
        const alpha = typeof renderAlpha !== 'undefined' ? renderAlpha : 1;

        for (const player of game.players) {
          if (!player.container) continue;
          const x = player.prevX !== undefined ? player.prevX + (player.x - player.prevX) * alpha : player.x;
          const y = player.prevY !== undefined ? player.prevY + (player.y - player.prevY) * alpha : player.y;
          const a = player.prevA !== undefined ? player.prevA + (player.a - player.prevA) * alpha : player.a;

          // TEMP DEBUG - remove once the teleport bug is found.
          if (window.DEBUG_RECONCILE) {
            const last = debugLastRender[player.id];
            if (last) {
              const jump = Math.sqrt((x - last.x) ** 2 + (y - last.y) ** 2);
              if (jump > 0.15) {
                console.warn('[render-jump]', player.id, 'jump=' + jump.toFixed(3),
                  'from=(' + last.x.toFixed(3) + ',' + last.y.toFixed(3) + ')',
                  'to=(' + x.toFixed(3) + ',' + y.toFixed(3) + ')',
                  'alpha=' + alpha.toFixed(3),
                  'physX/Y=(' + player.x.toFixed(3) + ',' + player.y.toFixed(3) + ')',
                  'prevX/Y=(' + (player.prevX !== undefined ? player.prevX.toFixed(3) : 'undef') + ',' +
                    (player.prevY !== undefined ? player.prevY.toFixed(3) : 'undef') + ')',
                  'sync=', player.sync ? JSON.stringify(player.sync) : null,
                  'engineNow=' + (typeof engineClock !== 'undefined' ? engineClock.now() : 'n/a'));
              }
            }
            debugLastRender[player.id] = { x, y };
          }

          player.container.x = x * GRID_SIZE;
          player.container.y = y * GRID_SIZE;
          player.sprites.ball.rotation = a;
        }

        this.updateEggball();

        // Rolling bomb's flash breathes via a sine wave on alpha instead of
        // being animated through the particle system.
        for (const player of game.players) {
          const bombFlash = player.auraBases?.rb;
          if (bombFlash) bombFlash.alpha = Math.abs(0.75 * Math.sin(performance.now() / 150));
        }

        particleSystem.update(this.app.ticker.deltaMS / 1000);
      } catch (err) {
        // Same reasoning as simulation/loop.js: PIXI's ticker won't keep
        // calling this back if it throws, which freezes every sprite on
        // screen until a manual refresh. Log and drop the frame instead.
        console.error('Render tick failed:', err);
      }
    });
  }

  destroy() {
    // texture:false below spares the shared atlas but also spares these,
    // which nothing else references.
    this.destroyBakedBackground();
    this.destroyOverlays();
    this.app.destroy(true, { children: true, texture: false, baseTexture: false });
    this.canvas.removeChild(this.app.canvas);
  }
}
