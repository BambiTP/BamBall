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

function buildPlayerRow(p, isMe) {
  var row = document.createElement('div');
  row.className = 'playerRow';
  row.textContent = (p.name || 'Player ' + p.id) + (isMe ? ' (you)' : '');
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

  appEvents.on('roomCode:ready', function (code) {
    var el = document.getElementById('roomCodeText');
    if (el) el.textContent = code || 'unavailable';
  });
}
