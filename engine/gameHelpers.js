(function () {
const { tileSetting: resolveTileSetting } = (typeof require === 'function') ? require('./settingsResolver') : globalThis.SettingsResolver;
var createPlayerLifecycle = (typeof require === 'function') ? require('./playerLifecycle') : globalThis.createPlayerLifecycle;
var createFlagLogic       = (typeof require === 'function') ? require('./flagLogic') : globalThis.createFlagLogic;
var createPowerupSpawner  = (typeof require === 'function') ? require('./powerupSpawner') : globalThis.createPowerupSpawner;
var createTeamTiles       = (typeof require === 'function') ? require('./teamTiles') : globalThis.createTeamTiles;
var createGateLogic       = (typeof require === 'function') ? require('./gateLogic') : globalThis.createGateLogic;
var Eggball = (typeof require === 'function') ? require('./eggball') : globalThis.Eggball;

// The single gameHelpers object every other module calls into is composed
// here from domain modules (CODEBASE_AUDIT.md: playerLifecycle.js,
// flagLogic.js, powerupSpawner.js, teamTiles.js, gateLogic.js) plus the
// handful of primitives (tileSetting, the tile-timer registry,
// scheduleTileChange) genuinely shared across all of them. Every method in
// every domain module calls siblings through `this.` rather than a direct
// reference, so merging flat like this is what makes `this.scheduleTimeout`
// inside powerupSpawner.js, `this.returnFlag` inside playerLifecycle.js,
// etc resolve correctly - `this` is always the one merged object below,
// never the partial one an individual factory returned.
var createGameHelpers = function(gameState, physicsHelpers, physicsWorld, config, emitter) {
  // Every pending tile timer (boost/bomb cooldowns, powerup respawns, gate
  // sticky timers) lives here so a match start/reset can cancel them all.
  const tileTimers = new Set();

  const core = {
    // A tile-scoped setting's effective value at one cell: the leader's
    // per-tile override (DO-NEXT-013, gameState.tileOverrides) if one
    // exists, else the room-wide config value. Thin wrapper so every other
    // call site can keep calling `this.tileSetting(...)`.
    tileSetting(x, y, settingKey) {
      return resolveTileSetting(gameState, config, x, y, settingKey);
    },

    // Tracked replacement for setTimeout. Anything that will change a tile
    // later must be scheduled through this, or resetElements can't stop it.
    scheduleTimeout(fn, delay) {
      const handle = setTimeout(() => {
        tileTimers.delete(handle);
        fn();
      }, delay);
      tileTimers.add(handle);
      return handle;
    },

    cancelTimeout(handle) {
      if (!handle) return;
      clearTimeout(handle);
      tileTimers.delete(handle);
    },

    clearTileTimers() {
      for (const handle of tileTimers) {
        clearTimeout(handle);
      }
      tileTimers.clear();
    },

    // Returns the pending promise so a caller that needs to look at the
    // tile's *new* entry afterward (e.g. arming a spawn on the pad it just
    // emptied) can sequence off the actual rebuild instead of reading the
    // stale pre-change entry object in the same tick.
    scheduleTileChange(x, y, newId = 0) {
      return Promise.resolve().then(() => emitter.emit('setTile', x, y, newId));
    },
  };

  return Object.assign(
    core,
    createPlayerLifecycle(gameState, physicsHelpers, physicsWorld, config, emitter),
    createFlagLogic(gameState, config, emitter),
    createPowerupSpawner(gameState, physicsHelpers, config, emitter),
    createTeamTiles(),
    createGateLogic(gameState, physicsHelpers, config, emitter),
    Eggball.createEggballLogic(gameState, physicsWorld, config, emitter),
  );
};

if (typeof module !== 'undefined' && module.exports) module.exports = createGameHelpers;
if (typeof globalThis !== 'undefined') globalThis.createGameHelpers = createGameHelpers;

})();
