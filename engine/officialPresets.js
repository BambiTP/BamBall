(function () {
// officialPresets.js - the curated, code-shipped preset list for the
// Presets tab's "Official Presets" sub-tab. Unlike a user's own presets
// (server/db.js `presets` table, per-account), these belong to nobody and
// live in source control - not deletable/publishable/toggleable through
// the API, just a fixed list every room can apply. Add a new one here and
// it ships to everyone on next deploy, no migration needed.
//
// `settings` uses the same { physics?, match?, mapId? } shape a saved user
// preset does, and gets applied the exact same way (replayed through
// update_physics/update_settings/changeMap) - so a bad value here fails the
// same validation a leader's own manual edit would, not a special case.

const OFFICIAL_PRESETS = [
  {
    id:   'official-standard',
    name: 'Standard',
    settings: {
      match: {
        timeLimit:         10 * 60 * 1000,
        scoreLimit:        3,
        overtimeEnabled:   true,
        mercyRule:         null,
        countdownDuration: 5000,
      },
    },
  },
  {
    id:   'official-quick-match',
    name: 'Quick Match',
    settings: {
      match: {
        timeLimit:         5 * 60 * 1000,
        scoreLimit:        2,
        overtimeEnabled:   true,
        mercyRule:         null,
        countdownDuration: 3000,
      },
    },
  },
  {
    id:   'official-marathon',
    name: 'Marathon',
    settings: {
      match: {
        timeLimit:         20 * 60 * 1000,
        scoreLimit:        null,
        overtimeEnabled:   false,
        mercyRule:         null,
        countdownDuration: 5000,
      },
    },
  },
];

var OfficialPresets = { OFFICIAL_PRESETS };
if (typeof module !== 'undefined' && module.exports) module.exports = OfficialPresets;
if (typeof globalThis !== 'undefined') globalThis.OfficialPresets = OfficialPresets;

})();
