// localSettings.js - per-user client settings (keybinds, particles toggle,
// drawing-overlay visibility). These follow the person, not the room -
// never sent into the game simulation. Two-layer persistence: localStorage
// always, account sync (debounced) when logged in, with the account copy
// winning on page load (see CLIENT_REWRITE_GUIDE.md §1.12 - no timestamps,
// no per-key merge, deliberately dumb).
//
// Zoom is NOT here: it's gameplay visibility, owned by the leader-set
// cameraZoom in settingsState.js. See CLIENT_REWRITE_GUIDE.md §1.5.

var localSettingsEvents = createEventBus();

var LOCAL_SETTINGS_DEFAULTS = {
  keys: {
    up:       ['w', 'ArrowUp'],
    down:     ['s', 'ArrowDown'],
    left:     ['a', 'ArrowLeft'],
    right:    ['d', 'ArrowRight'],
    detonate: [' '],
    chat:     ['Enter'],
    menu:     ['Escape'],
    zoomIn:   ['=', '+'],
    zoomOut:  ['-'],
    pause:    [], // unbound by default - opt-in, leader-only in practice (server rejects it for anyone else)
  },
  particles:    true,
  showDrawings: true,
};

var LOCAL_SETTINGS_STORAGE_KEY = 'grabtag_settings';

// Validated merge over the defaults: unknown keys dropped, missing/wrong-
// typed keys fall back - an old or corrupt saved blob never breaks a newer
// client.
function mergeLocalSettings(stored) {
  var merged = {
    keys: {},
    particles:    LOCAL_SETTINGS_DEFAULTS.particles,
    showDrawings: LOCAL_SETTINGS_DEFAULTS.showDrawings,
  };

  var action;
  for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
    merged.keys[action] = LOCAL_SETTINGS_DEFAULTS.keys[action].slice();
  }

  if (!stored || typeof stored !== 'object') return merged;

  if (stored.keys && typeof stored.keys === 'object') {
    for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
      var bindings = stored.keys[action];
      if (!Array.isArray(bindings)) continue;
      var clean = [];
      for (var i = 0; i < bindings.length && clean.length < 2; i++) {
        if (typeof bindings[i] === 'string' && bindings[i].length) clean.push(bindings[i]);
      }
      if (clean.length) merged.keys[action] = clean;
    }
  }

  if (typeof stored.particles === 'boolean') merged.particles = stored.particles;
  if (typeof stored.showDrawings === 'boolean') merged.showDrawings = stored.showDrawings;

  return merged;
}

function loadLocalSettings() {
  var stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_STORAGE_KEY));
  } catch (err) {
    // Corrupt blob - fall back to defaults; the next save overwrites it.
  }
  return mergeLocalSettings(stored);
}

var localSettings = loadLocalSettings();
var settingsSyncTimer = null;

function saveLocalSettings() {
  try {
    localStorage.setItem(LOCAL_SETTINGS_STORAGE_KEY, JSON.stringify(localSettings));
  } catch (err) {
    // Storage full/blocked (private mode) - settings still apply this session.
  }
  localSettingsEvents.emit('localSettings:changed');

  clearTimeout(settingsSyncTimer);
  settingsSyncTimer = setTimeout(function () {
    fetch('/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(localSettings),
    }).catch(function () {});
  }, 400);
}

// Account copy wins on page load. Runs async; until it lands, the
// localStorage copy applies.
function syncLocalSettingsFromAccount() {
  fetch('/api/settings').then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (stored) {
    if (!stored || !Object.keys(stored).length) return;
    localSettings = mergeLocalSettings(stored);
    try {
      localStorage.setItem(LOCAL_SETTINGS_STORAGE_KEY, JSON.stringify(localSettings));
    } catch (err) {}
    localSettingsEvents.emit('localSettings:changed');
  }).catch(function () {});
}

function setKeybind(action, slot, key) {
  if (!LOCAL_SETTINGS_DEFAULTS.keys[action]) return;

  // A key means one global thing - remove it from every other action first.
  for (var otherAction in localSettings.keys) {
    var bindings = localSettings.keys[otherAction];
    var index = bindings.indexOf(key);
    if (index !== -1) bindings.splice(index, 1);
  }

  var slots = localSettings.keys[action];
  slots[slot] = key;
  saveLocalSettings();
}

function resetKeybinds() {
  var action;
  for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
    localSettings.keys[action] = LOCAL_SETTINGS_DEFAULTS.keys[action].slice();
  }
  saveLocalSettings();
}

function setParticlesEnabled(enabled) {
  localSettings.particles = !!enabled;
  saveLocalSettings();
}

function setShowDrawings(enabled) {
  localSettings.showDrawings = !!enabled;
  saveLocalSettings();
}
