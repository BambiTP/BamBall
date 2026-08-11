// joinUI.js - the whole UI beyond the viewport/HUD: two buttons. Reuses
// client/game/app/actions.js unchanged (same joinTeam/joinGame calls a
// real menu.js team-box click would make) - localTransport.js's `socket`
// shim is what makes that work with no server.

// fireInput.js's ball-click-to-open-settings path is leader-only - this
// build has no leader role or settings panel to open, so it's always off.
function isLeader() {
  return false;
}

var joinUIReady = false;

// Not clickable until main.js's full boot chain (map, textures, manifest)
// has actually finished - drawPlayer() (client/game/render/playerRenderer.js)
// silently no-ops if this.sprites isn't populated yet
// (`if (!tex) return;`), and nothing ever retries it once textures do
// arrive, so joining too early left the ball permanently invisible with
// no error at all. Real bug, found from a live report - not hypothetical.
function enableJoinUI() {
  joinUIReady = true;
  var redBtn  = document.getElementById('joinRedBtn');
  var blueBtn = document.getElementById('joinBlueBtn');
  redBtn.disabled  = false;
  blueBtn.disabled = false;
}

function initJoinUI() {
  var redBtn  = document.getElementById('joinRedBtn');
  var blueBtn = document.getElementById('joinBlueBtn');
  redBtn.disabled  = true;
  blueBtn.disabled = true;

  function join(team) {
    if (!joinUIReady) return;
    redBtn.disabled  = true;
    blueBtn.disabled = true;
    redBtn.classList.add('hidden');
    blueBtn.classList.add('hidden');
    actions.joinTeam(team);
    actions.joinGame();
  }

  redBtn.addEventListener('click', function () { join('red'); });
  blueBtn.addEventListener('click', function () { join('blue'); });

  appEvents.on('error', function (message) {
    // join_game can fail (already in, bad team) - re-show the buttons
    // rather than leaving the player stuck with no way to retry.
    redBtn.disabled  = false;
    blueBtn.disabled = false;
    redBtn.classList.remove('hidden');
    blueBtn.classList.remove('hidden');
    console.error('[joinUI]', message);
  });
}
