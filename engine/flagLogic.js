(function () {
// Flag pickup/return/transfer/capture. Split out of gameHelpers.js
// (CODEBASE_AUDIT.md) - scheduleTileChange is a shared primitive that lives
// on gameHelpers.js itself; these methods reach it via `this.` since the
// merged gameHelpers object is what every call site actually calls through.
var createFlagLogic = function(gameState, config, emitter) {
  return {
    pickupFlag(player, other) {
      // Synchronous claim: the tile's own 'taken' state only flips via a
      // deferred microtask (scheduleTileChange below), so two players
      // contacting the same flag sensor within one Box2D step would both
      // otherwise pass tileLogic's per-toucher !player.hasFlag guard and
      // both claim it. `other` is the live gameState.dataMap entry
      // (gameInstance.setTile always builds a fresh one on the next tile
      // change), so this flag can't leak onto a future flag spawn here.
      if (other.claimed) return;
      other.claimed = true;

      if (!gameState.map[other.y]) return;
      const id = gameState.map[other.y][other.x];
      player.hasFlag = { flagId: id, originX: other.x, originY: other.y };
      // Resolved once, here, off this flag's own cell - a leader can grant
      // a longer/shorter (or no) grace period per flag color/instance.
      // Baking "disabled" as an already-elapsed timestamp instead of a
      // separate flag means popPlayer only ever needs one check.
      const invulnEnabled = this.tileSetting(other.x, other.y, 'flagGrabInvulnEnabled');
      player.flagGrabInvulnUntil = invulnEnabled
        ? Date.now() + this.tileSetting(other.x, other.y, 'flagGrabInvulnMs')
        : 0;
      this.scheduleTileChange(other.x, other.y, id + 0.1);
    },

    returnFlag(player) {
      if (!player.hasFlag) return;
      const { flagId, originX, originY } = player.hasFlag;
      this.scheduleTileChange(originX, originY, flagId);
      player.hasFlag = false;
    },

    transferFlag(from, to) {
      to.hasFlag   = from.hasFlag;
      from.hasFlag = false;
    },

    // The capture itself (flag returns to base, 'capture' event) is emitted
    // by tiles/tileHandlers.js and happens in every room. What's conditional
    // is only the SCORE: an editor room keeps no score, so there is nothing
    // to increment and nothing to report.
    captureFlag(player) {
      this.returnFlag(player);
      if (gameState.mode === 'editor') return;

      gameState.scores[player.team]++;
      emitter.emit('score', gameState.scores);
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createFlagLogic;
if (typeof globalThis !== 'undefined') globalThis.createFlagLogic = createFlagLogic;

})();
