(function () {
const { applyPartial } = (typeof require === 'function') ? require('./settingsSchema') : globalThis.SettingsSchema;

const DEFAULT_SETTINGS = {
  timeLimit:         5 * 60 * 1000, // ms, required
  scoreLimit:        3,             // integer or null
  overtimeEnabled:   true,
  mercyRule:         null,          // integer or null
  countdownDuration: 5000,          // ms
};

function createDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function validateSettings(partial, current) {
  return applyPartial(partial, current ?? DEFAULT_SETTINGS, { allowKey: e => e.scope === 'match' });
}

var MatchSettings = { createDefaultSettings, validateSettings, DEFAULT_SETTINGS };
if (typeof module !== 'undefined' && module.exports) module.exports = MatchSettings;
if (typeof globalThis !== 'undefined') globalThis.MatchSettings = MatchSettings;

})();
