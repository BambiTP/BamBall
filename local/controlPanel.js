// controlPanel.js - the Settings tab: the one place a leader configures a
// match, live. Local one-click presets (local/localPresets.js - saved in
// this browser, not an account), a deterministic settings code (save the
// current configuration, or load someone else's by pasting their code back
// in), a Fortunate Maps id for the map, live physics/match settings, and
// in-memory save states. Leader-only - menu.js hides the whole tab and its
// button otherwise (renderMatchControls), and every action here is also
// leader-gated server-side (webrtcTransport.js/hostCli.js/localTransport.js),
// so this file never has to duplicate that check - a rejected action just
// shows the 'error' packet's message like everything else does.
//
// Edits settingsState.physics / settingsState.matchInfo.settings, the
// room's real running values - there's no separate "authored file" concept
// here. A preset or a settings code replaces the whole configuration and
// applies immediately; a single physics/match field does NOT - it only
// applies when its own Apply button fires (client/ui/schemaForm.js's
// buildSettingRow), and its Reset button puts just that field back to its
// shipped default and applies that instead.

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
// idempotent) and short enough to read/paste by hand. SubtleCrypto needs
// no library and is already assumed available elsewhere in this codebase
// (see worker/src/index.js's crypto.getRandomValues).
function hashSettingsCode(bundle) {
  var bytes = new TextEncoder().encode(stableStringify(bundle));
  return crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
    var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return (b < 16 ? '0' : '') + b.toString(16);
    }).join('');
    return hex.slice(0, 10);
  });
}

function initControlPanel() {
  // ---- live physics + match settings ------------------------------------
  // Builds once, from whatever's live right now - deliberately NOT
  // refreshed every time settingsState.physics/matchInfo.settings changes,
  // since a leader can be mid-edit on several fields at once (typed, not
  // yet Applied) and an auto-rebuild off some unrelated change (another
  // leader's own edit, this leader's own Apply on a DIFFERENT field) would
  // yank those unsent edits right out from under them. The one time a
  // full rebuild off settingsState IS correct - a preset/code load
  // replacing the whole configuration - goes through
  // scheduleRebuildOnNextSync() below instead of a permanent subscription.

  var physRows  = document.getElementById('controlPhysicsRows');
  var physTabs  = document.getElementById('controlPhysicsSubTabs');
  var matchRows = document.getElementById('controlMatchRows');
  var status    = document.getElementById('controlSettingsStatus');

  function onPhysicsFieldApply(key, value) {
    var partial = {};
    partial[key] = value;
    actions.updatePhysics(partial);
    status.textContent = 'Applied ' + key + '.';
  }

  function onMatchFieldApply(key, value) {
    var partial = {};
    partial[key] = value;
    actions.updateSettings(partial);
    status.textContent = 'Applied ' + key + '.';
  }

  function buildForms() {
    buildSettingsPanel(physRows, 'physics', settingsState.physics, physTabs, onPhysicsFieldApply);
    buildSettingsPanel(matchRows, 'match', settingsState.matchInfo.settings, null, onMatchFieldApply);
  }

  if (settingsState.settingsSchema) buildForms();
  else settingsEvents.on('schema:loaded', buildForms);

  // actions.updatePhysics/updateSettings (below and in onXFieldApply above)
  // are fire-and-forget packet sends (client/app/actions.js) - the room's
  // settingsState only actually reflects them once the host's broadcast
  // round-trips back through packetApplier, which is what physics:changed/
  // matchInfo:changed mark. rebuildArmed stays false the rest of the time
  // (see the big comment above) so those two events don't turn back into a
  // permanent auto-rebuild; a bundle apply arms it for a few seconds, long
  // enough to catch the round trip, then it disarms itself again.
  var rebuildArmed = false;
  var rebuildDisarmTimer = null;
  settingsEvents.on('physics:changed', function () { if (rebuildArmed) buildForms(); });
  settingsEvents.on('matchInfo:changed', function () { if (rebuildArmed) buildForms(); });

  function scheduleRebuildOnNextSync() {
    rebuildArmed = true;
    clearTimeout(rebuildDisarmTimer);
    rebuildDisarmTimer = setTimeout(function () { rebuildArmed = false; }, 3000);
  }

  // A preset/code bundle is { physics?, match?, mapId? } - unlike a single
  // field's Apply above, loading one is a deliberate "replace everything"
  // action, so it's fine (and the whole point) for it to blow away any
  // in-progress unapplied edits sitting in the forms below.
  function applyBundle(bundle) {
    if (!bundle) return;
    scheduleRebuildOnNextSync();
    if (bundle.mapId)   actions.changeMap(bundle.mapId);
    if (bundle.physics) actions.updatePhysics(bundle.physics);
    if (bundle.match)   actions.updateSettings(bundle.match);
  }

  // ---- presets --------------------------------------------------------------
  // Local to this browser (local/localPresets.js), not an account/server
  // thing - see the Settings Code section below for the server-backed,
  // shareable alternative. Seeded with three starting presets (Standard/
  // Gravity/Eggball) the first time this browser opens this tab; after
  // that, save-over-the-same-name to update one or the × to delete it,
  // same as any preset you add yourself.

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
    LocalPresets.upsertLocalPreset(name, {
      physics: settingsState.physics,
      match:   settingsState.matchInfo.settings,
      mapId:   game.mapId,
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
    var bundle = {
      physics: settingsState.physics,
      match:   settingsState.matchInfo.settings,
      mapId:   game.mapId,
    };
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

  function renderMapName() {
    mapNameEl.textContent = 'Current: ' + (game.mapName || '(unknown)');
  }
  renderMapName();
  appEvents.on('map:changed', function () {
    renderMapName();
    mapStatus.textContent = '';
  });

  function loadMap(id) {
    if (!id) return;
    actions.changeMap(id);
    mapStatus.textContent = 'Loading map ' + id + '…';
  }

  document.getElementById('controlMapChangeBtn').addEventListener('click', function () {
    loadMap(mapIdInput.value.trim());
  });

  // Curated CTF ids (local/defaultMaps.js) - one click straight to a known
  // map instead of hunting for an id to paste into the field above.
  DEFAULT_MAPS.forEach(function (id) {
    var btn = document.createElement('button');
    btn.className = 'menuBtn';
    btn.textContent = String(id);
    btn.addEventListener('click', function () { loadMap(id); });
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
    btn.addEventListener('click', function () { loadMap(EGGBALL_MAP_ID); });
    document.getElementById('controlEggballMapRow').appendChild(btn);
  })();

  // ---- save states ----------------------------------------------------------
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
}
