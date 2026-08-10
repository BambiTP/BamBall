// joinUI.js - the whole UI beyond the viewport/HUD: two buttons. Reuses
// client/game/app/actions.js unchanged (same joinTeam/joinGame calls a
// real menu.js team-box click would make) - localTransport.js's `socket`
// shim is what makes that work with no server.

// fireInput.js's ball-click-to-open-settings path is leader-only - this
// build has no leader role or settings panel to open, so it's always off.
function isLeader() {
  return false;
}

function initJoinUI() {
  var redBtn  = document.getElementById('joinRedBtn');
  var blueBtn = document.getElementById('joinBlueBtn');

  function join(team) {
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
