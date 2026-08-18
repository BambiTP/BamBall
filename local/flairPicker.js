// flairPicker.js - the flair picker modal: a grid of every icon in the
// shared flair spritesheet (assets/sprites/flair.png - a real TagPro flair
// sheet, see https://tagpro.koalabeast.com/flair), plus a "None" tile. One
// modal, opened from either the homepage (#flairPickerBtn, visible before
// any room exists) or the Esc menu's Settings panel (#menuFlairPickerBtn,
// for changing it mid-session) - same grid, built once on first open.
//
// Selecting an icon always saves to localSettings (client/state.js) so it's
// remembered across sessions and picked up by local/tagproLogin.js's
// currentIdentity() the next time a group is created/joined. If a room is
// ALREADY connected (socket exists), it also sends the change live via
// actions.setFlair - see local/hostSession.js's 'identify' case - so
// teammates see the new flair without needing to leave and rejoin.
//
// Deliberately NOT fetched from a real TagPro account (unlike the name/auth
// half of identity, tagproLogin.js/tagproAuthLib.js) - anyone can pick any
// icon, purely cosmetic, same as BambiTP/Tagpro-Next's own flair picker.

var FLAIR_PICKER_PITCH = 18; // px - see client/render/playerRenderer.js's FLAIR_PITCH, must match

var flairPickerBuilt = false;

function buildFlairPickerGrid() {
  var grid = document.getElementById('flairPickerGrid');
  if (!grid) return;

  var img = new Image();
  img.onload = function () {
    var cols = Math.floor(img.naturalWidth  / FLAIR_PICKER_PITCH);
    var rows = Math.floor(img.naturalHeight / FLAIR_PICKER_PITCH);

    grid.textContent = '';

    var noneTile = document.createElement('button');
    noneTile.type = 'button';
    noneTile.className = 'flairIcon flairIconNone';
    noneTile.title = 'None';
    noneTile.addEventListener('click', function () { selectFlair(null); });
    grid.appendChild(noneTile);

    var total = cols * rows;
    for (var index = 0; index < total; index++) {
      var col = index % cols;
      var row = Math.floor(index / cols);
      var tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'flairIcon';
      tile.style.setProperty('--flair-col', col);
      tile.style.setProperty('--flair-row', row);
      tile.dataset.flairIndex = index;
      tile.addEventListener('click', function () { selectFlair(parseInt(this.dataset.flairIndex, 10)); });
      grid.appendChild(tile);
    }

    renderFlairPickerSelection();
  };
  img.onerror = function () { grid.textContent = 'Could not load the flair sheet.'; };
  img.src = GAME_BASE_PATH + 'assets/sprites/flair.png';
}

function renderFlairPickerSelection() {
  var grid = document.getElementById('flairPickerGrid');
  if (!grid) return;
  var current = localSettings.flairIndex;
  var tiles = grid.querySelectorAll('.flairIcon');
  for (var i = 0; i < tiles.length; i++) {
    var tile = tiles[i];
    var isNone = tile.classList.contains('flairIconNone');
    var selected = isNone ? (current === null || current === undefined) : (parseInt(tile.dataset.flairIndex, 10) === current);
    tile.classList.toggle('selected', selected);
  }
}

function selectFlair(index) {
  localSettings.flairIndex = index;
  saveLocalSettings();
  renderFlairPickerSelection();

  // Only meaningful once actually connected - socket doesn't exist yet on
  // the homepage's mode-select screen, where this just saves the
  // preference for the join that's about to happen (local/tagproLogin.js's
  // currentIdentity() reads it from here).
  if (typeof socket !== 'undefined' && socket) actions.setFlair(index);
}

function openFlairPicker() {
  var modal = document.getElementById('flairPickerModal');
  if (!modal) return;
  if (!flairPickerBuilt) { flairPickerBuilt = true; buildFlairPickerGrid(); }
  else renderFlairPickerSelection();
  modal.classList.remove('hidden');
}

function closeFlairPicker() {
  var modal = document.getElementById('flairPickerModal');
  if (modal) modal.classList.add('hidden');
}

function initFlairPicker() {
  var closeBtn = document.getElementById('flairPickerCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeFlairPicker);

  var homeBtn = document.getElementById('flairPickerBtn');
  if (homeBtn) homeBtn.addEventListener('click', openFlairPicker);

  var menuBtn = document.getElementById('menuFlairPickerBtn');
  if (menuBtn) menuBtn.addEventListener('click', openFlairPicker);
}
