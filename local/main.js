// main.js - trimmed boot sequence: viewport + HUD + Join Red/Join Blue,
// nothing else. Mirrors client/game/app/bootstrap.js's structure, but
// boots against localTransport.js instead of a real WebSocket.

var renderer = null;

function registerPacketHandlers() {
  for (var type in packetApplier) {
    if (type === 'applyJoined') continue;
    packetRouter.on(type, packetApplier[type]);
  }
}

function start() {
  wireGameStateEvents();
  wireSettingsStateEvents();
  wireLocalSettingsEvents();
  registerPacketHandlers();

  simulationEvents.on('frame', cameraController.update);

  initHud();
  initJoinUI();

  var canvas = document.getElementById('viewport');
  renderer = new Renderer(canvas);

  renderer.init().then(function () {
    initFireInput();
    initKeyboardInput();
    return localTransport.boot();
  }).then(function () {
    return spriteSheetLoader.fetch();
  }).then(function (data) {
    var manifestPromise = fetch(data.manifestUrl).then(function (res) { return res.json(); });
    var texturesPromise = renderer.fetchTextures({ packed: data.sheetUrl, walls: data.wallsUrl });
    return Promise.all([manifestPromise, texturesPromise]).then(function (results) {
      renderer.applyManifest(results[0]);
      spriteSheetLoader.loadedHash = data.hash || null;
    });
  }).then(function () {
    renderer.start();
    startPhysicsLoop();
  }).catch(function (err) {
    console.error('[main] boot failed:', err);
  });
}

document.addEventListener('DOMContentLoaded', start);
