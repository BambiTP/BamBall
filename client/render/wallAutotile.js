// wallAutotile.js - the wall auto-tiling bitmask algorithm, extracted out
// of the core renderer (it's real corner-selection geometry, not drawing
// per se). Per quadrant of a wall cell, examines up to 4 neighboring cells'
// solid masks (WALL_SOLIDS, renderData.js) to pick the correct auto-tile
// corner frame via quadrantCoords' key->pixel-offset table.

Object.assign(Renderer.prototype, {

  wallSolidsAt(col, row) {
    const tile = game.wallMap?.[row]?.[col];
    return WALL_SOLIDS[tile] ?? 0;
  },

  // The pure geometry half of the autotiler: which corner frame goes at
  // which pixel offset for this cell, given the current neighbor masks.
  // Split out from drawWallTile so a per-cell wall texture override can
  // redraw the exact same quadrants from a different sheet.
  wallQuadrantPlacements(col, row) {
    const solids = this.wallSolidsAt(col, row);
    if (!solids) return [];

    const HALF = GRID_SIZE / 2;
    const placements = [];

    for (let q = 0; q < 4; q++) {
      const mask = (solids >> (q << 1)) & 3;
      if (!mask) continue;

      const cx = col + ((q & 2) === 0 ? 1 : 0);
      const cy = row + (((q + 1) & 2) === 0 ? 0 : 1);

      let around =
        (this.wallSolidsAt(cx,     cy)     & 0xc0) |
        (this.wallSolidsAt(cx - 1, cy)     & 0x03) |
        (this.wallSolidsAt(cx - 1, cy - 1) & 0x0c) |
        (this.wallSolidsAt(cx,     cy - 1) & 0x30);
      around |= (around << 8);

      const start = q * 2 + 1;
      let cw = 0; while (cw < 8 && (around & (1 << (start + cw))))     cw++;
      let cc = 0; while (cc < 8 && (around & (1 << (start + 7 - cc)))) cc++;

      const hasChip    = mask === 3 && (((solids | (solids << 8)) >> ((q + 2) << 1)) & 3) === 0;
      const solidEnd   = cw === 8 ? 0 : (start + cw + 4) % 8;
      const solidStart = cw === 8 ? 0 : (start - cc + 12) % 8;

      const key = `${q}${solidStart}${solidEnd}${hasChip ? 'd' : ''}`;

      let dx = col * GRID_SIZE;
      let dy = row * GRID_SIZE;
      if      (q === 0) { dx += HALF; }
      else if (q === 1) { dx += HALF; dy += HALF; }
      else if (q === 2) { dy += HALF; }

      placements.push({ key, dx, dy });
    }

    return placements;
  },

  drawWallTile(col, row) {
    const placements = this.wallQuadrantPlacements(col, row);
    if (!placements.length) return;

    for (const { key, dx, dy } of placements) {
      const tex = this.sprites[key] ?? this.sprites['000'];
      if (!tex) continue;

      const sprite = new PIXI.Sprite(tex);
      sprite.x = dx;
      sprite.y = dy;
      this.getLayer('background').addChild(sprite);
    }
  },
});
