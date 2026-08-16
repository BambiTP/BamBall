// controlPanel.js - the Settings tab: the one place a leader configures a
// match, live. Official one-click presets, a deterministic settings code
// (save the current configuration, or load someone else's by pasting their
// code back in), a Fortunate Maps id for the map, live physics/match
// settings (edit as many as you want, one Apply button sends everything at
// once), and in-memory save states. Leader-only - menu.js hides the whole
// tab and its button otherwise (renderMatchControls), and every action here
// is also leader-gated server-side (webrtcTransport.js/hostCli.js/
// localTransport.js), so this file never has to duplicate that check - a
// rejected action just shows the 'error' packet's message like everything
// else does.
//
// Edits settingsState.physics / settingsState.matchInfo.settings, the
// room's real running values - there's no separate "authored file" concept
// here. Apply sends the diff straight to matchManager via
// actions.updatePhysics/updateSettings; presets and settings codes apply
// immediately the same way. Same buildSettingsPanel/collectChangedSettings
// machinery (client/ui/schemaForm.js) throughout.

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

  var physRows  = document.getElementById('controlPhysicsRows');
  var physTabs  = document.getElementById('controlPhysicsSubTabs');
  var matchRows = document.getElementById('controlMatchRows');
  var applyBtn  = document.getElementById('controlApplySettingsBtn');
  var status    = document.getElementById('controlSettingsStatus');

  var lastPhysics = {};
  var lastMatch   = {};

  // Builds once, from whatever's live right now - deliberately NOT
  // refreshed on every physics:changed/matchInfo:changed while this tab is
  // open. Auto-refreshing while a leader has half-edited a dozen fields
  // would either yank their edits or silently diff against a moved target;
  // reopening the tab (or applying, which rebuilds from the confirmed
  // result below) is the refresh point instead.
  function buildForms() {
    lastPhysics = Object.assign({}, settingsState.physics);
    lastMatch   = Object.assign({}, settingsState.matchInfo.settings);
    buildSettingsPanel(physRows, 'physics', lastPhysics, physTabs);
    buildSettingsPanel(matchRows, 'match', lastMatch);
  }

  if (settingsState.settingsSchema) buildForms();
  else settingsEvents.on('schema:loaded', buildForms);

  applyBtn.addEventListener('click', function () {
    var physResult  = collectChangedSettings(physRows, 'physics', lastPhysics);
    var matchResult = collectChangedSettings(matchRows, 'match', lastMatch);

    if (!physResult.changed && !matchResult.changed) { status.textContent = 'Nothing changed.'; return; }

    if (physResult.changed)  actions.updatePhysics(physResult.settings);
    if (matchResult.changed) actions.updateSettings(matchResult.settings);

    status.textContent = 'Applied for everyone.';
    buildForms(); // rebuild from the just-applied values, ready for the next round of edits
  });

  // A preset/code bundle is { physics?, match?, mapId? } - applies whatever
  // it has immediately (unlike the manual-edit forms above, which wait for
  // Apply), then rebuilds the forms from the result, same as Apply does.
  function applyBundle(bundle) {
    if (!bundle) return;
    if (bundle.mapId)   actions.changeMap(bundle.mapId);
    if (bundle.physics) actions.updatePhysics(bundle.physics);
    if (bundle.match)   actions.updateSettings(bundle.match);
    buildForms();
  }

  // ---- official presets ---------------------------------------------------

  var presetRow = document.getElementById('controlPresetRow');
  (OfficialPresets.OFFICIAL_PRESETS || []).forEach(function (preset) {
    var btn = document.createElement('button');
    btn.className = 'menuBtn';
    btn.textContent = preset.name;
    btn.addEventListener('click', function () { applyBundle(preset.settings); });
    presetRow.appendChild(btn);
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

  function renderMapName() {
    mapNameEl.textContent = 'Current: ' + (game.mapName || '(unknown)');
  }
  renderMapName();
  appEvents.on('map:changed', function () {
    renderMapName();
    mapStatus.textContent = '';
  });

  document.getElementById('controlMapChangeBtn').addEventListener('click', function () {
    var id = mapIdInput.value.trim();
    if (!id) return;
    actions.changeMap(id);
    mapStatus.textContent = 'Loading map ' + id + '…';
  });

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
