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

// Same reasoning as localTransport.js's own nextFrame(): splits boot's
// remaining heavy synchronous steps (building the sliced texture atlas,
// then drawing/baking the full tile map) across real painted frames so the
// browser stays responsive between them, instead of doing the exact same
// full-fidelity work as one unbroken block. No work is skipped, reduced,
// or lowered in quality - every machine does the same work either way,
// this only changes how it's spaced out.
function nextFrame() {
  return new Promise(function (resolve) {
    requestAnimationFrame(function () { requestAnimationFrame(resolve); });
  });
}

async function start() {
  wireGameStateEvents();
  wireSettingsStateEvents();
  wireLocalSettingsEvents();
  registerPacketHandlers();

  simulationEvents.on('frame', cameraController.update);

  initHud();
  initJoinUI();
  initMenu();
  initSettingsFilesUI();
  // Textures and Settings Maker tabs build their DOM/fetch their data
  // lazily, the first time you actually open them (see local/menu.js) -
  // not here at boot, while they're sitting hidden behind the Esc menu.

  var canvas = document.getElementById('viewport');
  renderer = new Renderer(canvas);

  try {
    await renderer.init();
    initFireInput();
    initKeyboardInput();

    await localTransport.boot(); // engine + client physics worlds - already frame-spaced internally
    await nextFrame();

    var data = await spriteSheetLoader.fetch();
    var manifestPromise = fetch(data.manifestUrl).then(function (res) { return res.json(); });
    var texturesPromise = renderer.fetchTextures({ packed: data.sheetUrl, walls: data.wallsUrl });
    var results = await Promise.all([manifestPromise, texturesPromise]);
    renderer.applyManifest(results[0]); // slices + bakes the full sprite atlas
    spriteSheetLoader.loadedHash = data.hash || null;
    await nextFrame();

    renderer.start(); // draws every map tile + bakes the background
    startPhysicsLoop();
    enableJoinUI();
    var overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
  } catch (err) {
    console.error('[main] boot failed:', err);
    var failOverlay = document.getElementById('loadingOverlay');
    if (failOverlay) failOverlay.textContent = 'Failed to load - check the console (F12) for details.';
  }
}

document.addEventListener('DOMContentLoaded', start);
