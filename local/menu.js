// menu.js - the Esc menu: tab switching, and the Teams tab's roster.
// Textures/Settings Maker/Record & Files are separate files
// (texturePackPicker.js, settingsMaker.js, settingsFiles.js) that just
// render into this menu's panels - this file only owns the shell (open/
// close, tab switching) and the one tab simple enough not to need its own
// file.

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
  makerPanel: function () { initSettingsMaker(); },
};
var lazyTabDone = {};

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

// Kick/Mute/Ban are room-owner (=host) tools - activeTransport.role() is
// null for solo play and 'peer' for anyone who joined someone else's room,
// so this naturally renders nothing for either of those, no separate check
// needed beyond the isMe skip (a host can't kick/mute/ban themselves).
function buildPlayerRow(p, isMe) {
  var row = document.createElement('div');
  row.className = 'playerRow';

  var nameSpan = document.createElement('span');
  nameSpan.textContent = (p.name || 'Player ' + p.id) + (isMe ? ' (you)' : '');
  // Green = host-verified TagPro login (see local/tagproLogin.js and
  // webrtcTransport.js's 'identify' handling) - a trust signal that this
  // really is that TagPro account, not just a self-chosen name.
  if (p.authed) nameSpan.style.color = '#4caf50';
  row.appendChild(nameSpan);

  if (!isMe && typeof activeTransport !== 'undefined' && activeTransport && activeTransport.role && activeTransport.role() === 'host') {
    var muteBtn = document.createElement('button');
    muteBtn.className = 'menuBtn';
    muteBtn.style.cssText = 'padding:2px 8px;margin-left:8px;font-size:11px;';
    muteBtn.textContent = activeTransport.isMuted(p.id) ? 'Unmute' : 'Mute';
    muteBtn.addEventListener('click', function () {
      activeTransport.setMuted(p.id, !activeTransport.isMuted(p.id));
      renderTeams();
    });
    row.appendChild(muteBtn);

    var kickBtn = document.createElement('button');
    kickBtn.className = 'menuBtn';
    kickBtn.style.cssText = 'padding:2px 8px;margin-left:4px;font-size:11px;background:#a33;';
    kickBtn.textContent = 'Kick';
    kickBtn.addEventListener('click', function () { activeTransport.kickPeer(p.id); });
    row.appendChild(kickBtn);

    var banBtn = document.createElement('button');
    banBtn.className = 'menuBtn';
    banBtn.style.cssText = 'padding:2px 8px;margin-left:4px;font-size:11px;background:#700;';
    banBtn.textContent = 'Ban';
    banBtn.addEventListener('click', function () { activeTransport.banPeer(p.id); });
    row.appendChild(banBtn);
  }

  return row;
}

// Solo build today - only ever one player - but reads the real
// game.players list and team assignment, so this is already correct for
// however many peers eventually join over P2P.
function renderTeams() {
  var lists = {
    red: document.getElementById('redTeamList'),
    blue: document.getElementById('blueTeamList'),
    spectator: document.getElementById('spectatorTeamList'),
  };
  for (var team in lists) if (lists[team]) lists[team].textContent = '';

  for (var i = 0; i < game.players.length; i++) {
    var p = game.players[i];
    var list = lists[p.team];
    if (list) list.appendChild(buildPlayerRow(p, p.id === game.myId));
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
  renderTeams();

  function showRoomCode(code) {
    var el = document.getElementById('roomCodeText');
    if (el) el.textContent = code || 'unavailable';

    var copyBtn = document.getElementById('copyRoomLinkBtn');
    if (!copyBtn) return;
    if (!code) { copyBtn.style.display = 'none'; return; }
    copyBtn.style.display = '';
    copyBtn.onclick = function () {
      // Always "/", not location.pathname - this page IS index.html but is
      // never meant to be linked as /index.html (GitHub Pages serves it at
      // "/" directly, matching the clean-URL pattern already used for
      // /replays - see replays.html's own cross-links).
      var link = location.origin + '/?room=' + code;
      navigator.clipboard.writeText(link).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1500);
      }).catch(function () {});
    };
  }

  // 'roomCode:ready' fires as soon as the code is minted, which for the
  // host happens INSIDE webrtcTransport.createGroup()'s promise chain -
  // well before main.js's beginBoot() ever calls start() (and therefore
  // this initMenu()). appEvents has no memory of past emits, so a listener
  // registered this late would silently miss an event that already fired,
  // leaving roomCodeText stuck on its placeholder forever even though the
  // room was created successfully. Read whatever activeTransport already
  // has synchronously (both createGroup and joinGroup set their internal
  // roomCode before this ever runs) so we're never dependent on winning
  // that race, then keep the listener too - solo mode has no
  // activeTransport.getRoomCode() yet at this point, and it's cheap
  // insurance either way.
  if (typeof activeTransport !== 'undefined' && activeTransport && activeTransport.getRoomCode) {
    showRoomCode(activeTransport.getRoomCode());
  }
  appEvents.on('roomCode:ready', showRoomCode);
}
