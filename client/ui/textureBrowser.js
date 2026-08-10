// textureBrowser.js - the curated-theme + custom-upload picker grid shared
// by the Personal tab's texture pack picker, the Global Textures panel, and
// the per-cell Cell Texture section. One implementation instead of three.
//
// Also owns the shared search/group/dropzone building blocks all three
// panels use for their "list of customizable slots" view, so a 40+ row
// flat list doesn't have to be redesigned three separate times.

// "blueFlagTaken" -> "Blue Flag Taken" - tile folder names are camelCase,
// sometimes with a leading color.
function formatTileLabel(tileName) {
  var spaced = tileName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Prefers a tile's server-assigned label (db.js TILE_LABEL_OVERRIDES) over
// formatting its tileName - needed for ids that share one tileName/sprite
// with siblings (the three empty-portal states) but shouldn't show as
// identical, undifferentiated rows.
function tileDisplayLabel(tile) {
  return tile.label || formatTileLabel(tile.tileName);
}

// Every tile-slot name sorted into a display category. Purely a client-side
// grouping heuristic over the tileName string (order-sensitive, first match
// wins) - there's no server-side category for texture *slots* the way
// tileCatalog.categoryOf covers placed map tiles, so this stays a small,
// self-contained regex table rather than reaching for that instead.
var TILE_GROUP_ORDER = [
  'Terrain', 'Players', 'Flags', 'Gates', 'Elements', 'Portal',
  'Hazards', 'Gravity Wells', 'Pups', 'Misc', 'Other',
];

function groupLabelForTileName(tileName) {
  if (tileName === 'walls' || tileName === 'floor') return 'Terrain';
  if (/Ball$/.test(tileName)) return 'Players';
  if (/Flag|Potato/.test(tileName)) return 'Flags';
  if (/Gate/.test(tileName)) return 'Gates';
  // Checked before the general bomb match below - rolling bomb is a pup
  // (a timed buff), not a placed map element like the ground bomb tile.
  if (tileName === 'rollingBomb') return 'Pups';
  if (/boost|bomb/i.test(tileName)) return 'Elements';
  if (/portal/i.test(tileName)) return 'Portal';
  if (/Goal|TeamTile/.test(tileName) || tileName === 'button') return 'Misc';
  if (/spike/i.test(tileName)) return 'Hazards';
  if (/gravityWell/i.test(tileName)) return 'Gravity Wells';
  if (tileName === 'jukeJuice' || tileName === 'speed' || tileName === 'tagpro' || tileName === 'emptyPup') return 'Pups';
  return 'Other';
}


// Local (already-fetched) filter for an options grid - themes/uploads
// rarely exceed a few dozen entries per slot, so this is just a substring
// match, no server round-trip.
function filterTextureOptions(options, searchTerm) {
  var term = (searchTerm || '').trim().toLowerCase();
  if (!term) return options;
  return options.filter(function (option) {
    return option.label.toLowerCase().indexOf(term) !== -1;
  });
}

// Makes `dropEl` accept a dragged-and-dropped image file into `fileInput`
// (so the existing uploadCustomTexture(tileId, fileInput, ...) call sites
// need no changes), and makes clicking anywhere on it open the file picker
// too rather than requiring the tiny native "Choose File" button.
function wireDropzone(dropEl, fileInput) {
  function setActive(on) { dropEl.classList.toggle('tppDropActive', on); }

  dropEl.addEventListener('dragenter', function (e) { e.preventDefault(); setActive(true); });
  dropEl.addEventListener('dragover', function (e) { e.preventDefault(); setActive(true); });
  dropEl.addEventListener('dragleave', function (e) { e.preventDefault(); setActive(false); });
  dropEl.addEventListener('drop', function (e) {
    e.preventDefault();
    setActive(false);
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      fileInput.files = files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });
  dropEl.addEventListener('click', function (e) {
    if (e.target !== fileInput) fileInput.click();
  });
}

// ---- shared texture-picker modal --------------------------------------
// The one interaction every picker (Personal, Global Textures, Cell
// Texture) uses: click a slot -> a modal opens over everything with a
// search box and a scrollable grid of every option -> click one (or the
// synthetic "clear" option, if allowClear) -> it fires immediately and the
// modal closes. There's no per-modal "confirm" step - picking IS the
// action; whatever staging/apply-all model the caller wants (Global
// Textures and the Personal picker both still batch multiple picks behind
// a separate Apply All) lives entirely in onPick, not in here.
//
// Built once (module-level singleton appended to <body>) and reused for
// every open() call, since only one can be meaningfully open at a time.

var textureModalEl = null;
var textureModalState = null; // { tileId, allowClear, clearLabel, clearPreviewUrl, onPick, uploadable, searchTerm, allOptions }

function ensureTextureModal() {
  if (textureModalEl) return textureModalEl;

  var backdrop = document.createElement('div');
  backdrop.className = 'tppModalBackdrop hidden';

  var modal = document.createElement('div');
  modal.className = 'tppModal';
  backdrop.appendChild(modal);

  var header = document.createElement('div');
  header.className = 'tppModalHeader';
  var title = document.createElement('span');
  title.className = 'tppModalTitle';
  header.appendChild(title);
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tppIconBtn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close';
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // One tab per tile whose sprites can fill this slot. Present only for the
  // per-tile editor (opts.sourceTabs); the pack gallery has no notion of a
  // source tile.
  var sourceTabs = document.createElement('div');
  sourceTabs.className = 'tppSourceTabs hidden';
  modal.appendChild(sourceTabs);

  var search = document.createElement('input');
  search.type = 'search';
  search.className = 'tppSearch';
  search.placeholder = 'Search themes…';
  modal.appendChild(search);

  var grid = document.createElement('div');
  grid.className = 'tppGrid';
  modal.appendChild(grid);

  var dropzone = document.createElement('div');
  dropzone.className = 'tppDropzone hidden';
  var hint = document.createElement('div');
  hint.className = 'tppDropzoneHint';
  hint.textContent = 'Drop an image here, or click to upload';
  dropzone.appendChild(hint);
  var labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Name this texture';
  labelInput.maxLength = 60;
  dropzone.appendChild(labelInput);
  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.className = 'tppFileInput';
  dropzone.appendChild(fileInput);
  var uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.textContent = 'Upload';
  dropzone.appendChild(uploadBtn);
  modal.appendChild(dropzone);
  wireDropzone(dropzone, fileInput);

  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', function (event) {
    if (event.target === backdrop) closeTextureModal();
  });
  closeBtn.addEventListener('click', closeTextureModal);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !backdrop.classList.contains('hidden')) closeTextureModal();
  });
  search.addEventListener('input', function (event) {
    if (!textureModalState) return;
    textureModalState.searchTerm = event.target.value;
    renderTextureModalGrid();
  });
  uploadBtn.addEventListener('click', function () {
    if (!textureModalState) return;
    var state = textureModalState;
    uploadCustomTexture(state.tileId, fileInput, labelInput, uploadBtn, function (uploaded) {
      if (textureModalState !== state || !uploaded || !uploaded.spriteId) return;
      state.onPick({ spriteId: uploaded.spriteId, previewUrl: uploaded.previewUrl, label: 'upload' });
      closeTextureModal();
    });
  });

  textureModalEl = {
    backdrop: backdrop, title: title, search: search, grid: grid,
    sourceTabs: sourceTabs,
    dropzone: dropzone, labelInput: labelInput, fileInput: fileInput,
  };
  return textureModalEl;
}

function closeTextureModal() {
  if (!textureModalEl) return;
  textureModalEl.backdrop.classList.add('hidden');
  textureModalState = null;
}

// One tab per tile that can supply a sprite for the open slot. Switching
// tabs refetches that tile's themes into the same grid.
function renderSourceTabs() {
  var m = textureModalEl;
  var state = textureModalState;
  m.sourceTabs.textContent = '';

  if (!state.sourceTabs || !state.sources || state.sources.length < 2) {
    m.sourceTabs.classList.add('hidden');
    return;
  }
  m.sourceTabs.classList.remove('hidden');

  state.sources.forEach(function (tileName) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tppSourceTab' + (tileName === state.sourceTileName ? ' active' : '');
    btn.textContent = formatTileLabel(tileName);
    btn.addEventListener('click', function () {
      if (tileName === state.sourceTileName) return;
      state.sourceTileName = tileName;
      state.allOptions = null;
      state.searchTerm = '';
      m.search.value = '';
      renderTextureModalGrid();
    });
    m.sourceTabs.appendChild(btn);
  });
}

function renderTextureModalGrid() {
  var m = textureModalEl;
  var state = textureModalState;
  if (!state) return;

  if (!state.allOptions) {
    // A caller with its options in hand already skips the per-tile fetch
    // entirely - there's no tileId to fetch for.
    if (state.presetOptions) {
      state.allOptions = state.presetOptions;
      renderTextureModalGrid();
      return;
    }
    m.grid.textContent = 'Loading...';
    fetchTextureOptionsFor(state.tileId, state.sourceTileName).then(function (result) {
      if (textureModalState !== state) return;
      state.sources = result.sources;
      state.sourceTileName = result.sourceTileName;
      state.allOptions = state.allowClear
        ? [{ spriteId: null, previewUrl: state.clearPreviewUrl || null, label: state.clearLabel || 'Player textures' }].concat(result.options)
        : result.options;
      renderSourceTabs();
      renderTextureModalGrid();
    });
    return;
  }

  m.grid.textContent = '';
  var filtered = filterTextureOptions(state.allOptions, state.searchTerm);
  if (!filtered.length) {
    m.grid.textContent = 'No themes match "' + state.searchTerm + '".';
    return;
  }
  filtered.forEach(function (option) {
    m.grid.appendChild(buildTextureOptionCell(option.spriteId, option.previewUrl, option.label, state.currentSpriteId, function () {
      state.onPick(option);
      closeTextureModal();
    }));
  });
}

// opts: { tileId, title, currentSpriteId, onPick(option), allowClear,
// clearLabel, clearPreviewUrl, uploadable }. option passed to onPick is
// always { spriteId, previewUrl, label } - spriteId is null for the
// synthetic clear option.
function openTextureModal(opts) {
  var m = ensureTextureModal();
  textureModalState = {
    tileId: opts.tileId,
    currentSpriteId: opts.currentSpriteId,
    onPick: opts.onPick,
    allowClear: !!opts.allowClear,
    clearLabel: opts.clearLabel,
    clearPreviewUrl: opts.clearPreviewUrl,
    searchTerm: '',
    allOptions: null,
    presetOptions: opts.options || null,
    // Cross-tile browsing: show a tab per source tile so any sprite can
    // fill this slot, not just the ones from its own tile folder.
    sourceTabs: !!opts.sourceTabs,
    sources: null,
    sourceTileName: null,
  };
  m.title.textContent = opts.title || '';
  m.search.value = '';
  m.labelInput.value = '';
  m.fileInput.value = '';
  m.sourceTabs.textContent = '';
  m.sourceTabs.classList.add('hidden');
  m.dropzone.classList.toggle('hidden', !opts.uploadable);
  m.backdrop.classList.remove('hidden');
  renderTextureModalGrid();
}

// ---- Change All confirmation step ----------------------------------------
// A second, separate modal (its own backdrop, stacks on top of nothing
// since openTextureModal has already closed itself by the time this opens)
// listing every tile the chosen theme actually covers - and how many it
// doesn't, which keep their current texture instead of being cleared.
// Confirm is the only thing that runs the caller's onConfirm; Cancel/Esc/
// backdrop-click just closes and nothing changes.
var changeAllConfirmEl = null;
var changeAllConfirmState = null; // { theme, onConfirm }

function ensureChangeAllConfirmModal() {
  if (changeAllConfirmEl) return changeAllConfirmEl;

  var backdrop = document.createElement('div');
  backdrop.className = 'tppModalBackdrop hidden';

  var modal = document.createElement('div');
  modal.className = 'tppModal';
  backdrop.appendChild(modal);

  var header = document.createElement('div');
  header.className = 'tppModalHeader';
  var title = document.createElement('span');
  title.className = 'tppModalTitle';
  header.appendChild(title);
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tppIconBtn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Cancel';
  header.appendChild(closeBtn);
  modal.appendChild(header);

  var note = document.createElement('p');
  note.className = 'tppNotice';
  modal.appendChild(note);

  var list = document.createElement('div');
  list.className = 'tppGrid';
  modal.appendChild(list);

  var footer = document.createElement('div');
  footer.className = 'tppApplyRow';
  var confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'tppApplyBtn';
  confirmBtn.textContent = 'Confirm';
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  footer.appendChild(confirmBtn);
  footer.appendChild(cancelBtn);
  modal.appendChild(footer);

  document.body.appendChild(backdrop);

  function close() {
    backdrop.classList.add('hidden');
    changeAllConfirmState = null;
  }

  backdrop.addEventListener('click', function (event) { if (event.target === backdrop) close(); });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', function () {
    if (!changeAllConfirmState) return;
    var onConfirm = changeAllConfirmState.onConfirm;
    var excludedTileIds = Object.keys(changeAllConfirmState.excluded || {});
    close();
    onConfirm(excludedTileIds);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
  });

  changeAllConfirmEl = { backdrop: backdrop, title: title, note: note, list: list };
  return changeAllConfirmEl;
}

// Sorts `tiles` (each needs a .tileName) into the same fixed category
// order/grouping the rest of this file uses (groupLabelForTileName,
// TILE_GROUP_ORDER) - so this list reads the same way as every other tile
// list in the app instead of an arbitrary/alphabetical dump.
function groupTilesForPreview(tiles) {
  var groups = {};
  tiles.forEach(function (tile) {
    var group = groupLabelForTileName(tile.tileName);
    (groups[group] || (groups[group] = [])).push(tile);
  });
  var ordered = [];
  TILE_GROUP_ORDER.forEach(function (group) {
    var list = groups[group];
    if (!list || !list.length) return;
    list.sort(function (a, b) { return tileDisplayLabel(a).localeCompare(tileDisplayLabel(b)); });
    ordered.push({ group: group, tiles: list });
  });
  return ordered;
}

function openChangeAllConfirm(theme, onConfirm) {
  var m = ensureChangeAllConfirmModal();
  changeAllConfirmState = { theme: theme, onConfirm: onConfirm, excluded: {} };
  m.title.textContent = 'Change all to "' + theme + '"';
  m.note.textContent = '';
  m.list.textContent = 'Loading…';
  m.backdrop.classList.remove('hidden');

  fetch('/api/sprites/themes/' + encodeURIComponent(theme) + '/preview').then(function (res) { return res.json(); }).then(function (data) {
    if (!changeAllConfirmState || changeAllConfirmState.theme !== theme) return; // superseded by a newer pick

    var covered = (data.tiles || []).filter(function (t) { return t.covered; });
    var skipped = (data.tiles || []).length - covered.length;
    m.note.textContent = 'Click a tile to exclude it from this change. '
      + (skipped
        ? (skipped + ' tile' + (skipped === 1 ? '' : 's') + ' this theme doesn\'t cover will keep their current texture regardless.')
        : '');
    renderChangeAllConfirmList(m, covered);
  }).catch(function () {
    if (changeAllConfirmState && changeAllConfirmState.theme === theme) m.list.textContent = 'Failed to load preview.';
  });
}

// Re-rendered on every exclude toggle - cheap (at most a few dozen cells)
// and keeps the gray-out state trivially in sync with changeAllConfirmState.excluded.
function renderChangeAllConfirmList(m, covered) {
  var state = changeAllConfirmState;
  m.list.textContent = '';
  groupTilesForPreview(covered).forEach(function (group) {
    var header = document.createElement('div');
    header.className = 'tppGroupHeader';
    var title = document.createElement('span');
    title.textContent = group.group;
    header.appendChild(title);
    var count = document.createElement('span');
    count.className = 'tppGroupCount';
    count.textContent = group.tiles.length;
    header.appendChild(count);
    m.list.appendChild(header);

    group.tiles.forEach(function (tile) {
      var excluded = !!state.excluded[tile.tileId];
      var cell = document.createElement('div');
      cell.className = 'tppOption tppOptionStatic';
      if (excluded) cell.classList.add('tppOptionExcluded');
      cell.title = excluded ? 'Excluded - click to include it again' : 'Click to exclude from this change';

      var img = document.createElement('img');
      img.src = tile.previewUrl;
      img.alt = tile.tileName;
      cell.appendChild(img);
      var name = document.createElement('span');
      name.textContent = tileDisplayLabel(tile);
      cell.appendChild(name);

      cell.addEventListener('click', function () {
        if (state.excluded[tile.tileId]) delete state.excluded[tile.tileId];
        else state.excluded[tile.tileId] = true;
        renderChangeAllConfirmList(m, covered);
      });
      m.list.appendChild(cell);
    });
  });
}

function buildTextureOptionCell(spriteId, previewUrl, label, currentSpriteId, onPick) {
  var cellBtn = document.createElement('button');
  cellBtn.type = 'button';
  cellBtn.className = 'tppOption';
  if (spriteId === currentSpriteId) cellBtn.classList.add('active');

  var img = document.createElement('img');
  img.src = previewUrl;
  img.alt = label;
  cellBtn.appendChild(img);

  var name = document.createElement('span');
  name.textContent = label;
  cellBtn.appendChild(name);

  cellBtn.addEventListener('click', function () { onPick(spriteId); });
  return cellBtn;
}

// Curated theme options + the leader's own uploads for one tile id, merged
// into one list. Never rejects - a failed fetch just contributes nothing.
// sourceTileName (optional): browse a DIFFERENT tile's sprites for this
// slot - what lets a flag wear the spike texture. Omitted means the slot's
// own tile, which is what opening the editor on a tile normally wants.
// Resolves { options, sources, sourceTileName } so the caller can render
// the source tab strip from the same response.
//
// Custom uploads are not filtered by tile: an upload made for one slot is a
// valid pick for any other, same as a curated sprite.
function fetchTextureOptionsFor(tileId, sourceTileName) {
  var optionsUrl = '/api/sprites/tiles/' + encodeURIComponent(tileId) + '/options'
    + (sourceTileName ? '?source=' + encodeURIComponent(sourceTileName) : '');
  return Promise.all([
    fetch(optionsUrl)
      .then(function (res) { return res.json(); }).catch(function () { return { options: [] }; }),
    fetch('/api/custom-sprites')
      .then(function (res) { return res.json(); }).catch(function () { return { sprites: [] }; }),
  ]).then(function (results) {
    var combined = [];
    (results[0].options || []).forEach(function (option) {
      combined.push({ spriteId: option.spriteId, previewUrl: option.previewUrl, label: option.theme });
    });
    (results[1].sprites || []).forEach(function (sprite) {
      combined.push({ spriteId: sprite.spriteId, previewUrl: sprite.previewUrl, label: sprite.label });
    });
    return {
      options: combined,
      sources: results[0].sources || [],
      sourceTileName: results[0].sourceTileName || null,
    };
  });
}

// appEvents is a game-page global; this file is also loaded by
// client/lobby/profile.html, which has no event bus - fall back to the
// console there instead of throwing ReferenceError on the error path.
function reportTextureError(message) {
  if (typeof appEvents !== 'undefined') appEvents.emit('log', '[texture] ' + message);
  else console.error('[texture] ' + message);
}

function uploadCustomTexture(tileId, fileInput, labelInput, uploadBtn, onDone) {
  var file = fileInput.files[0];
  if (!file) return;

  var label = encodeURIComponent(labelInput.value || '');
  var url = '/api/custom-sprites?tileId=' + encodeURIComponent(tileId) + '&label=' + label;

  uploadBtn.disabled = true;
  fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (result) {
      uploadBtn.disabled = false;
      if (!result.ok) { reportTextureError('upload failed: ' + (result.data.error || 'unknown error')); return; }
      fileInput.value = '';
      labelInput.value = '';
      onDone(result.data); // { spriteId, previewUrl } - lets the caller auto-stage the fresh upload
    })
    .catch(function () {
      uploadBtn.disabled = false;
      reportTextureError('upload failed');
    });
}

// spriteId is always "tileName/theme" (server/db.js); a custom upload's id
// matches its on-disk filename minus the extension, so the URL rebuilds
// from spriteId alone.
function spriteFileUrl(spriteId) {
  var theme = spriteId.split('/')[1] || '';
  return (theme.indexOf('custom-') === 0 ? '/sprites-custom/' : '/sprites/') + spriteId + '.png';
}

function downloadTexture(spriteId, label) {
  var a = document.createElement('a');
  a.href = spriteFileUrl(spriteId);
  a.download = label.replace(/\s+/g, '_') + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
