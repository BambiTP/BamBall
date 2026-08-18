// controlPanel.js - the map/physics/match editor behind local/menu.js's two
// profile cards (Pregame, Game). Every edit here - a physics/match field,
// a preset, a settings code, a map pick - goes through
// actions.updateProfile(profile, partial): the server merges it into that
// profile's stored bucket, and ALSO applies it live immediately if the
// room is currently in the phase that profile governs (see
// engine/matchManager.js's setProfile) - there's no separate "draft" state
// to manage here, editing IS the room's actual configuration for whichever
// phase you're looking at.
//
// Save States (bottom of the modal) are the one exception: they're
// snapshots of the CURRENTLY RUNNING match (player positions, live score),
// not a settings profile, so they act on the live room regardless of which
// card is open - same as they always have.
//
// Leader-only - menu.js hides both cards otherwise (renderMatchControls),
// and every action here is also leader-gated server-side, so this file
// never has to duplicate that check - a rejected action just shows the
// 'error' packet's message like everything else does.

// Recursively sorts object keys before JSON.stringify-ing, so the same
// settings always produce the same string (and therefore the same code)
// regardless of the order keys happened to land in an object.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  var keys = Object.keys(value).sort();
  return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]); }).join(',') + '}';
}

// First 10 hex chars of a SHA-256 over the canonical settings string -
// deterministic (same configuration always yields the same code, so
// PUT-ing it to the content-addressed /api/settings/:code store is
// idempotent) and short enough to read/paste by hand.
function hashSettingsCode(bundle) {
  var bytes = new TextEncoder().encode(stableStringify(bundle));
  return crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
    var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return (b < 16 ? '0' : '') + b.toString(16);
    }).join('');
    return hex.slice(0, 10);
  });
}

// Returns { activateProfile(name) } - local/menu.js calls this every time
// either card opens (not just the first time) to point the forms below at
// the right profile.
function initControlPanel() {
  var currentProfile = null;

  function currentProfileState() {
    return game.profiles[currentProfile];
  }

  // ---- physics + match forms ---------------------------------------------

  var physRows  = document.getElementById('controlPhysicsRows');
  var physTabs  = document.getElementById('controlPhysicsSubTabs');
  var matchRows = document.getElementById('controlMatchRows');
  var status    = document.getElementById('controlSettingsStatus');

  function onPhysicsFieldApply(key, value) {
    var partial = {};
    partial[key] = value;
    actions.updateProfile(currentProfile, { physics: partial });
    status.textContent = 'Set ' + key + '.';
  }

  function onMatchFieldApply(key, value) {
    var partial = {};
    partial[key] = value;
    actions.updateProfile(currentProfile, { match: partial });
    status.textContent = 'Set ' + key + '.';
  }

  // buildSettingsPanel (client/ui/schemaForm.js) only renders a row for a
  // key that's actually present in the object it's given - a profile
  // starts with no keys set at all (nothing customized yet), so without
  // this every form would render completely empty until something had
  // already been changed. Defaults first, the profile's own overrides on
  // top, so every schema field always has a row - onApply below still only
  // ever sends the ONE key that was actually edited, never this whole
  // merged object.
  function displayValuesFor(scope) {
    var defaults = scope === 'physics' ? (settingsState.physicsDefaults || {}) : (settingsState.matchSettingsDefaults || {});
    return Object.assign({}, defaults, currentProfileState()[scope]);
  }

  function buildForms() {
    buildSettingsPanel(physRows, 'physics', displayValuesFor('physics'), physTabs, onPhysicsFieldApply);
    buildSettingsPanel(matchRows, 'match', displayValuesFor('match'), null, onMatchFieldApply);
    renderMapId();
  }

  // A preset/code bundle is { physics?, match?, mapId? } - unlike a single
  // field's Apply above, loading one is a deliberate "replace everything in
  // this profile" action - still just one updateProfile call, the server
  // merges it the same way.
  function applyBundle(bundle) {
    if (!bundle) return;
    actions.updateProfile(currentProfile, bundle);
  }

  // Called by local/menu.js every time either card is opened, and whenever
  // this profile changes underneath us (another leader editing the same
  // card, or the round trip from our own edit above landing).
  function activateProfile(name) {
    currentProfile = name;
    if (settingsState.settingsSchema) buildForms();
  }

  settingsEvents.on('schema:loaded', function () { if (currentProfile) buildForms(); });
  appEvents.on('profiles:changed', function () { if (currentProfile) buildForms(); });

  // ---- presets --------------------------------------------------------------
  // Local to this browser (local/localPresets.js), not an account/server
  // thing - see Settings Code below for the server-backed, shareable
  // alternative. Seeded with three starting presets (Standard/Gravity/
  // Eggball) the first time this browser opens this tab; after that,
  // save-over-the-same-name to update one or the × to delete it, same as
  // any preset you add yourself.

  var presetRow      = document.getElementById('controlPresetRow');
  var presetNameInput = document.getElementById('controlPresetName');
  var presetStatus   = document.getElementById('controlPresetStatus');

  function renderPresets() {
    presetRow.textContent = '';
    LocalPresets.loadLocalPresets().forEach(function (preset) {
      var pill = document.createElement('span');
      pill.className = 'presetPill';

      var applyBtn = document.createElement('button');
      applyBtn.className = 'menuBtn';
      applyBtn.textContent = preset.name;
      applyBtn.addEventListener('click', function () {
        applyBundle(preset.settings);
        presetStatus.textContent = 'Applied "' + preset.name + '".';
      });
      pill.appendChild(applyBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'menuBtn presetDeleteBtn';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Delete preset';
      deleteBtn.addEventListener('click', function () {
        LocalPresets.deleteLocalPreset(preset.id);
        renderPresets();
      });
      pill.appendChild(deleteBtn);

      presetRow.appendChild(pill);
    });
  }
  renderPresets();

  document.getElementById('controlSavePresetBtn').addEventListener('click', function () {
    var name = presetNameInput.value.trim();
    if (!name) { presetStatus.textContent = 'Name the preset first.'; return; }
    var profile = currentProfileState();
    LocalPresets.upsertLocalPreset(name, {
      physics: profile.physics,
      match:   profile.match,
      mapId:   profile.mapId,
    });
    presetNameInput.value = '';
    presetStatus.textContent = 'Saved "' + name + '".';
    renderPresets();
  });

  // ---- settings code --------------------------------------------------------
  // Content-addressed: the code is a hash of the settings themselves (see
  // stableStringify/hashSettingsCode above), not a leader-chosen name, so
  // saving the same configuration twice always yields the same code and a
  // PUT to it is always a safe no-op overwrite.

  var codeStatus     = document.getElementById('controlCodeStatus');
  var loadCodeInput  = document.getElementById('controlLoadCodeInput');

  document.getElementById('controlGetCodeBtn').addEventListener('click', function () {
    var profile = currentProfileState();
    var bundle = { physics: profile.physics, match: profile.match, mapId: profile.mapId };
    codeStatus.textContent = 'Computing code…';
    var code;
    hashSettingsCode(bundle).then(function (computed) {
      code = computed;
      codeStatus.textContent = 'Saving…';
      return fetch(activeTransport.workerUrl + '/api/settings/' + code, {
        method: 'PUT',
        body: JSON.stringify(bundle),
      });
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      if (!result.ok) { codeStatus.textContent = 'Failed: ' + (result.data.error || 'unknown error'); return; }
      codeStatus.textContent = 'Code: ' + code;
    }).catch(function () { codeStatus.textContent = 'Failed to reach the server.'; });
  });

  document.getElementById('controlLoadCodeBtn').addEventListener('click', function () {
    var code = loadCodeInput.value.trim();
    if (!code) return;
    codeStatus.textContent = 'Loading…';
    fetch(activeTransport.workerUrl + '/settings/' + encodeURIComponent(code))
      .then(function (res) { if (!res.ok) throw new Error('not found'); return res.json(); })
      .then(function (bundle) {
        applyBundle(bundle);
        codeStatus.textContent = 'Loaded ' + code + '.';
      })
      .catch(function (err) { codeStatus.textContent = 'Failed to load: ' + err.message; });
  });

  // ---- map ----------------------------------------------------------------
  // Fortunate Maps only - see local/fortunateMapsImport.js. mapIdInput
  // takes a bare Fortunate Maps id, e.g. "98939".

  var mapNameEl   = document.getElementById('controlMapName');
  var mapIdInput  = document.getElementById('controlMapId');
  var mapStatus   = document.getElementById('controlMapStatus');
  var defaultMapRow = document.getElementById('controlDefaultMapRow');

  function renderMapId() {
    var id = currentProfileState().mapId;
    mapNameEl.textContent = (currentProfile === 'pregame' ? 'Pregame' : 'Game') + ' map: ' + (id ? id : '(none set)');
  }

  function setProfileMap(id) {
    if (!id) return;
    actions.updateProfile(currentProfile, { mapId: id });
    mapStatus.textContent = 'Set.';
  }

  document.getElementById('controlMapChangeBtn').addEventListener('click', function () {
    setProfileMap(mapIdInput.value.trim());
  });

  // Curated CTF ids (local/defaultMaps.js) - one click straight to a known
  // map instead of hunting for an id to paste into the field above.
  DEFAULT_MAPS.forEach(function (id) {
    var btn = document.createElement('button');
    btn.className = 'menuBtn';
    btn.textContent = String(id);
    btn.addEventListener('click', function () { setProfileMap(id); });
    defaultMapRow.appendChild(btn);
  });

  // The one map Eggball mode actually works on (see local/defaultMaps.js's
  // EGGBALL_MAP_ID) - doesn't touch eggballEnabled itself, just the map;
  // the "Eggball" preset (local/localPresets.js) is the one-click "both at
  // once" path.
  (function () {
    var btn = document.createElement('button');
    btn.className = 'menuBtn';
    btn.textContent = String(EGGBALL_MAP_ID);
    btn.addEventListener('click', function () { setProfileMap(EGGBALL_MAP_ID); });
    document.getElementById('controlEggballMapRow').appendChild(btn);
  })();

  // ---- save states ----------------------------------------------------------
  // Unlike everything above, these act on the LIVE match right now,
  // regardless of which card is open - see this file's header comment.
  // In-memory only, lives on the host for this room's lifetime (see
  // engine/matchManager.js's captureSaveState/restoreSaveState/deleteSaveState
  // and the save_state/load_state/delete_state packet cases). The host
  // broadcasts the current slot name list on every change (saveStatesChanged)
  // so this never has to poll.

  var stateList   = document.getElementById('controlSaveStateList');
  var stateStatus = document.getElementById('controlSaveStateStatus');

  function renderSaveStates(names) {
    stateList.innerHTML = '';
    if (!names || !names.length) {
      var empty = document.createElement('div');
      empty.className = 'fileStatus';
      empty.textContent = 'No save states yet this session.';
      stateList.appendChild(empty);
      return;
    }
    names.forEach(function (name) {
      var row = document.createElement('div');
      row.className = 'saveStateRow';

      var label = document.createElement('span');
      label.className = 'saveStateName';
      label.textContent = name;
      row.appendChild(label);

      var loadBtn = document.createElement('button');
      loadBtn.className = 'menuBtn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', function () {
        actions.loadState(name);
        stateStatus.textContent = 'Loaded "' + name + '".';
      });
      row.appendChild(loadBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'menuBtn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', function () { actions.deleteState(name); });
      row.appendChild(deleteBtn);

      stateList.appendChild(row);
    });
  }

  appEvents.on('saveStates:changed', function (names) { renderSaveStates(names); });
  renderSaveStates(game.saveStateNames || []);

  document.getElementById('controlSaveStateBtn').addEventListener('click', function () {
    var name = document.getElementById('controlSaveStateName').value.trim();
    if (!name) { stateStatus.textContent = 'Name the slot first.'; return; }
    actions.saveState(name);
    stateStatus.textContent = 'Saved "' + name + '".';
  });

  return { activateProfile: activateProfile };
}
