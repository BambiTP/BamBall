// controlPanel.js - the Control tab: live physics/match settings (edit as
// many as you want, one Apply button sends everything at once), quick map
// change, and in-memory save states. Leader-only - menu.js hides the whole
// tab and its button otherwise (renderMatchControls), and every action here
// is also leader-gated server-side (webrtcTransport.js/hostCli.js/
// localTransport.js), so this file never has to duplicate that check - a
// rejected action just shows the 'error' packet's message like everything
// else does.
//
// Differs from settingsMaker.js (which authors a portable preset file from
// the schema's DEFAULTS, downloaded/PUT as JSON) in what it edits, not how:
// this tab has no file concept at all - it edits settingsState.physics /
// settingsState.matchInfo.settings, the room's real running values, and
// Apply sends the diff straight to matchManager via actions.updatePhysics/
// updateSettings. Same buildSettingsPanel/collectChangedSettings machinery
// (client/ui/schemaForm.js) either way.

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

  // ---- map ----------------------------------------------------------------

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
    var file = mapIdInput.value.trim();
    if (!file) return;
    if (file.indexOf('.json') === -1) file += '.json';
    actions.changeMap(file);
    mapStatus.textContent = 'Loading ' + file + '…';
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
