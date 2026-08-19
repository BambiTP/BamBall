// playerRenderer.js - player ball rendering: the sprite hierarchy, carried-
// flag icon, powerup status icons/auras, KOTH dot.

// The sprite shown on a player's back while carrying a flag can be
// customized independently of the ground flag sprite. Derived from
// renderData.js's TILE_STATE_FAMILIES (every 3-entry family is [ground,
// taken, carried]) instead of a hand-typed id table - that used to be
// duplicated by hand in three separate places (this file, renderData.js's
// label overrides, and server/db.js), which is exactly the kind of drift
// risk CLIENT_REWRITE_GUIDE.md flagged for the rewrite to close.
const CARRIED_FLAG_IDS = {};
for (const family of TILE_STATE_FAMILIES) {
  if (family.length === 3) CARRIED_FLAG_IDS[family[0]] = family[2];
}

// Maps the snapshot's short powerup keys to the particle config that
// renders each one's aura.
const AURA_CONFIGS = {
  jj: particleConfigs.jukeJuice,
  rb: particleConfigs.rollingBomb,
  tp: particleConfigs.tagpro,
};

// The shared flair spritesheet (assets/sprites/flair.png) is the real
// sheet pulled straight from tagpro.koalabeast.com's own site
// (.../images/flair.png, 234x360) - packed on an 18px grid with a 16px
// icon in each cell (2px gutter), matching that site's own stylesheet
// (--flair-pitch: 18px). 234/18 and 360/18 both divide evenly (13 cols x
// 20 rows, 260 icons) - confirms this pitch, unlike the smaller
// BambiTP/Tagpro-Next placeholder sheet this replaced, which was a tight
// 16px grid with no gutter at all.
const FLAIR_PITCH = 18;
const FLAIR_ICON_SIZE = 16;

Object.assign(Renderer.prototype, {

  // Loads the flair spritesheet once and slices it into one Texture per
  // icon, flat-indexed row-major (index = row * cols + col) - the same
  // indexing local/flairPicker.js's grid and localSettings.flairIndex use,
  // so a player's flairIndex needs no separate (col,row) lookup table.
  // Safe to call more than once - every caller shares the one promise.
  ensureFlairSheet() {
    if (this._flairSheetPromise) return this._flairSheetPromise;
    this._flairSheetPromise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const cols = Math.floor(img.naturalWidth  / FLAIR_PITCH);
        const rows = Math.floor(img.naturalHeight / FLAIR_PITCH);
        const source = new PIXI.ImageSource({ resource: img });
        this.flairFrames = [];
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            this.flairFrames.push(new PIXI.Texture({
              source,
              frame: new PIXI.Rectangle(col * FLAIR_PITCH, row * FLAIR_PITCH, FLAIR_ICON_SIZE, FLAIR_ICON_SIZE),
            }));
          }
        }
        resolve();
      };
      // Missing/failed asset: flairs just never render, same "degrade
      // quietly" choice spriteAtlas.js's own onerror makes for a 404ing
      // texture sheet - not worth failing the whole boot sequence over.
      img.onerror = () => resolve();
      img.src = GAME_BASE_PATH + 'assets/sprites/flair.png';
    });
    return this._flairSheetPromise;
  },

  // (Re)points a player's flair sprite at their current flairIndex -
  // creates it, swaps its texture, or removes it as needed. Called once at
  // creation (drawPlayer below) and again on a live change (client/app.js's
  // player:flairChanged wiring).
  updatePlayerFlair(playerId) {
    const player = getPlayer(playerId);
    if (!player?.sprites?.info) return;

    if (player.flairIndex == null || !this.flairFrames?.[player.flairIndex]) {
      if (player.sprites.flairBadge) {
        player.sprites.info.removeChild(player.sprites.flairBadge);
        player.sprites.flairBadge.destroy();
        player.sprites.flairBadge = null;
      }
      return;
    }

    const tex = this.flairFrames[player.flairIndex];
    if (player.sprites.flairBadge) {
      player.sprites.flairBadge.texture = tex;
      return;
    }

    const badge = new PIXI.Sprite(tex);
    badge.anchor.set(0.5);
    // Centered above the name label (which sits bottom-anchored at -28,
    // ~15px tall) with enough clearance that the two don't overlap.
    badge.position.set(0, -48);
    player.sprites.info.addChild(badge);
    player.sprites.flairBadge = badge;
  },

  drawPlayer(id) {
    const player = getPlayer(id);
    const ballId = player.team === 'red' ? 'redball' : 'blueball';
    const tex = this.sprites[ballId];
    if (!tex) return;

    // Root container - positioned each tick, never rotated.
    const container = new PIXI.Container();

    // Ball layer - rotation applied here.
    const ballContainer = new PIXI.Container();
    const actualBall = new PIXI.Sprite(tex);
    actualBall.anchor.set(0.5);
    ballContainer.addChild(actualBall);
    container.addChild(ballContainer);

    // Aura layer - powerup attachments, sits in the never-rotated root
    // container on top of the ball so each aura's own animation controls
    // its rotation independent of facing.
    const auraLayer = new PIXI.Container();
    container.addChild(auraLayer);

    // Info layer - flag/pup icons, never rotates.
    const infoContainer = new PIXI.Container();
    const flagLayer = new PIXI.Container();
    flagLayer.position.set(13, -32);
    infoContainer.addChild(flagLayer);

    const pupLayer = new PIXI.Container();
    pupLayer.position.set(0, 30);
    infoContainer.addChild(pupLayer);

    // Name label - set once at creation since a player's name never
    // changes mid-life (a team switch kills and recreates the whole
    // player, same as the ball's team color above). Styled to match real
    // TagPro's own name rendering (tagpro.js's veryPrettyText): bold 11px
    // Arial, black stroke, a soft drop shadow, and TagPro's own
    // verified-account green (0xBFFF00) in place of white for an authed
    // player - the same signal local/menu.js's roster rows already use.
    const nameText = new PIXI.Text({
      text: player.name,
      style: {
        fontFamily: 'Arial',
        fontSize: 11,
        fontWeight: 'bold',
        fill: player.authed ? 0xbfff00 : 0xffffff,
        stroke: { color: 0x000000, width: 2 },
        dropShadow: { color: 0x000000, alpha: 0.8, angle: 0, blur: 3, distance: 0 },
        align: 'center',
      },
    });
    nameText.anchor.set(0.5, 1);
    nameText.position.set(0, -28);
    infoContainer.addChild(nameText);

    container.addChildAt(infoContainer, 0);

    // Selection ring for edit-mode multi-select - hidden by default.
    const selectionRing = new PIXI.Graphics();
    selectionRing.lineStyle(3, 0xffee55);
    selectionRing.drawCircle(0, 0, GRID_SIZE * 0.7);
    selectionRing.visible = false;
    container.addChildAt(selectionRing, 0);

    this.getLayer('players').addChild(container);

    player.container         = container;
    player.sprites           = player.sprites ?? {};
    player.sprites.ball      = ballContainer;
    player.sprites.actualBall = actualBall;
    player.sprites.info      = infoContainer;
    player.sprites.flagLayer = flagLayer;
    player.sprites.pupLayer  = pupLayer;
    player.sprites.auraLayer = auraLayer;
    player.sprites.selectionRing = selectionRing;
    player.sprites.nameText  = nameText;

    this.updatePlayerFlair(player.id);

    return container;
  },

  // Re-point every live player's ball sprite and powerup icons at the
  // current atlas - called after refreshTileTextures rebuilds this.sprites
  // (the old Texture objects keep rendering the old atlas canvas forever,
  // so without this a global ball/icon texture change only showed on
  // players created after the change).
  refreshPlayerTextures() {
    const PUP_ICON_TILE_IDS = { jj: 6.1, rb: 6.2, tp: 6.3 };
    for (const player of game.players) {
      if (!player.sprites) continue;

      const ballTex = this.sprites[player.team === 'red' ? 'redball' : 'blueball'];
      const ball = player.sprites.actualBall;
      if (ballTex && ball && !ball.destroyed) ball.texture = ballTex;

      for (const key of Object.keys(player.pupIcons || {})) {
        const icon = player.pupIcons[key];
        const tex = this.sprites[PUP_ICON_TILE_IDS[key]];
        if (tex && icon && !icon.destroyed) icon.texture = tex;
      }
    }
  },

  // Called whenever game.selectedPlayerIds changes, not per-frame.
  updateSelectionHighlight(selectedIds) {
    for (const player of game.players) {
      if (player.sprites?.selectionRing) {
        player.sprites.selectionRing.visible = selectedIds.indexOf(player.id) !== -1;
      }
    }
  },

  attachFlag(playerId, flagId) {
    const player = getPlayer(playerId);
    if (!player?.sprites?.flagLayer) return;

    this.detachFlag(playerId);

    const carriedId = CARRIED_FLAG_IDS[flagId];
    const tex = (carriedId !== undefined && this.sprites[carriedId]) || this.sprites[flagId];
    if (!tex) return;

    const flag = new PIXI.Sprite(tex);
    flag.anchor.set(0.5);
    player.sprites.flagLayer.addChild(flag);
    player.flagSprite = flag;
  },

  detachFlag(playerId) {
    const player = getPlayer(playerId);
    if (!player?.flagSprite) return;
    player.sprites.flagLayer.removeChild(player.flagSprite);
    player.flagSprite.destroy();
    player.flagSprite = null;
  },

  // Powerup status icons (juke juice / rolling bomb / tagpro) - up to three
  // at once, each with a stable key, laid out left-to-right as they come
  // and go.
  setPupIcon(playerId, key, tileId, active) {
    const player = getPlayer(playerId);
    if (!player?.sprites?.pupLayer) return;
    player.pupIcons = player.pupIcons ?? {};

    if (!active) {
      const icon = player.pupIcons[key];
      if (icon) {
        player.sprites.pupLayer.removeChild(icon);
        icon.destroy();
        delete player.pupIcons[key];
        this.layoutPupIcons(player);
      }
      return;
    }

    if (player.pupIcons[key]) return;

    const tex = this.sprites[tileId];
    if (!tex) return;

    const icon = new PIXI.Sprite(tex);
    icon.anchor.set(0.5);
    icon.scale.set(0.45);
    player.sprites.pupLayer.addChild(icon);
    player.pupIcons[key] = icon;
    this.layoutPupIcons(player);
  },

  layoutPupIcons(player) {
    const keys = Object.keys(player.pupIcons);
    const spacing = 16;
    keys.forEach((key, i) => {
      player.pupIcons[key].position.set((i - (keys.length - 1) / 2) * spacing, 0);
    });
  },

  // Static shape drawn behind a powerup's particle emitter.
  drawPupBase(key) {
    const radius = GRID_SIZE / 2;

    if (key === 'tp') {
      const gfx = new PIXI.Graphics();
      gfx.beginFill(0x00ff00, 0.25);
      gfx.lineStyle(2, 0x00ff00);
      gfx.drawCircle(0, 0, radius);
      gfx.endFill();
      return gfx;
    }

    if (key === 'rb') {
      const gfx = new PIXI.Graphics();
      gfx.beginFill(0xffff00, 0.75);
      gfx.drawCircle(0, 0, radius - 1);
      gfx.endFill();
      return gfx;
    }

    return null;
  },

  // Standing emitter plus (for some powerups) a static base shape, both
  // parented to the player's auraLayer so they ride along with the ball.
  setPupAura(playerId, key, active) {
    const player = getPlayer(playerId);
    if (!player?.sprites?.auraLayer) return;
    player.auraEmitters = player.auraEmitters ?? {};
    player.auraBases    = player.auraBases    ?? {};

    if (!active) {
      const emitter = player.auraEmitters[key];
      if (emitter) { emitter.stop(); delete player.auraEmitters[key]; }

      const base = player.auraBases[key];
      if (base) {
        player.sprites.auraLayer.removeChild(base);
        base.destroy();
        delete player.auraBases[key];
      }
      return;
    }

    // Rolling bomb's particles are gated separately (setBombParticles) so
    // they only run in the last few seconds before it goes off - only the
    // flashing base shape follows the plain active/inactive toggle here.
    if (key !== 'rb' && !player.auraEmitters[key]) {
      const config = AURA_CONFIGS[key];
      if (config) player.auraEmitters[key] = particleSystem.createEmitter(player.sprites.auraLayer, config);
    }

    if (!player.auraBases[key]) {
      const base = this.drawPupBase(key);
      if (base) {
        player.sprites.auraLayer.addChild(base);
        player.auraBases[key] = base;
      }
    }
  },

  // A small solid dot at the ball's center marking whoever's currently
  // first in line for the KOTH pad they're contesting.
  setKothLeader(playerId, active) {
    const player = getPlayer(playerId);
    if (!player?.container) return;

    if (!active) {
      if (player.kothLeaderDot) {
        player.container.removeChild(player.kothLeaderDot);
        player.kothLeaderDot.destroy();
        player.kothLeaderDot = null;
      }
      return;
    }

    if (player.kothLeaderDot) return;

    const dot = new PIXI.Graphics();
    dot.beginFill(0x00ff00);
    dot.drawCircle(0, 0, 3);
    dot.endFill();
    player.container.addChild(dot);
    player.kothLeaderDot = dot;
  },

  // Rolling bomb's own emitter toggle, independent of setPupAura's active/
  // inactive switch - scheduled shortly before it detonates.
  setBombParticles(playerId, active) {
    const player = getPlayer(playerId);
    if (!player?.sprites?.auraLayer) return;
    player.auraEmitters = player.auraEmitters ?? {};

    if (!active) {
      const emitter = player.auraEmitters.rb;
      if (emitter) { emitter.stop(); delete player.auraEmitters.rb; }
      return;
    }

    if (!player.auraEmitters.rb) {
      player.auraEmitters.rb = particleSystem.createEmitter(player.sprites.auraLayer, AURA_CONFIGS.rb);
    }
  },

  // Hard-stops every powerup emitter/base a player has running - called
  // right before their container is destroyed.
  clearPupAuras(playerId) {
    const player = getPlayer(playerId);
    if (player?.auraEmitters) {
      for (const emitter of Object.values(player.auraEmitters)) emitter.destroy();
      player.auraEmitters = {};
    }
    if (player?.auraBases) {
      for (const base of Object.values(player.auraBases)) base.destroy();
      player.auraBases = {};
    }
  },

  // One-shot radial burst - used for a death pop. Lives in world space, not
  // a player's auraLayer, since the position should stay put after respawn.
  spawnBurst(x, y, color, count) {
    const layer  = this.getLayer('particles');
    const config = particleConfigs.death(color);
    config.maxParticles = count;
    config.pos = { x: x * GRID_SIZE, y: y * GRID_SIZE };
    particleSystem.createEmitter(layer, config);
  },

  // Translucent hint of what an empty powerup pad will turn into next.
  // previewId == null just clears it.
  setPupPreview(x, y, previewId) {
    const entry = game.dataMap[y]?.[x];
    if (!entry) return;

    if (entry.previewSprite) {
      entry.previewSprite.destroy();
      entry.previewSprite = null;
    }
    if (previewId == null) return;

    const sd  = this.renderLookup[previewId];
    const tex = this.sprites[previewId];
    if (!sd || !tex) return;

    const preview = new PIXI.Sprite(tex);
    preview.alpha = 0.35;
    preview.x = x * GRID_SIZE;
    preview.y = y * GRID_SIZE;
    this.getLayer(sd.layer).addChild(preview);
    entry.previewSprite = preview;
  },
});
