// localPresets.js - the Presets sub-tab's saved list: physics+match+mapId
// bundles kept in THIS BROWSER's localStorage, nobody's account and no
// server round-trip (contrast local/controlPanel.js's Settings Code
// section, which stores the exact same { physics?, match?, mapId? } shape
// server-side under a content-addressed hash so it can be handed to
// someone else - a preset here is the fast "apply my usual setup" path, a
// code is the "share this exact config" path). Seeded once with three
// starting presets (Standard/Gravity/Eggball) the first time this browser
// ever asks for the list; after that they're just three ordinary presets -
// renameable (by saving over the same name), deletable, nothing about
// them is special-cased once seeded.

var LOCAL_PRESETS_KEY = 'bamball_local_presets';

// Every physics key at its shipped default - settingsState.physicsDefaults,
// NOT the gameConfig global, which matchManager.js mutates in place on
// every updatePhysics() and so stops being "the default" the moment a
// leader changes anything (see client/ui/schemaForm.js's defaultValueFor
// for the long version). Same source that function's own Reset button
// reads, so "apply Standard" and "Reset every physics row by hand" always
// land on identical numbers. Requires the schema packet to have already
// arrived - true by the time anything in this file can actually be
// called, since reaching the leader-only Settings tab at all means the
// room's initial handshake (which carries it) already happened.
function defaultPhysicsBundle() {
  var bundle = {};
  SettingsSchema.SCHEMA.forEach(function (entry) {
    if (entry.scope === 'physics') bundle[entry.key] = settingsState.physicsDefaults[entry.key];
  });
  return bundle;
}

// Gravity/Eggball are placeholder tunings pending real numbers - both
// start from the exact same defaults as Standard and only override the
// couple of keys their name implies, so they're always at least a valid,
// playable configuration in the meantime.
function seedDefaultPresets() {
  var standardPhysics = defaultPhysicsBundle();
  var standardMatch = Object.assign({}, settingsState.matchSettingsDefaults);

  return [
    { id: 'standard', name: 'Standard', settings: { physics: standardPhysics, match: standardMatch } },
    {
      id: 'gravity',
      name: 'Gravity',
      settings: {
        physics: Object.assign({}, standardPhysics, { gravityY: 15 }),
        match: standardMatch,
      },
    },
    {
      id: 'eggball',
      name: 'Eggball',
      settings: {
        physics: Object.assign({}, standardPhysics, { eggballEnabled: true }),
        match: standardMatch,
        // local/defaultMaps.js's EGGBALL_MAP_ID - most CTF maps have no
        // RedGoal/BlueGoal tiles at all, so the mode needs its own map to
        // actually be playable, not just its own physics toggle.
        mapId: EGGBALL_MAP_ID,
      },
    },
  ];
}

function loadLocalPresets() {
  try {
    var raw = localStorage.getItem(LOCAL_PRESETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {}
  var seeded = seedDefaultPresets();
  saveLocalPresets(seeded);
  return seeded;
}

function saveLocalPresets(list) {
  try { localStorage.setItem(LOCAL_PRESETS_KEY, JSON.stringify(list)); } catch (err) {}
}

// Same name saved twice overwrites in place (id is derived from the name)
// rather than piling up duplicates - matches the Settings Code section's
// own "saving the same thing twice is a no-op overwrite" behavior.
function upsertLocalPreset(name, settings) {
  var id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
  var list = loadLocalPresets();
  var existing = list.filter(function (p) { return p.id === id; })[0];
  if (existing) { existing.name = name; existing.settings = settings; }
  else list.push({ id: id, name: name, settings: settings });
  saveLocalPresets(list);
  return list;
}

function deleteLocalPreset(id) {
  var list = loadLocalPresets().filter(function (p) { return p.id !== id; });
  saveLocalPresets(list);
  return list;
}

var LocalPresets = { loadLocalPresets: loadLocalPresets, upsertLocalPreset: upsertLocalPreset, deleteLocalPreset: deleteLocalPreset };
