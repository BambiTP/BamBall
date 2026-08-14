// localTexturePrefs.js - static-build replacement for the DB-backed half of
// server/api/sprites.js: per-tile picks persist to localStorage (small,
// string-only, exactly what a sparse tileId->spriteId map needs) instead of
// a per-account row; custom-uploaded sprite images persist to IndexedDB
// (binary blobs, localStorage's ~5MB string-only quota is the wrong fit).

var localTexturePrefs = (function () {
  var PICKS_KEY = 'bamball.texturePicks'; // { tileId: spriteId }

  function getPicks() {
    try { return JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function getPick(tileId) {
    return getPicks()[String(tileId)] || null;
  }

  function setPick(tileId, spriteId) {
    var picks = getPicks();
    picks[String(tileId)] = spriteId;
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  }

  function setManyPicks(map) {
    var picks = getPicks();
    for (var tileId in map) picks[tileId] = map[tileId];
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  }

  // ---- custom uploads (IndexedDB) ----------------------------------------

  var DB_NAME = 'bamball-textures';
  var STORE = 'uploads'; // key: spriteId ("custom-<uuid>"), value: { spriteId, tileName, label, blob }
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'spriteId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // blob: an already-decoded image Blob. spriteId keeps the same
  // "tileName/theme" shape curated sprites use (theme = "custom-<uuid>"),
  // so applyLocalPicks/spriteFileUrl need no special-casing for the prefix.
  // Returns { spriteId, previewUrl, label }.
  function saveUpload(blob, label, tileName) {
    var spriteId = (tileName || 'custom') + '/custom-' + uuid();
    var record = { spriteId: spriteId, tileName: tileName || null, label: label || 'upload', blob: blob };
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { resolve(record); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).then(function (record) {
      return { spriteId: record.spriteId, previewUrl: URL.createObjectURL(record.blob), label: record.label };
    });
  }

  function listUploads() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          resolve(req.result.map(function (r) {
            return { spriteId: r.spriteId, previewUrl: URL.createObjectURL(r.blob), label: r.label };
          }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getUploadUrl(spriteId) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(spriteId);
        req.onsuccess = function () { resolve(req.result ? URL.createObjectURL(req.result.blob) : null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  return {
    getPicks: getPicks, getPick: getPick, setPick: setPick, setManyPicks: setManyPicks,
    saveUpload: saveUpload, listUploads: listUploads, getUploadUrl: getUploadUrl,
  };
})();
