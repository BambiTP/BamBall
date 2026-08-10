(function () {
// powerupTypes.js - single source of truth for every powerup pad type: its
// tile id and the group-setting key that turns it on/off. gameHelpers (spawn
// selection) and tileLogic (pickup gating) both read this one table instead
// of hardcoding per-powerup checks, so adding a new toggleable powerup is a
// one-line addition here.
var PowerupTypes = [
  { id: 6.1, configKey: 'jukeJuiceEnabled' },
  { id: 6.2, configKey: 'rollingBombEnabled' },
  { id: 6.3, configKey: 'tagproEnabled' },
];
if (typeof module !== 'undefined' && module.exports) module.exports = PowerupTypes;
if (typeof globalThis !== 'undefined') globalThis.PowerupTypes = PowerupTypes;

})();
