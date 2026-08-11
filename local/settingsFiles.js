// settingsFiles.js - leader tooling: load a settings file (JSON, same
// { physics?, match? } shape game/officialPresets.js's curated presets
// already use) and apply it, with two slots - one for pregame (warm-up)
// and one for the real game. Confirmed requirement: upload works the same
// way whether the host is this browser tab or (once web/host-cli exists)
// a terminal process reading the file from disk instead of a
// <input type="file">. Recording itself is automatic-only (starts when a
// match goes live, see localTransport.js) - no manual pregame recording UI.
//
// "Leader" doesn't distinguish anyone yet in this solo build - there's
// only one player, so they always have the controls. Once P2P lands and
// a real leader role exists, this panel is what gates behind it.

function initSettingsFilesUI() {
  var pregameSettings = null; // parsed { mapFile?, physics?, match? }, applied immediately + on every re-entry to pregame
  var gameSettings     = null; // applied the moment the match goes live

  function readJsonFile(fileInput) {
    var file = fileInput.files[0];
    if (!file) return Promise.reject(new Error('no file chosen'));
    return file.text().then(function (text) { return JSON.parse(text); });
  }

  // Same shape+validation path a curated officialPresets.js entry goes
  // through - matchManager.updatePhysics/updateSettings both throw on an
  // unknown/invalid key, so a malformed file fails loudly rather than
  // silently applying half of itself.
  function applySettings(parsed) {
    // gameInstance() is null for a P2P peer (only the host runs the real
    // engine) - a peer has nothing to apply settings to locally, same as
    // how a non-leader client couldn't touch these in the original game.
    if (!activeTransport.gameInstance()) return;
    var apply = function () {
      var gi = activeTransport.gameInstance();
      if (parsed.physics) gi.matchManager.updatePhysics(parsed.physics);
      if (parsed.match)   gi.matchManager.updateSettings(parsed.match);
    };
    if (parsed.mapFile) activeTransport.switchMap(parsed.mapFile).then(apply);
    else apply();
  }

  function wireFileSlot(inputId, statusId, onLoaded) {
    var input  = document.getElementById(inputId);
    var status = document.getElementById(statusId);
    if (!input) return;
    input.addEventListener('change', function () {
      readJsonFile(input).then(function (parsed) {
        onLoaded(parsed);
        if (status) status.textContent = 'Loaded: ' + input.files[0].name;
      }).catch(function (err) {
        if (status) status.textContent = 'Failed to load: ' + err.message;
      });
    });
  }

  wireFileSlot('pregameSettingsFile', 'pregameSettingsStatus', function (parsed) {
    pregameSettings = parsed;
    if (activeTransport.matchState() === 'pregame') applySettings(pregameSettings);
  });

  wireFileSlot('gameSettingsFile', 'gameSettingsStatus', function (parsed) {
    gameSettings = parsed;
  });

  // Game settings apply the instant a match actually goes live - not on
  // countdown, so a leader's file can still differ from pregame's values
  // for the whole countdown window if they want a visible transition.
  appEvents.on('matchStateApplied', function (state) {
    if (state === 'live' && gameSettings) applySettings(gameSettings);
    if (state === 'pregame' && pregameSettings) applySettings(pregameSettings);
  });
}
