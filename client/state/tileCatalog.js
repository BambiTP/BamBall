// tileCatalog.js - derives "which tile ids are portals/buttons/gates/
// bombs/walls" and "which settings apply to this tile" from server-sent
// data (settingsState.tileCategories, settingsState.settingsSchema)
// instead of hand-typed id lists. The old ui.js hardcoded isButtonTile/
// isPortalTile/isGateTile/isBombTile (raw id literals) and a separate
// tileSettingKeysFor(id) id->key table that had to be kept in step with
// the server's schema by hand, with nothing enforcing agreement - exactly
// the drift risk CLIENT_REWRITE_GUIDE.md flagged. Category NAME sets below
// are still literal, but they're a much smaller and more stable surface
// (a new boost-colored tile variant needs zero changes here, since it's
// just another id mapping to an existing category name server-side).

function categoryOf(id) {
  if (id === 0) return 'floor'; // empty cell - no physicsLookup entry, floor-equivalent for movement
  var categories = settingsState.tileCategories;
  return categories ? categories[id] : undefined;
}

function isWallTile(id) {
  return categoryOf(id) === 'wall';
}

function isPortalTile(id) {
  var category = categoryOf(id);
  return category === 'portal' || category === 'redPortal' || category === 'bluePortal';
}

function isButtonTile(id) {
  return categoryOf(id) === 'button';
}

function isGateTile(id) {
  var category = categoryOf(id);
  return category === 'emptyGate' || category === 'greenGate' || category === 'redGate' || category === 'blueGate';
}

function isBombTile(id) {
  return categoryOf(id) === 'bomb';
}

// Every tileScoped schema key whose tileCategories includes this tile's
// category - the single source of truth is game/settingsSchema.js's
// tileCategories field (shipped via settingsSchema.physics), not a
// second hand-maintained id->key table.
function tileSettingKeysFor(id) {
  var schema = settingsState.settingsSchema;
  if (!schema) return [];
  var category = categoryOf(id);
  if (category === undefined) return [];

  var keys = [];
  for (var i = 0; i < schema.physics.length; i++) {
    var entry = schema.physics[i];
    if (entry.tileScoped && entry.tileCategories && entry.tileCategories.indexOf(category) !== -1) {
      keys.push(entry.key);
    }
  }
  return keys;
}

var tileCatalog = {
  categoryOf: categoryOf,
  isWallTile: isWallTile,
  isPortalTile: isPortalTile,
  isButtonTile: isButtonTile,
  isGateTile: isGateTile,
  isBombTile: isBombTile,
  tileSettingKeysFor: tileSettingKeysFor,
};
