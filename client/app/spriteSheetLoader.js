// spriteSheetLoader.js - static-build replacement for the original's
// POST /api/spritesheet call (server/api/spritesheet.js, no server here).
// Points at the one default packed sheet baked ahead of time
// (assets/sprites/default.png + default.json, via the unmodified
// server/assets/buildSpriteSheet.js, run as a one-off script) instead of
// building one per-account on demand. Custom/local texture packs (see the
// plan's texture-pack-picker section) swap this out per pick; until that
// lands every player sees the same default pack.

var spriteSheetLoader = {
  loadedHash: 'default',

  fetch: function () {
    return Promise.resolve({
      hash: 'default',
      sheetUrl: './assets/sprites/default.png',
      manifestUrl: './assets/sprites/default.json',
      wallsUrl: './assets/sprites/walls/classic.png',
    });
  },

  refetch: function () {
    // No per-account state to change yet in this build - see task #8
    // (texture pack picker network-call adaptation) for local/IndexedDB
    // pack switching, which will make this a real refresh again.
    return Promise.resolve(null);
  },
};
