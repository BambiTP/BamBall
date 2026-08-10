// hud.js - score + match timer. Timer extrapolation logic itself lives in
// state/settingsState.js (phaseElapsedMs) - this file only formats and
// paints it, on a 250ms interval to stay smooth between matchState packets.

function formatClock(ms) {
  var totalSeconds = Math.max(0, Math.floor(ms / 1000));
  var minutes = Math.floor(totalSeconds / 60);
  var seconds = totalSeconds % 60;
  return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
}

function renderHudTimer() {
  var info = settingsState.matchInfo;
  var el = document.getElementById('hudTimer');
  if (!el) return;

  var elapsed = settingsState.phaseElapsedMs();

  if (info.state === 'countdown' && info.settings) {
    el.textContent = 'Starting ' + formatClock(Math.max(0, info.settings.countdownDuration - elapsed));
  } else if (info.state === 'live' && info.settings) {
    el.textContent = formatClock(Math.max(0, info.settings.timeLimit - elapsed));
  } else if (info.state === 'overtime') {
    el.textContent = 'OT ' + formatClock(elapsed);
  } else if (info.state === 'paused') {
    el.textContent = 'Paused';
  } else if (info.state === 'ended') {
    el.textContent = 'Ended';
  } else {
    el.textContent = '-:--';
  }
}

function updateHudScore(scores) {
  var el = document.getElementById('hudScore');
  if (el) el.textContent = 'Red ' + scores.red + ' - ' + scores.blue + ' Blue';
}

function initHud() {
  appEvents.on('score:changed', updateHudScore);
  settingsEvents.on('matchInfo:changed', function () {
    updateHudScore(settingsState.matchInfo.scores || { red: 0, blue: 0 });
    renderHudTimer();
  });
  setInterval(renderHudTimer, 250);
}
