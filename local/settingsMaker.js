// settingsMaker.js - the Settings Maker tab: pick a bundled map, tune
// physics/match settings with the same schema-driven form the original
// leader panels used (client/game/ui/schemaForm.js, unchanged), then save
// the result as a { mapFile, physics, match } JSON file - download it, or
// PUT it to api.bamball.workers.dev under a name you choose
// (WORKER_URL + '/api/settings/<name>', GET'able forever after at
// WORKER_URL + '/settings/<name>'). The output is upload-slot-compatible:
// dropping the same file into the Record & Files tab's Pregame/Game
// Settings inputs (local/settingsFiles.js) applies it exactly the same way.

function initSettingsMaker() {
  var mapSelect  = document.getElementById('makerMapSelect');
  var physRows   = document.getElementById('makerPhysicsRows');
  var physTabs   = document.getElementById('makerPhysicsSubTabs');
  var matchRows  = document.getElementById('makerMatchRows');
  var nameInput  = document.getElementById('makerFileName');
  var status     = document.getElementById('makerStatus');
  var loadSelect = document.getElementById('makerLoadSelect');

  // Save-to-server (below) was write-only until now - nothing in this tab
  // ever read a name back, so a saved file was only reachable by typing
  // its exact name into a browser tab against the raw GET /settings/:name
  // route. This populates a pick list of every name that's ever been
  // saved, refreshed each time the tab is opened.
  function refreshLoadList() {
    fetch(activeTransport.workerUrl + '/api/settings').then(function (res) { return res.json(); })
      .then(function (data) {
        loadSelect.innerHTML = '<option value="">Load from server…</option>';
        (data.settings || []).forEach(function (s) {
          var opt = document.createElement('option');
          opt.value = s.name;
          opt.textContent = s.name;
          loadSelect.appendChild(opt);
        });
      }).catch(function () {
        loadSelect.innerHTML = '<option value="">Failed to load list</option>';
      });
  }
  refreshLoadList();

  fetch(GAME_BASE_PATH + 'assets/maps/manifest.json').then(function (res) { return res.json(); }).then(function (maps) {
    maps.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.file;
      opt.textContent = m.name + ' (' + m.author + ', ' + m.width + 'x' + m.height + ')';
      mapSelect.appendChild(opt);
    });
  }).catch(function () {
    mapSelect.innerHTML = '<option value="">Failed to load map list</option>';
  });

  // Authoring starts from the schema's real defaults (not the live game's
  // current values) - a settings file is meant to be a reusable, portable
  // preset, not a snapshot of whatever this session happens to be at.
  function buildForms() {
    if (settingsState.physicsDefaults) {
      buildSettingsPanel(physRows, 'physics', settingsState.physicsDefaults, physTabs);
    }
    buildSettingsPanel(matchRows, 'match', MatchSettings.DEFAULT_SETTINGS);
  }

  // physicsDefaults arrives async (part of the 'joined' packet) - build
  // once it's actually there, and once more if the tab is opened before
  // that's happened.
  if (settingsState.physicsDefaults) buildForms();
  else settingsEvents.on('schema:loaded', buildForms);

  function collectFile() {
    var physResult  = settingsState.physicsDefaults
      ? collectChangedSettings(physRows, 'physics', settingsState.physicsDefaults)
      : { settings: {}, changed: false };
    var matchResult = collectChangedSettings(matchRows, 'match', MatchSettings.DEFAULT_SETTINGS);

    var file = {};
    if (mapSelect.value) file.mapFile = mapSelect.value;
    if (physResult.changed) file.physics = physResult.settings;
    if (matchResult.changed) file.match = matchResult.settings;
    return file;
  }

  document.getElementById('makerDownloadBtn').addEventListener('click', function () {
    var file = collectFile();
    var name = (nameInput.value || 'settings').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    var blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    downloadBlob(blob, name + '.json');
    status.textContent = 'Downloaded ' + name + '.json';
  });

  document.getElementById('makerUploadBtn').addEventListener('click', function () {
    var name = (nameInput.value || '').trim();
    if (!name) { status.textContent = 'Name it first (used for the shareable link).'; return; }

    var file = collectFile();
    status.textContent = 'Saving…';
    fetch(activeTransport.workerUrl + '/api/settings/' + encodeURIComponent(name), {
      method: 'PUT',
      body: JSON.stringify(file),
    }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) { status.textContent = 'Failed: ' + (result.data.error || 'unknown error'); return; }
        status.textContent = 'Saved at ' + activeTransport.workerUrl + result.data.url;
        refreshLoadList();
      })
      .catch(function () { status.textContent = 'Failed to reach the server.'; });
  });

  // Rebuilds both forms straight from the loaded file, same
  // buildSettingsPanel(rowsEl, scope, values, subTabsEl) machinery buildForms()
  // uses above - values merges the schema's real defaults with whatever the
  // file overrides, so any key the file doesn't mention still shows its
  // normal default rather than going blank.
  loadSelect.addEventListener('change', function () {
    var name = loadSelect.value;
    if (!name) return;
    nameInput.value = name;
    status.textContent = 'Loading…';
    fetch(activeTransport.workerUrl + '/settings/' + encodeURIComponent(name))
      .then(function (res) { if (!res.ok) throw new Error('not found'); return res.json(); })
      .then(function (parsed) {
        if (parsed.mapFile) mapSelect.value = parsed.mapFile;
        if (settingsState.physicsDefaults) {
          buildSettingsPanel(physRows, 'physics', Object.assign({}, settingsState.physicsDefaults, parsed.physics || {}), physTabs);
        }
        buildSettingsPanel(matchRows, 'match', Object.assign({}, MatchSettings.DEFAULT_SETTINGS, parsed.match || {}));
        status.textContent = 'Loaded ' + name;
      })
      .catch(function (err) { status.textContent = 'Failed to load: ' + err.message; });
  });
}
