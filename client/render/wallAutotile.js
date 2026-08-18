// wallAutotile.js - the wall auto-tiling bitmask algorithm. Per quadrant of
// a wall cell, examines up to 4 neighboring cells' solid masks (WALL_SOLIDS,
// renderData.js) to pick the correct auto-tile corner frame via
// quadrantCoords' key->pixel-offset table.
//
// wallSolidsAt/wallQuadrantPlacements are plain functions, not Renderer
// methods, and take wallMap explicitly rather than reading game.wallMap
// themselves - pure geometry over whatever wallMap it's handed, no live
// Renderer instance or current game needed to compute it. drawWallTile
// (below) is the only caller today, but nothing here assumes that.

function wallSolidsAt(wallMap, col, row) {
  const tile = wallMap?.[row]?.[col];
  return WALL_SOLIDS[tile] ?? 0;
}

// Which corner frame goes at which pixel offset for this cell, given the
// current neighbor masks. Split out from drawing so a per-cell wall
// texture override, or a detached thumbnail render, can redraw the exact
// same quadrants from a different sheet.
function wallQuadrantPlacements(wallMap, col, row) {
  const solids = wallSolidsAt(wallMap, col, row);
  if (!solids) return [];

  const HALF = GRID_SIZE / 2;
  const placements = [];

  for (let q = 0; q < 4; q++) {
    const mask = (solids >> (q << 1)) & 3;
    if (!mask) continue;

    const cx = col + ((q & 2) === 0 ? 1 : 0);
    const cy = row + (((q + 1) & 2) === 0 ? 0 : 1);

    let around =
      (wallSolidsAt(wallMap, cx,     cy)     & 0xc0) |
      (wallSolidsAt(wallMap, cx - 1, cy)     & 0x03) |
      (wallSolidsAt(wallMap, cx - 1, cy - 1) & 0x0c) |
      (wallSolidsAt(wallMap, cx,     cy - 1) & 0x30);
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
}

Object.assign(Renderer.prototype, {
  drawWallTile(col, row) {
    const placements = wallQuadrantPlacements(game.wallMap, col, row);
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
