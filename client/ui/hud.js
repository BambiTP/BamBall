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

var CHAT_LOG_MAX_ROWS = 50; // trims oldest rows so a long match's chat can't grow the DOM forever

function appendChatMessage(name, text) {
  var log = document.getElementById('chatLog');
  if (!log) return;

  var row = document.createElement('div');
  row.className = 'chatRow';

  if (name) {
    var nameEl = document.createElement('span');
    nameEl.className = 'chatName';
    nameEl.textContent = name + ':';
    row.appendChild(nameEl);
  }
  row.appendChild(document.createTextNode(text));

  log.appendChild(row);
  while (log.children.length > CHAT_LOG_MAX_ROWS) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function initHud() {
  appEvents.on('score:changed', updateHudScore);
  appEvents.on('chat:message', appendChatMessage);
  settingsEvents.on('matchInfo:changed', function () {
    updateHudScore(settingsState.matchInfo.scores || { red: 0, blue: 0 });
    renderHudTimer();
  });
  setInterval(renderHudTimer, 250);
}
