(function () {
// customTileActions.js - runs the action list a leader attached to one of
// their custom tiles (server/db.js custom_tiles.actions) against whichever
// player touched it. Called from tileLogic.js's playerBegin dispatch,
// alongside (not instead of) the hardcoded name-string handlers - a custom
// tile's numeric id never collides with a curated one, so both paths are
// safe to run unconditionally.
//
// Every runner takes (player, action, tile) and is responsible for its own
// action's full effect - same one-function-per-behavior convention
// tileHandlers.js already uses for curated tiles.

var createCustomTileActions = function createCustomTileActions(gameState, gameHelpers, physicsHelpers, physicsWorld, emitter) {
  const RUNNERS = {
    teleport(player, action) {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) return;
      physicsHelpers.teleportPlayer(player, action.x, action.y);
    },

    impulse(player, action) {
      if (!player.body) return;
      const strength = Number.isFinite(action.strength) ? action.strength : 1;
      const dx = Number.isFinite(action.dx) ? action.dx : 0;
      const dy = Number.isFinite(action.dy) ? action.dy : 0;
      physicsWorld.applyImpulse(player.body, dx * strength, dy * strength);
    },

    boost(player, action) {
      physicsHelpers.applyBoost(player, Number.isFinite(action.multiplier) ? action.multiplier : undefined);
    },

    freeze(player, action) {
      physicsHelpers.freezePlayer(player);
      const ms = Number(action.durationMs);
      if (ms > 0) {
        gameHelpers.scheduleTimeout(() => {
          if (gameState.players.includes(player)) physicsHelpers.unfreezePlayer(player);
        }, ms);
      }
    },

    pop(player) {
      emitter.emit('update', gameHelpers.popPlayer(player));
    },

    // Defaults to the tile's own cell - a leader can also target another
    // cell (e.g. a switch tile that opens a gate elsewhere).
    setTile(player, action, tile) {
      const x = Number.isInteger(action.x) ? action.x : tile.x;
      const y = Number.isInteger(action.y) ? action.y : tile.y;
      const id = Number.isFinite(action.id) ? action.id : 0;
      emitter.emit('setTile', x, y, id);
    },

    addScore(player, action) {
      const team = action.team === 'blue' ? 'blue' : 'red';
      const amount = Number.isFinite(action.amount) ? action.amount : 1;
      gameState.scores[team] += amount;
      emitter.emit('score', gameState.scores);
      // matchManager.checkCaptureWinConditions only listens for 'capture' -
      // without it, a custom scoring tile never enforces scoreLimit/mercyRule.
      emitter.emit('capture', player);
    },

    message(player, action) {
      const text = String(action.text ?? '').trim().slice(0, 300);
      if (text) emitter.emit('chat', { id: null, name: 'Tile', text });
    },
  };

  return {
    run(player, tile, actions) {
      for (const action of actions) {
        const runner = action && RUNNERS[action.type];
        if (runner) runner(player, action, tile);
      }
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createCustomTileActions;
if (typeof globalThis !== 'undefined') globalThis.createCustomTileActions = createCustomTileActions;

})();
