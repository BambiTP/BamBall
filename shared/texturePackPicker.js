// texturePackPicker.js - the whole Textures view, in two levels.
//
//   PACK      your current pack as a grid of its actual tiles, grouped into
//             rows by what each tile is (server/assets/tileDisplayOrder.js).
//             Click any tile to change that one.
//   GALLERY   every OTHER pack, to swap the lot at once.
//
// There is no separate "edit" mode, because the grid IS the editor: the
// thing you want to change is on screen, so clicking it is the whole
// interaction. An Edit button would only have led to a second copy of this
// same grid.
//
// Tiles are drawn at their natural size and never scaled down. Sprites are
// not uniformly 40x40 - marsBall is 80x80 and the wall sheet is 480x440 -
// and squeezing them into equal boxes is what made big ones look mangled.
// A cell is sized to its sprite, and `image-rendering: pixelated` keeps
// edges crisp instead of letting the browser blur them.
//
// mountTexturePackPicker(container, opts) builds the widget once inside an
// empty container. opts.loggedIn gates saving (browsing still works for
// anonymous visitors - they see the default pack). opts.onSelect fires
// after anything persists, so the host page can refresh its live render.
// The returned handle:
//   - refresh(): re-render from the server
//   - hasStagedChanges() / confirmDiscardStaged(): kept for host pages that
//     gate navigation on unsaved work. Picks now save immediately, so there
//     is never anything staged and these are always "nothing pending".

function mountTexturePackPicker(container, opts) {
  opts = opts || {};
  var loggedIn = !!opts.loggedIn;

  container.textContent = '';
  container.classList.add('texturePackPicker');

  var view = 'pack';       // 'pack' | 'gallery'
  var groupsCache = null;  // static tileGroups.json's groups, in display order, with local picks layered on
  var themesCache = null;
  var gallerySearch = '';
  var selectedTheme = null;

  // Layers this browser's saved picks (localTexturePrefs) on top of the
  // static default assignment baked into tileGroups.json at build time -
  // the static file is the same for everyone, the picks are per-browser.
  function applyLocalPicks(groups) {
    var picks = localTexturePrefs.getPicks();
    groups.forEach(function (g) {
      g.tiles.forEach(function (tile) {
        var picked = picks[tile.tileId];
        if (!picked) return;
        tile.currentSpriteId = picked;
        tile.currentTheme    = picked.split('/')[1] || null;
        tile.previewUrl      = spriteFileUrl(picked);
      });
    });
    return groups;
  }

  var root = document.createElement('div');
  container.appendChild(root);

  function goTo(next) {
    view = next;
    render();
  }

  // ---- PACK ---------------------------------------------------------------

  // The theme every tile is currently on, or null if they're mixed. Used to
  // leave your current pack out of the gallery - it's the one you're
  // already looking at.
  function currentTheme() {
    if (!groupsCache) return null;
    var theme = null;
    var tiles = groupsCache.reduce(function (all, g) { return all.concat(g.tiles); }, []);
    for (var i = 0; i < tiles.length; i++) {
      if (!tiles[i].currentTheme) return null;
      if (theme === null) theme = tiles[i].currentTheme;
      else if (theme !== tiles[i].currentTheme) return null;
    }
    return theme;
  }

  // A bare sprite, nothing around it. No label, no box, no padding: the
  // sprite IS the control, and 49 captioned cards was chrome burying the
  // thing you actually came to look at. The image is never sized in CSS, so
  // it renders at its true pixel size - 40x40, or 80x80 for marsBall.
  function buildTileCell(tile) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'tppTile';
    cell.title = tileDisplayLabel(tile);
    cell.disabled = !loggedIn;

    if (tile.previewUrl) {
      var img = document.createElement('img');
      img.src = tile.previewUrl;
      img.alt = tileDisplayLabel(tile);
      img.loading = 'lazy';
      cell.appendChild(img);
    } else {
      cell.classList.add('tppTileEmpty');
    }

    cell.addEventListener('click', function () { openTileModal(tile); });
    return cell;
  }

  // A pick saves immediately. There's no Apply All to batch into any more,
  // and one tile is one small request.
  function openTileModal(tile) {
    if (!loggedIn) return;
    openTextureModal({
      tileId: tile.tileId,
      title: tileDisplayLabel(tile),
      currentSpriteId: tile.currentSpriteId,
      sourceTabs: true,
      uploadable: true,
      onPick: function (option) {
        localTexturePrefs.setPick(tile.tileId, option.spriteId);
        groupsCache = null;
        render();
        if (typeof opts.onSelect === 'function') opts.onSelect(tile.tileId, option.spriteId);
      },
    });
  }

  function buildPackView() {
    var wrap = document.createElement('div');
    wrap.className = 'tppPackView';

    var bar = document.createElement('div');
    bar.className = 'tppPackActions';
    var viewAllBtn = document.createElement('button');
    viewAllBtn.type = 'button';
    viewAllBtn.className = 'tppPackBtn primary';
    viewAllBtn.textContent = 'View All';
    viewAllBtn.title = 'Browse every other texture pack and swap to one';
    viewAllBtn.addEventListener('click', function () { goTo('gallery'); });
    bar.appendChild(viewAllBtn);

    if (!loggedIn) {
      var note = document.createElement('span');
      note.className = 'tppNotice';
      note.textContent = 'Log in to change your textures.';
      bar.appendChild(note);
    }
    wrap.appendChild(bar);

    var body = document.createElement('div');
    body.className = 'tppPackBody';
    wrap.appendChild(body);

    function renderTiles() {
      body.textContent = '';
      if (!groupsCache) {
        body.textContent = 'Loading tiles...';
        return;
      }

      var all = groupsCache.reduce(function (acc, g) { return acc.concat(g.tiles); }, []);

      // The wall sheet is 480x440 - a whole auto-tile grid, not a tile. It
      // gets its own column on the left at full size, exactly as it appears
      // on the contact sheet, and the 40x40 tiles pack beside it.
      var walls = all.filter(function (t) { return t.tileId === 'walls'; });
      var tiles = all.filter(function (t) { return t.tileId !== 'walls'; });

      walls.forEach(function (tile) {
        var col = document.createElement('div');
        col.className = 'tppWallsColumn';
        col.appendChild(buildTileCell(tile));
        body.appendChild(col);
      });

      var grid = document.createElement('div');
      grid.className = 'tppTiles';
      tiles.forEach(function (tile) { grid.appendChild(buildTileCell(tile)); });
      body.appendChild(grid);
    }

    renderTiles();

    if (!groupsCache) {
      fetch(GAME_BASE_PATH + 'assets/tileGroups.json').then(function (res) { return res.json(); }).then(function (data) {
        groupsCache = applyLocalPicks(data.groups || []);
        renderTiles();
      }).catch(function () {
        body.textContent = 'Failed to load tiles.';
      });
    }

    return wrap;
  }

  // ---- GALLERY ------------------------------------------------------------

  // selectedTileIds: from openChangeAllConfirm - only these tiles change,
  // default nothing (opt-in, not opt-out - see that function).
  function applyTheme(theme) {
    if (!loggedIn) return;
    openChangeAllConfirm(theme, function (selectedTileIds) {
      var picks = {};
      selectedTileIds.forEach(function (tileId) { picks[tileId] = null; }); // filled in below once coverage is known
      fetch(GAME_BASE_PATH + 'assets/themeCoverage.json').then(function (res) { return res.json(); }).then(function (coverage) {
        var tiles = coverage[theme] || [];
        var byId = {};
        tiles.forEach(function (t) { byId[t.tileId] = t; });
        selectedTileIds.forEach(function (tileId) {
          var t = byId[tileId];
          if (t && t.covered) picks[tileId] = t.tileName + '/' + theme;
        });
        localTexturePrefs.setManyPicks(picks);
        groupsCache = null;
        selectedTheme = null;
        view = 'pack';
        render();
        if (typeof opts.onSelect === 'function') opts.onSelect(null, null);
      });
    });
  }

  function buildGalleryView() {
    var wrap = document.createElement('div');
    wrap.className = 'tppGalleryView';

    wrap.appendChild(buildBackRow('Every other pack', function () { goTo('pack'); }));

    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'tppSearch';
    search.placeholder = 'Search packs…';
    search.value = gallerySearch;
    search.addEventListener('input', function (event) {
      gallerySearch = event.target.value;
      renderGrid();
    });
    wrap.appendChild(search);

    var body = document.createElement('div');
    body.className = 'tppGalleryBody';
    var grid = document.createElement('div');
    grid.className = 'tppGalleryGrid';
    body.appendChild(grid);
    var preview = document.createElement('div');
    preview.className = 'tppGalleryPreview';
    body.appendChild(preview);
    wrap.appendChild(body);

    // No contact-sheet compositor in this static build (server/assets/
    // contactSheetBuilder.js is Node/Jimp-only) - the full pack preview is
    // built the same way the main Pack tab renders tiles, just from
    // themeCoverage.json (every tile this theme actually covers) instead
    // of the current picks. Fetched once, cached like themesCache.
    var themeCoverageCache = null;

    function renderPreview() {
      preview.textContent = '';
      if (!selectedTheme) {
        var hint = document.createElement('p');
        hint.className = 'tppNotice';
        hint.textContent = 'Pick a pack to see it in full.';
        preview.appendChild(hint);
        return;
      }

      var name = document.createElement('div');
      name.className = 'tppGalleryPreviewName';
      name.textContent = selectedTheme;
      preview.appendChild(name);

      var useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'tppPackBtn primary';
      useBtn.textContent = 'Use this pack';
      useBtn.disabled = !loggedIn;
      useBtn.addEventListener('click', function () { applyTheme(selectedTheme); });
      preview.appendChild(useBtn);

      var grid = document.createElement('div');
      grid.className = 'tppTiles';
      preview.appendChild(grid);

      function renderFullPack() {
        grid.textContent = '';
        var tiles = (themeCoverageCache && themeCoverageCache[selectedTheme] || []).filter(function (t) { return t.covered; });
        if (!tiles.length) { grid.textContent = 'No preview available for this pack.'; return; }
        tiles.forEach(function (tile) {
          var cell = document.createElement('div');
          cell.className = 'tppTile';
          var img = document.createElement('img');
          img.src = tile.previewUrl;
          img.alt = tile.label || tile.tileName;
          img.loading = 'lazy';
          cell.appendChild(img);
          grid.appendChild(cell);
        });
      }

      if (themeCoverageCache) {
        renderFullPack();
      } else {
        grid.textContent = 'Loading pack…';
        fetch(GAME_BASE_PATH + 'assets/themeCoverage.json').then(function (res) { return res.json(); }).then(function (data) {
          themeCoverageCache = data;
          renderFullPack();
        }).catch(function () { grid.textContent = 'Failed to load pack preview.'; });
      }
    }

    function renderGrid() {
      grid.textContent = '';
      if (!themesCache) {
        grid.textContent = 'Loading packs...';
        return;
      }

      var mine = currentTheme();
      var term = gallerySearch.trim().toLowerCase();
      var shown = themesCache.filter(function (theme) {
        if (theme === mine) return false; // the one you're already on
        return !term || theme.toLowerCase().indexOf(term) !== -1;
      });

      if (!shown.length) {
        grid.textContent = term ? 'No packs match "' + gallerySearch + '".' : 'No other packs.';
        return;
      }

      shown.forEach(function (theme) {
        var cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'tppGalleryCell' + (theme === selectedTheme ? ' selected' : '');
        var img = document.createElement('img');
        img.alt = theme;
        img.loading = 'lazy';
        img.src = GAME_BASE_PATH + 'assets/themePreviews/' + theme + '.png';
        cell.appendChild(img);
        var label = document.createElement('span');
        label.textContent = theme;
        cell.appendChild(label);
        cell.addEventListener('click', function () {
          selectedTheme = theme;
          renderGrid();
          renderPreview();
        });
        grid.appendChild(cell);
      });
    }

    renderGrid();
    renderPreview();

    if (!themesCache) {
      fetch(GAME_BASE_PATH + 'assets/themes.json').then(function (res) { return res.json(); }).then(function (data) {
        themesCache = data.themes || [];
        renderGrid();
      }).catch(function () {
        grid.textContent = 'Failed to load packs.';
      });
    }

    return wrap;
  }

  // ---- shell --------------------------------------------------------------

  function buildBackRow(titleText, onBack) {
    var row = document.createElement('div');
    row.className = 'tppBackRow';
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'tppBackBtn';
    back.textContent = '‹ Back';
    back.addEventListener('click', onBack);
    row.appendChild(back);
    var title = document.createElement('span');
    title.className = 'tppBackTitle';
    title.textContent = titleText;
    row.appendChild(title);
    return row;
  }

  function render() {
    root.textContent = '';
    root.appendChild(view === 'gallery' ? buildGalleryView() : buildPackView());
  }

  render();

  return {
    refresh: function () {
      groupsCache = null;
      render();
    },
    // Picks save on click, so nothing is ever pending.
    hasStagedChanges: function () { return false; },
    confirmDiscardStaged: function () { return true; },
  };
}
