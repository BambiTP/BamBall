// main.js - mode select (Play Solo / Create Group / Join Group) then the
// boot sequence: viewport + HUD + join controls. Mirrors client/game/app/
// bootstrap.js's structure, but boots against whichever transport the
// player picked (local/activeTransport.js) instead of a real WebSocket.

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

// bootFn: activeTransport's own entry point - localTransport.boot,
// webrtcTransport.createGroup, or webrtcTransport.joinGroup(code) already
// bound to its argument. Everything past this point is identical
// regardless of which transport is running underneath, since it all
// operates on the shared `game` state that packetApplier populates the
// same way no matter where the packets actually came from.
async function start(bootFn) {
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

    await bootFn(); // engine + client physics worlds - already frame-spaced internally
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

// Switches from the mode-select screen to the full loading-spinner screen
// and runs the rest of the shared boot chain (start(), above). bootFn here
// has nothing network-risky left to do - any connection attempt that
// could fail (minting a room code, reaching a P2P host) already happened
// and already succeeded, back on the mode-select screen (see below) -
// keeping that distinction is what let a failed join earlier NOT end up
// corrupting #loadingOverlay's DOM (start()'s catch block sets
// .textContent on it, which - being a parent with child elements, not a
// leaf - would silently delete its spinner/text children forever, breaking
// every future attempt to show it again, not just this one).
function beginBoot(transport, bootFn) {
  activeTransport = transport;
  document.getElementById('modeSelect').classList.add('hidden');
  document.getElementById('loadingOverlay').classList.remove('hidden');
  start(bootFn);
}

function initModeSelect() {
  var status   = document.getElementById('modeSelectStatus');
  var soloBtn  = document.getElementById('playSoloBtn');
  var createBtn = document.getElementById('createGroupBtn');
  var joinBtn  = document.getElementById('joinGroupBtn');

  function setButtonsDisabled(disabled) {
    soloBtn.disabled = disabled;
    createBtn.disabled = disabled;
    joinBtn.disabled = disabled;
  }

  initIdentityUI();

  // Carried across the reload packetApplier.js's 'kicked' handler triggers -
  // this is the first code on the mode-select screen to run afterward.
  try {
    var kickedReason = sessionStorage.getItem('bambipro_kicked_reason');
    if (kickedReason) {
      status.textContent = kickedReason;
      sessionStorage.removeItem('bambipro_kicked_reason');
    }
  } catch (err) {}

  soloBtn.addEventListener('click', function () {
    beginBoot(localTransport, localTransport.boot);
  });

  createBtn.addEventListener('click', function () {
    setButtonsDisabled(true);
    status.textContent = 'Creating group…';
    var password = document.getElementById('createGroupPassword').value;
    webrtcTransport.createGroup(password, currentIdentity()).then(function () {
      setButtonsDisabled(false);
      // Already fully connected+joined at this point (createGroup's own
      // promise doesn't resolve until gi.start() has run) - beginBoot's
      // bootFn just needs to hand that back, nothing left to await.
      beginBoot(webrtcTransport, function () { return Promise.resolve(); });
    }).catch(function (err) {
      setButtonsDisabled(false);
      status.textContent = 'Could not create group: ' + err.message;
    });
  });

  function tryJoin() {
    var code = document.getElementById('joinGroupCode').value.trim();
    if (!code) { status.textContent = 'Enter a room code first.'; return; }
    var password = document.getElementById('joinGroupPassword').value;
    setButtonsDisabled(true);
    status.textContent = 'Connecting to host…';

    webrtcTransport.joinGroup(code, password, currentIdentity()).then(function () {
      setButtonsDisabled(false);
      beginBoot(webrtcTransport, function () { return Promise.resolve(); });
    }).catch(function (err) {
      // Bad code, host offline, or (no TURN server - accepted gap) a
      // strict NAT couldn't reach them directly. Stays right here on
      // mode select with the code still in the box, not stranded on a
      // stuck loading screen.
      setButtonsDisabled(false);
      status.textContent = 'Could not join: ' + err.message;
    });
  }

  joinBtn.addEventListener('click', tryJoin);
  document.getElementById('joinGroupCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryJoin();
  });

  // Live, always-on-the-homepage list of currently-open rooms (worker/src/
  // roomDirectory.js) - clicking an open room's row joins it in one click;
  // a locked one (🔒) prompts for its password right there instead of
  // making you find and fill in a separate field. Refreshes on an
  // interval only while this screen is actually showing - self-cancels
  // once beginBoot() hides #modeSelect, rather than needing a separate
  // hook into that function.
  function emptyRoomListRow(text) {
    return '<tr class="roomListEmptyRow"><td colspan="4">' + text + '</td></tr>';
  }

  function refreshRoomList() {
    var container = document.getElementById('roomListRows');
    if (!container) return;
    fetch(webrtcTransport.workerUrl + '/api/rooms').then(function (res) { return res.json(); })
      .then(function (data) {
        var rooms = data.rooms || [];
        if (!rooms.length) { container.innerHTML = emptyRoomListRow('No open rooms right now'); return; }

        container.textContent = '';
        rooms.forEach(function (room) {
          var row = document.createElement('tr');

          var lockCell = document.createElement('td');
          lockCell.className = 'roomLockCol';
          lockCell.textContent = room.hasPassword ? '🔒' : '';
          row.appendChild(lockCell);

          var codeCell = document.createElement('td');
          codeCell.className = 'roomCodeCol';
          codeCell.textContent = room.code;
          row.appendChild(codeCell);

          var hostCell = document.createElement('td');
          hostCell.className = 'roomHostCol';
          hostCell.textContent = room.hostName;
          row.appendChild(hostCell);

          var playersCell = document.createElement('td');
          playersCell.className = 'roomPlayersCol';
          playersCell.textContent = room.playerCount;
          row.appendChild(playersCell);

          row.addEventListener('click', function () {
            document.getElementById('joinGroupCode').value = room.code;
            if (room.hasPassword) {
              var password = prompt('Password for room ' + room.code + ':');
              if (password === null) return; // cancelled
              document.getElementById('joinGroupPassword').value = password;
            }
            tryJoin();
          });

          container.appendChild(row);
        });
      })
      .catch(function () { container.innerHTML = emptyRoomListRow('Couldn’t load room list'); });
  }

  refreshRoomList();
  var roomListTimer = setInterval(function () {
    if (document.getElementById('modeSelect').classList.contains('hidden')) { clearInterval(roomListTimer); return; }
    refreshRoomList();
  }, 5000);

  // A room code shared as a link (menu.js's "Copy link" button appends
  // ?room=CODE) skips typing the code back in by hand - prefill it and
  // join immediately. Falls through to the normal mode-select screen,
  // code still in the box, on any failure (bad/stale code, host offline) -
  // same as a manually-typed join gone wrong, not a dead end.
  var linkedRoom = new URLSearchParams(location.search).get('room');
  if (linkedRoom) {
    document.getElementById('joinGroupCode').value = linkedRoom.toUpperCase();
    tryJoin();
  }
}

document.addEventListener('DOMContentLoaded', initModeSelect);
