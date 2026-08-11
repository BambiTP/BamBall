// settingsMaker.js - the Settings Maker tab: pick a bundled map, tune
// physics/match settings with the same schema-driven form the original
// leader panels used (client/game/ui/schemaForm.js, unchanged), then save
// the result as a { mapFile, physics, match } JSON file - download it, or
// PUT it to api.bambipro.workers.dev under a name you choose
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

  fetch('./assets/maps/manifest.json').then(function (res) { return res.json(); }).then(function (maps) {
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
      })
      .catch(function () { status.textContent = 'Failed to reach the server.'; });
  });
}
