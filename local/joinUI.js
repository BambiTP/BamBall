// joinUI.js - Join Red Team / Join Blue Team / Join Game / Leave Game /
// Leave Group. Reuses client/game/app/actions.js unchanged - localTransport.js's
// `socket` shim is what makes that work with no server.

// fireInput.js's ball-click-to-open-settings path is leader-only - this
// build has no leader role or settings panel to open, so it's always off.
function isLeader() {
  return false;
}

var joinUIReady = false;

// Not clickable until main.js's full boot chain (map, textures, manifest)
// has actually finished - drawPlayer() (client/game/render/playerRenderer.js)
// silently no-ops if this.sprites isn't populated yet, and nothing ever
// retries it once textures do arrive, so joining too early left the ball
// permanently invisible with no error at all. Real bug, found from a live
// report - not hypothetical.
function enableJoinUI() {
  joinUIReady = true;
  refreshJoinUI();
}

function refreshJoinUI() {
  var redBtn   = document.getElementById('joinRedBtn');
  var blueBtn  = document.getElementById('joinBlueBtn');
  var gameBtn  = document.getElementById('joinGameBtn');
  var leaveBtn = document.getElementById('leaveGameBtn');

  var team    = game.myTeam || null; // set by team:changed below
  var inGame  = game.myId !== null;

  redBtn.disabled   = !joinUIReady;
  blueBtn.disabled  = !joinUIReady;
  gameBtn.disabled  = !joinUIReady || inGame || (team !== 'red' && team !== 'blue');
  leaveBtn.disabled = !joinUIReady || !inGame;

  redBtn.classList.toggle('active', team === 'red');
  blueBtn.classList.toggle('active', team === 'blue');
}

function initJoinUI() {
  document.getElementById('joinRedBtn').addEventListener('click', function () {
    if (!joinUIReady) return;
    actions.joinTeam('red');
  });
  document.getElementById('joinBlueBtn').addEventListener('click', function () {
    if (!joinUIReady) return;
    actions.joinTeam('blue');
  });
  document.getElementById('joinGameBtn').addEventListener('click', function () {
    if (!joinUIReady) return;
    actions.joinGame();
  });
  document.getElementById('leaveGameBtn').addEventListener('click', function () {
    if (!joinUIReady) return;
    actions.leaveGame();
  });
  document.getElementById('leaveGroupBtn').addEventListener('click', function () {
    // No real "group"/lobby to return to in this solo/local build (that's
    // a P2P-era concept) - closest honest equivalent is starting fresh.
    socket.closeByUser();
    location.reload();
  });

  game.myTeam = null;
  appEvents.on('team:changed', function (team) { game.myTeam = team; refreshJoinUI(); });
  appEvents.on('spectating:changed', refreshJoinUI);
  appEvents.on('error', function (message) { console.error('[joinUI]', message); refreshJoinUI(); });

  refreshJoinUI();
}
