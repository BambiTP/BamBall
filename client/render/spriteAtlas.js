// spriteAtlas.js - fetches the packed sprite sheet + wall auto-tile sheet,
// crops every frame into one combined canvas atlas with an edge-extrusion
// pass, and refreshes it when the viewer's own texture pack changes.
//
// refreshTileTextures is sequence-guarded: two overlapping calls (e.g. two
// rapid personal texture-pack picks) used to have no ordering guard at all, so
// whichever network response happened to resolve last won even if it was
// for the OLDER edit - a leader's second, intended change could silently
// get reverted by a slow first response arriving late. A monotonic counter
// makes a stale response a no-op instead.

Object.assign(Renderer.prototype, {

  // imageMap: { packed: <url>, walls: <url> }. Fires every image load in
  // parallel - doesn't touch the manifest, so callers can race this against
  // the manifest fetch instead of waiting on one before starting the other.
  async fetchTextures(imageMap) {
    await Promise.all(Object.entries(imageMap).map(async ([key, url]) => {
      if (!url || this.spriteSheets[key]) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      // onerror must resolve too: a 404ing sheet URL used to leave this
      // promise pending forever, which hung the whole join sequence (black
      // screen) since bootAfterJoined awaits it. A failed sheet now just
      // leaves its slot empty - cacheAllFrames already skips missing ones.
      await new Promise(r => { img.onload = r; img.onerror = r; });
      if (img.naturalWidth) this.spriteSheets[key] = new PIXI.ImageSource({ resource: img });
    }));
  },

  // manifest: { tileId: {x, y, w, h}, ... } crop rects within the packed
  // sheet. Call after fetchTextures resolves.
  applyManifest(manifest) {
    this.spriteManifest = manifest;
    this.cacheAllFrames();
  },

  async refreshTileTextures(imageMap, manifest) {
    this._textureRefreshSeq = (this._textureRefreshSeq || 0) + 1;
    const mySeq = this._textureRefreshSeq;

    // Destroy, not just forget: these are the decoded source sheets, which
    // are uploaded to the GPU as-is. Dropping the reference left a full copy
    // of every superseded sheet resident for the session. Safe because
    // cacheAllFrames only ever reads them to blit into the atlas canvas - no
    // Texture handed out to the scene points at a sheet source directly.
    for (const key of ['packed', 'walls']) {
      if (this.spriteSheets[key]) this.spriteSheets[key].destroy();
      delete this.spriteSheets[key];
    }
    await this.fetchTextures(imageMap);

    // A newer refresh started (and possibly already finished) while this
    // one was in flight - applying this stale result now would revert
    // whatever the newer one already drew.
    if (mySeq !== this._textureRefreshSeq) return;

    this.applyManifest(manifest);
    this.redrawTiles();

    // Carried-flag icons aren't part of the tile atlas redraw above (they're
    // sprites parented to each player's flagLayer, not placed map tiles) -
    // re-attach for anyone currently carrying so a global-texture change
    // shows up immediately instead of only on the next pickup.
    for (const player of game.players) {
      if (player.hasFlag) this.attachFlag(player.id, player.flagId);
    }

    // Same story for ball sprites and powerup icons: they hold Texture
    // objects from the PREVIOUS atlas, which keeps rendering fine after a
    // rebuild - so a global ball/icon change only ever showed on players
    // created after it. Re-point them at the new atlas explicitly.
    this.refreshPlayerTextures();
  },

  // Arbitrary-URL texture load, cached by url - used for custom tile art
  // (server/api/customTiles.js, plain /tiles-custom/... paths that aren't
  // packed into the atlas).
  loadTextureFromUrl(url) {
    this.urlTextures = this.urlTextures || {};
    if (this.urlTextures[url]) return this.urlTextures[url];

    const promise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(new PIXI.Texture({ source: new PIXI.ImageSource({ resource: img }) }));
      img.onerror = () => { delete this.urlTextures[url]; resolve(null); };
      img.src = url;
    });
    this.urlTextures[url] = promise;
    return promise;
  },

  // A placeholder texture for a custom tile with no uploaded art yet -
  // a plain colored square so it's still visible/paintable in the palette
  // and on the map before the leader gets around to art. Cached per tile id
  // since the color is derived from it (deterministic, not random, so a
  // reload doesn't visually reshuffle every custom tile on the map).
  placeholderTexture(id) {
    this.placeholders = this.placeholders || {};
    if (this.placeholders[id]) return this.placeholders[id];

    const hue = (Number(id) * 47) % 360;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = GRID_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${hue}, 55%, 45%)`;
    ctx.fillRect(2, 2, GRID_SIZE - 4, GRID_SIZE - 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, GRID_SIZE - 4, GRID_SIZE - 4);

    const tex = new PIXI.Texture({ source: new PIXI.ImageSource({ resource: canvas }) });
    this.placeholders[id] = tex;
    return tex;
  },

  // Registers/updates one custom tile's client-side draw metadata
  // (renderLookup, normally a static renderData.js entry - these ids are
  // dynamic, so they're added here instead) and texture, then redraws every
  // cell on the current map that's already painted with it. Called from
  // app/packetApplier.js on customTileCatalog/customTileUpsert.
  applyCustomTileDef(tile) {
    this.renderLookup[tile.id] = {
      id: tile.id, name: tile.name, image: null, x: null, y: null,
      size: tile.size || 40,
      layer: tile.sensor ? 'dynamic' : 'background',
      hasBackground: true,
    };

    const redraw = () => {
      if (!game.dataMap) return;
      for (let y = 0; y < game.dataMap.length; y++) {
        for (let x = 0; x < game.dataMap[y].length; x++) {
          if (game.dataMap[y][x] && game.dataMap[y][x].id === tile.id) this.changeTile(x, y, tile.id);
        }
      }
    };

    if (!tile.spriteUrl) {
      this.sprites[tile.id] = this.placeholderTexture(tile.id);
      redraw();
      return;
    }

    this.loadTextureFromUrl(tile.spriteUrl).then((tex) => {
      this.sprites[tile.id] = tex || this.placeholderTexture(tile.id);
      redraw();
    });
  },

  // Counterpart to applyCustomTileDef, called from app/packetApplier.js on
  // customTileDeleted. Drops the render metadata/texture for a deleted
  // custom tile - already-painted cells keep their last rendered look until
  // repainted (see game/gameInstance.js's registerCustomTile/setTile), this
  // just stops this id from being confused with a future tile that reuses
  // it and frees the texture.
  removeCustomTileDef(id) {
    delete this.renderLookup[id];
    delete this.sprites[id];
  },

  cacheAllFrames() {
    const PAD = 2;

    const entries = [];

    const packedSource = this.spriteSheets['packed'];
    if (packedSource && this.spriteManifest) {
      for (const [tileId, rect] of Object.entries(this.spriteManifest)) {
        entries.push({ id: tileId, source: packedSource, sx: rect.x, sy: rect.y, w: rect.w, h: rect.h });
      }
    }

    // Wall corners: not a packed tile (db.WALLS_TILE_ID) - quadrantCoords
    // still indexes pixel offsets into the full auto-tile sheet directly.
    const wallsSource = this.spriteSheets['walls'];
    if (wallsSource) {
      const HALF = GRID_SIZE / 2;
      for (const [key, [col, row]] of Object.entries(quadrantCoords)) {
        entries.push({ id: key, source: wallsSource, sx: col * GRID_SIZE, sy: row * GRID_SIZE, w: HALF, h: HALF });
      }
    }

    // The cell has to fit the LARGEST frame, not one tile. Sprites are not
    // all 40x40 - marsBall is natively 80x80 - and a fixed 44px cell meant
    // an 80px frame drew straight over its neighbours in this canvas, which
    // is what made big sprites come out mangled.
    const maxSide = entries.reduce((max, e) => Math.max(max, e.w, e.h), GRID_SIZE);
    const CELL    = maxSide + PAD * 2;

    const columns = Math.ceil(Math.sqrt(entries.length));
    const rows    = Math.ceil(entries.length / columns);

    const atlasCanvas  = document.createElement('canvas');
    atlasCanvas.width  = columns * CELL;
    atlasCanvas.height = rows * CELL;
    const ctx = atlasCanvas.getContext('2d');

    entries.forEach((entry, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      entry.dx  = col * CELL + PAD;
      entry.dy  = row * CELL + PAD;
      ctx.drawImage(entry.source.resource, entry.sx, entry.sy, entry.w, entry.h, entry.dx, entry.dy, entry.w, entry.h);
    });

    // Extrusion pass: bleed each entry's own edge pixels outward into its
    // padding ring, so non-integer camera positions don't sample across the
    // frame boundary into transparent padding (flickering translucent
    // fringe). Second pass so every entry is fully drawn first.
    entries.forEach((entry) => {
      const { dx, dy, w, h } = entry;
      for (let i = 1; i <= PAD; i++) {
        ctx.drawImage(atlasCanvas, dx, dy,         w, 1, dx,     dy - i,         w, 1); // top
        ctx.drawImage(atlasCanvas, dx, dy + h - 1, w, 1, dx,     dy + h - 1 + i, w, 1); // bottom
        ctx.drawImage(atlasCanvas, dx, dy,         1, h, dx - i, dy,             1, h); // left
        ctx.drawImage(atlasCanvas, dx + w - 1, dy, 1, h, dx + w - 1 + i, dy,     1, h); // right
      }
      for (let iy = 1; iy <= PAD; iy++) {
        for (let ix = 1; ix <= PAD; ix++) {
          ctx.drawImage(atlasCanvas, dx,         dy,         1, 1, dx - ix,         dy - iy,         1, 1);
          ctx.drawImage(atlasCanvas, dx + w - 1, dy,         1, 1, dx + w - 1 + ix, dy - iy,         1, 1);
          ctx.drawImage(atlasCanvas, dx,         dy + h - 1, 1, 1, dx - ix,         dy + h - 1 + iy, 1, 1);
          ctx.drawImage(atlasCanvas, dx + w - 1, dy + h - 1, 1, 1, dx + w - 1 + ix, dy + h - 1 + iy, 1, 1);
        }
      }
    });

    const previousAtlas   = this.tileAtlasSource;
    const previousSprites = this.sprites;

    this.tileAtlasSource = new PIXI.ImageSource({ resource: atlasCanvas });

    this.sprites = {};
    for (const entry of entries) {
      this.sprites[entry.id] = new PIXI.Texture({
        source: this.tileAtlasSource,
        frame: new PIXI.Rectangle(entry.dx, entry.dy, entry.w, entry.h),
      });
    }

    // Release the atlas this one replaces. Every texture-pack change rebuilds
    // the atlas, and the old canvas-backed texture stayed resident on the GPU
    // for the rest of the session otherwise. Only frames cut from the OLD
    // atlas are destroyed - this.sprites also holds custom-tile and
    // placeholder textures with their own independent sources, and those are
    // cached elsewhere (urlTextures/placeholders) and reused as-is.
    for (const texture of Object.values(previousSprites || {})) {
      if (texture && texture.source === previousAtlas && !texture.destroyed) texture.destroy();
    }
    if (previousAtlas) previousAtlas.destroy();
  },
});
