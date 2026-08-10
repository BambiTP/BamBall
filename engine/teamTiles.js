(function () {
// Team-owned floor tiles that buff whoever's standing on them. Split out of
// gameHelpers.js (CODEBASE_AUDIT.md) - addModifier/tileSetting are shared
// primitives (playerLifecycle.js / gameHelpers.js) reached here via `this.`
// since the merged gameHelpers object is what every call site calls through.
var createTeamTiles = function() {
  return {
    // Overlapping team tiles: each cell the player currently stands on is
    // tracked individually (not just a count) so leaving one tile can
    // recompute the modifier from whichever tile(s) are still active,
    // instead of only clearing it when the overlap count happens to hit
    // zero. Most recently entered (still active) tile's values win, same
    // semantics as before - a Map preserves that insertion order.
    addTeamTile(player, tile) {
      player.activeTeamTiles.set(`${tile.x},${tile.y}`, {
        accel:    this.tileSetting(tile.x, tile.y, 'teamTileAccel'),
        maxSpeed: this.tileSetting(tile.x, tile.y, 'teamTileMaxSpeed'),
      });
      this.recomputeTeamTileModifier(player);
    },

    removeTeamTile(player, tile) {
      player.activeTeamTiles.delete(`${tile.x},${tile.y}`);
      this.recomputeTeamTileModifier(player);
    },

    recomputeTeamTileModifier(player) {
      if (!player.activeTeamTiles.size) {
        this.removeModifier(player, 'teamTile');
        return;
      }
      const stats = [...player.activeTeamTiles.values()].pop();
      this.addModifier(player, 'teamTile', stats);
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createTeamTiles;
if (typeof globalThis !== 'undefined') globalThis.createTeamTiles = createTeamTiles;

})();
