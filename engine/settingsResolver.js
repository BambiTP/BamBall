(function () {
// The one place "this scope's effective setting value" is resolved: a
// leader's override for that scope wins, else the room-wide config default.
// No dependency on gameHelpers/physicsHelpers so anything in the require
// order - including modules instantiated before gameHelpers - can use it
// directly instead of re-implementing the fallback.

function tileSetting(gameState, config, x, y, key) {
  const overrides = gameState.tileOverrides[`${x},${y}`];
  return overrides?.[key] ?? config[key];
}

function playerSetting(player, config, key) {
  return player?.overrides[key] ?? config[key];
}

var SettingsResolver = { tileSetting, playerSetting };
if (typeof module !== 'undefined' && module.exports) module.exports = SettingsResolver;
if (typeof globalThis !== 'undefined') globalThis.SettingsResolver = SettingsResolver;

})();
