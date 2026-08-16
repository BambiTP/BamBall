// menu.js - the Esc menu: tab switching, and the Teams tab's roster.
// Textures/Settings are separate files (texturePackPicker.js,
// controlPanel.js) that just render into this menu's panels - this file
// only owns the shell (open/close, tab switching) and the one tab simple
// enough not to need its own file.

function toggleMenu() {
  document.getElementById('menu').classList.toggle('hidden');
}

// Tabs that build real DOM/fetch data (Textures, Settings Maker) only do
// so the first time they're actually opened, not at page load while
// they're sitting hidden - a hidden tab building a 50-tile grid + JSON
// fetch before the game has even booted is pure wasted work at exactly
// the moment the page is already doing the most (engine boot, texture
// fetch, physics world setup).
var lazyTabInit = {
  texturesPanel: function () { mountTexturePackPicker(document.getElementById('texturePackPicker'), { loggedIn: true }); },
  controlPanel: function () { initControlPanel(); },
};
var lazyTabDone = {};

// Set by renderTeams()/its solo fallback (leadership is roster-derived) -
// read back by renderPauseToggle() when a bare matchInfo:changed event
// fires with no roster info of its own attached.
var lastKnownLeader = false;

function switchMenuTab(tabId) {
  var buttons = document.querySelectorAll('.menuTabBtn');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('active', buttons[i].getAttribute('data-tab') === tabId);
  }
  var panels = document.querySelectorAll('.menuPanel');
  for (var j = 0; j < panels.length; j++) {
    panels[j].classList.toggle('hidden', panels[j].id !== tabId);
  }

  if (lazyTabInit[tabId] && !lazyTabDone[tabId]) {
    lazyTabDone[tabId] = true;
    lazyTabInit[tabId]();
  }
}

// Kick/Mute/Ban/Promote/Demote are leader tools - "leader" means the main
// leader (whoever is hosting, always) OR anyone that main leader (or
// another leader) has promoted, NOT just activeTransport.role() === 'host'
// any more: the whole point of promotion is that a peer with no special
// transport role can hold these powers too. myLeader (passed in from
// renderTeams, computed once per render off game.roster) is the actual
// gate; the isMe skip on top of it just stops a leader from kicking/
// muting/banning/demoting themselves.
function buildPlayerRow(p, isMe, myLeader) {
  var row = document.createElement('div');
  row.className = 'playerRow';

  var nameSpan = document.createElement('span');
  nameSpan.textContent = (p.name || 'Player ' + p.id) + (isMe ? ' (you)' : '');
  // Green = host-verified TagPro login (see local/tagproLogin.js and
  // webrtcTransport.js's 'identify' handling) - a trust signal that this
  // really is that TagPro account, not just a self-chosen name.
  if (p.authed) nameSpan.style.color = '#4caf50';
  row.appendChild(nameSpan);

  if (p.leader) {
    var badge = document.createElement('span');
    badge.style.cssText = 'margin-left:6px;font-size:10px;opacity:0.75;';
    badge.textContent = p.mainLeader ? '[Main Leader]' : '[Leader]';
    row.appendChild(badge);
  }

  if (!isMe && myLeader) {
    var muteBtn = document.createElement('button');
    muteBtn.className = 'menuBtn';
    muteBtn.style.cssText = 'padding:2px 8px;margin-left:8px;font-size:11px;';
    muteBtn.textContent = p.muted ? 'Unmute' : 'Mute';
    muteBtn.addEventListener('click', function () { actions.mutePlayer(p.id, !p.muted); });
    row.appendChild(muteBtn);

    // Kick/Ban/Demote never target the main leader - the host can't be
    // removed from their own room by a promoted leader (rejected host-side
    // too, see webrtcTransport.js's handleOutgoingFor; hidden here as well
    // so the buttons aren't even offered).
    if (!p.mainLeader) {
      var kickBtn = document.createElement('button');
      kickBtn.className = 'menuBtn';
      kickBtn.style.cssText = 'padding:2px 8px;margin-left:4px;font-size:11px;background:#a33;';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', function () { actions.kickPlayer(p.id); });
      row.appendChild(kickBtn);

      var banBtn = document.createElement('button');
      banBtn.className = 'menuBtn';
      banBtn.style.cssText = 'padding:2px 8px;margin-left:4px;font-size:11px;background:#700;';
      banBtn.textContent = 'Ban';
      banBtn.addEventListener('click', function () { actions.banPlayer(p.id); });
      row.appendChild(banBtn);

      var promoteBtn = document.createElement('button');
      promoteBtn.className = 'menuBtn';
      promoteBtn.style.cssText = 'padding:2px 8px;margin-left:4px;font-size:11px;';
      promoteBtn.textContent = p.leader ? 'Demote' : 'Promote';
      promoteBtn.addEventListener('click', function () {
        if (p.leader) actions.demoteLeader(p.id); else actions.promoteLeader(p.id);
      });
      row.appendChild(promoteBtn);
    }
  }

  return row;
}

// Solo build has no roster broadcast at all (nothing to promote/kick/ban
// when you're the only player), so game.roster stays empty there and this
// falls back to reading game.players directly, same as before roles
// existed. A P2P room (host or peer) gets a real roomState roster
// (game.roster - see app/packetApplier.js) that includes every connected
// client, spectators included, which game.players alone never did.
function renderTeams() {
  var lists = {
    red: document.getElementById('redTeamList'),
    blue: document.getElementById('blueTeamList'),
    spectator: document.getElementById('spectatorTeamList'),
  };
  for (var team in lists) if (lists[team]) lists[team].textContent = '';

  if (game.roster && game.roster.length) {
    var myEntry = game.roster.find(function (r) { return r.id === game.clientId; });
    var myLeader = !!(myEntry && myEntry.leader);

    lastKnownLeader = myLeader;

    for (var i = 0; i < game.roster.length; i++) {
      var r = game.roster[i];
      var list = lists[r.team] || lists.spectator;
      if (list) list.appendChild(buildPlayerRow(r, r.id === game.clientId, myLeader));
    }
    renderMatchControls(myLeader);
    return;
  }

  for (var j = 0; j < game.players.length; j++) {
    var p = game.players[j];
    var plist = lists[p.team];
    if (plist) plist.appendChild(buildPlayerRow(p, p.id === game.myId, false));
  }

  // The local player isn't in game.players until they've actually spawned
  // (Join Red/Blue) - show them as spectating before that, same as a real
  // client sees itself pre-join.
  if (game.myId === null) {
    var spectatorRow = document.createElement('div');
    spectatorRow.className = 'playerRow';
    spectatorRow.textContent = 'Player (you)';
    if (lists.spectator) lists.spectator.appendChild(spectatorRow);
  }
  lastKnownLeader = false;
  renderMatchControls(false);
}

// Start/Pause/Resume/Reset/End are leader-only match control - see
// engine/matchManager.js, wired through to the host's handleOutgoingFor by
// the leader-gated start_match/pause_match/resume_match/reset_game/
// end_match packets (local/webrtcTransport.js, node-host/hostCli.js).
function renderMatchControls(myLeader) {
  var box = document.getElementById('matchControls');
  if (box) box.style.display = myLeader ? '' : 'none';

  // Whole Control tab is leader-only, same reasoning as #matchControls -
  // its contents (live physics/match edits, map change, save states) are
  // all leader-gated server-side too, so a non-leader seeing the tab at
  // all would just be a dead end. If the tab happened to be open when
  // leadership is lost (demoted mid-session), fall back to Teams instead
  // of leaving an inaccessible panel on screen.
  var controlTabBtn = document.querySelector('.menuTabBtn[data-tab="controlPanel"]');
  if (controlTabBtn) {
    controlTabBtn.classList.toggle('hidden', !myLeader);
    if (!myLeader && controlTabBtn.classList.contains('active')) switchMenuTab('teamsPanel');
  }

  renderPauseToggle();
}

// Which of Pause/Resume applies right now, or null when neither does
// (pregame/ended - toggling either would just get rejected server-side, so
// don't even show a button that can't do anything). Only matchManager's own
// state names appear here (see engine/matchManager.js's state machine) -
// this has no state of its own, it's a pure read of settingsState.matchInfo.
function pauseToggleMode() {
  var state = settingsState.matchInfo.state;
  if (state === 'live' || state === 'countdown' || state === 'overtime') return 'pause';
  if (state === 'paused') return 'resume';
  return null;
}

// Drives BOTH the in-menu Pause/Resume buttons and the persistent HUD
// toggle (#hudPauseToggle, index.html - lives outside the Esc menu so a
// leader never has to open the menu just to pause) from the one state read
// above. lastKnownLeader is set by renderTeams()/its solo fallback, since
// leadership is roster-derived and this can also be called from a pure
// matchInfo:changed event that carries no roster info of its own.
function renderPauseToggle() {
  var mode = lastKnownLeader ? pauseToggleMode() : null;

  var pauseBtn  = document.getElementById('matchPauseBtn');
  var resumeBtn = document.getElementById('matchResumeBtn');
  if (pauseBtn)  pauseBtn.classList.toggle('hidden', mode !== 'pause');
  if (resumeBtn) resumeBtn.classList.toggle('hidden', mode !== 'resume');

  var hudBtn = document.getElementById('hudPauseToggle');
  if (!hudBtn) return;
  hudBtn.classList.toggle('hidden', !mode);
  if (!mode) return;
  hudBtn.textContent = mode === 'pause' ? 'Pause' : 'Resume';
  hudBtn.classList.toggle('isPaused', mode === 'resume');
}

function initMatchControls() {
  var startBtn  = document.getElementById('matchStartBtn');
  var pauseBtn  = document.getElementById('matchPauseBtn');
  var resumeBtn = document.getElementById('matchResumeBtn');
  var resetBtn  = document.getElementById('matchResetBtn');
  var endBtn    = document.getElementById('matchEndBtn');
  var hudBtn    = document.getElementById('hudPauseToggle');
  if (startBtn)  startBtn.addEventListener('click', function () { actions.startMatch(); });
  if (pauseBtn)  pauseBtn.addEventListener('click', function () { actions.pauseMatch(); });
  if (resumeBtn) resumeBtn.addEventListener('click', function () { actions.resumeMatch(); });
  if (resetBtn)  resetBtn.addEventListener('click', function () { actions.resetGame(); });
  if (endBtn)    endBtn.addEventListener('click', function () { actions.endMatch(); });
  if (hudBtn) {
    hudBtn.addEventListener('click', function () {
      if (pauseToggleMode() === 'resume') actions.resumeMatch(); else actions.pauseMatch();
    });
  }

  settingsEvents.on('matchInfo:changed', renderPauseToggle);
}

function initMenu() {
  appEvents.on('menu:toggle', toggleMenu);

  var tabButtons = document.querySelectorAll('.menuTabBtn');
  for (var i = 0; i < tabButtons.length; i++) {
    tabButtons[i].addEventListener('click', function (event) {
      switchMenuTab(event.currentTarget.getAttribute('data-tab'));
    });
  }

  gameEvents.on('player:created', renderTeams);
  gameEvents.on('player:removed', renderTeams);
  appEvents.on('spectating:changed', renderTeams);
  appEvents.on('team:changed', renderTeams);
  appEvents.on('roster:changed', renderTeams);
  initMatchControls();
  renderTeams();

  // The game's own directory, with any existing /group/<code> suffix or
  // index.html stripped and a guaranteed trailing "/" - e.g. "/"
  // (Cloudflare Pages, a domain root) or "/BamBall/" (a GitHub Pages
  // project page serves this repo under /<repo-name>/, not "/").
  function baseGamePath() {
    return location.pathname.replace(/\/group\/[A-Za-z0-9]+\/?$/, '/').replace(/[^/]*$/, '');
  }

  function showGroupCode(code) {
    var el = document.getElementById('groupCodeText');
    if (el) el.textContent = code || 'unavailable';

    var copyBtn = document.getElementById('copyGroupLinkBtn');
    if (copyBtn) {
      if (!code) {
        copyBtn.style.display = 'none';
      } else {
        copyBtn.style.display = '';
        copyBtn.onclick = function () {
          // A real /group/<code> path, not a "?group=" query string - see
          // 404.html for how that resolves without a server-side router.
          // Reads better pasted into a chat/Discord, and matches what the
          // address bar itself shows once replaceState below runs.
          var link = location.origin + baseGamePath() + 'group/' + code;
          navigator.clipboard.writeText(link).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1500);
          }).catch(function () {});
        };
      }
    }

    // Shows the real, clean /group/<code> path in the address bar the
    // moment the code is known - whether that's from creating a group,
    // typing one in by hand, or following a link (main.js's linkedGroup
    // handling lands here via a ?group=<code> query string, not the clean
    // path itself, so without this the address bar would say one thing
    // while "Copy link" hands out another). replaceState, never
    // assign/href - this must never actually trigger a navigation/reload.
    //
    // Purely cosmetic for the address bar - every asset fetch elsewhere in
    // the codebase is anchored to window.GAME_BASE_PATH (see index.html's
    // very first inline script), captured before this can ever run, so
    // nothing downstream cares what replaceState does to location.pathname
    // here or whether it ends in a trailing slash.
    if (code) history.replaceState(null, '', baseGamePath() + 'group/' + code);
  }

  // 'roomCode:ready' fires as soon as the code is minted, which for the
  // host happens INSIDE webrtcTransport.createGroup()'s promise chain -
  // well before main.js's beginBoot() ever calls start() (and therefore
  // this initMenu()). appEvents has no memory of past emits, so a listener
  // registered this late would silently miss an event that already fired,
  // leaving groupCodeText stuck on its placeholder forever even though the
  // group was created successfully. Read whatever activeTransport already
  // has synchronously (both createGroup and joinGroup set their internal
  // roomCode before this ever runs) so we're never dependent on winning
  // that race, then keep the listener too - solo mode has no
  // activeTransport.getRoomCode() yet at this point, and it's cheap
  // insurance either way.
  if (typeof activeTransport !== 'undefined' && activeTransport && activeTransport.getRoomCode) {
    showGroupCode(activeTransport.getRoomCode());
  }
  appEvents.on('roomCode:ready', showGroupCode);
}
