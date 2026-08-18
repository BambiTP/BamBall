// hud.js - score + match timer. Timer extrapolation logic itself lives in
// client/state.js (phaseElapsedMs) - this file only formats and
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

// Drawn on the canvas itself now (render/renderer.js's updateScoreboard),
// matching real TagPro's own in-game scoreboard - see that method's header
// comment. renderer may not exist yet the very first time this fires
// (initHud() runs before main.js creates it) - updateScoreboard no-ops
// safely until it does, same guard eggballRenderer's lazy init uses.
function updateHudScore(scores) {
  if (typeof renderer !== 'undefined' && renderer) renderer.updateScoreboard(scores);
}

// Round-trip time to whoever's authoritative for this session - the host's
// own local ping is a synchronous loopback (handleOutgoingFor calls
// dispatch in the same tick, see webrtcTransport.js's hostSocket), so it
// reads ~0ms; a peer's reflects the real P2P data channel to the host. The
// EMA smoothing itself lives in client/net.js (also feeds
// localInputApplier.js's input delay) - this just displays its output.
function updateHudPing(ms) {
  var el = document.getElementById('hudPing');
  if (el) el.textContent = Math.round(ms) + ' ms';
}

var CHAT_LOG_MAX_ROWS = 50; // trims oldest rows so a long match's chat can't grow the DOM forever
var CHAT_FADE_MS = 20000; // matches tagpro.js's own chat handler (setTimeout(..., 2e4))

// packet: engine/packetBuilders.js's chat() shape - { name, text, target,
// team, authed, leader }. Color-codes the sender the way tagpro.js's own
// chat handler does (team-tinted name, green for a leader, a checkmark for
// a verified TagPro login) and, for a team-restricted message, adds a
// team-colored left rule (see index.html's .chatRow--team CSS) - only the
// receiving team ever gets one of these at all (local/hostSession.js's
// broadcastToTeam), so there's no need to also recolor the message text.
function appendChatMessage(packet) {
  var log = document.getElementById('chatLog');
  if (!log) return;

  var row = document.createElement('div');
  row.className = 'chatRow';
  if (packet.target === 'team' && (packet.team === 'red' || packet.team === 'blue')) {
    row.classList.add('chatRow--team', 'chatRow--' + packet.team);
  }

  if (packet.name) {
    var nameEl = document.createElement('span');
    nameEl.className = 'chatName';
    nameEl.style.color = packet.team === 'red' ? 'var(--red-team)'
      : packet.team === 'blue' ? 'var(--blue-team)'
      : packet.leader ? 'var(--go)'
      : 'var(--accent)';
    nameEl.textContent = (packet.authed ? '✓ ' : '') + packet.name + ':';
    row.appendChild(nameEl);
  }
  row.appendChild(document.createTextNode(packet.text));

  log.appendChild(row);
  while (log.children.length > CHAT_LOG_MAX_ROWS) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;

  // Fades out of the collapsed view after CHAT_FADE_MS, same as real
  // TagPro's chat log - client/inputs.js's chat-focus/blur handling is what
  // actually toggles #chatLog's 'expanded' class (showing/hiding these).
  setTimeout(function () {
    row.dataset.expired = 'true';
    if (!log.classList.contains('expanded')) row.classList.add('chatRowFaded');
  }, CHAT_FADE_MS);
}

function initHud() {
  appEvents.on('score:changed', updateHudScore);
  appEvents.on('chat:message', appendChatMessage);
  appEvents.on('rtt:updated', updateHudPing);
  settingsEvents.on('matchInfo:changed', function () {
    updateHudScore(settingsState.matchInfo.scores || { red: 0, blue: 0 });
    renderHudTimer();
  });
  setInterval(renderHudTimer, 250);
}
