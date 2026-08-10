// settingsState.js - server-authoritative room/match config: the settings
// schema itself (so the UI never hardcodes a setting list), room-wide
// physics values, per-player and per-tile leader overrides, and match
// phase/timer info. Emits events instead of calling simulation/render/DOM
// directly - simulation/physicsWorld.js and ui/hud.js subscribe to these in
// app/bootstrap.js.

var settingsEvents = createEventBus();

var settingsState = {
  // Sent once on 'joined' - lets the Overview tab show what's changed from
  // a fresh server's defaults.
  matchSettingsDefaults: null,
  physicsDefaults:       null,
  physicsCategories:     null, // display grouping for the Group Settings panel
  settingsSchema:        null, // { physics: [...], match: [...] }
  playerKeys:            null, // which physics keys a leader can override per-player
  tileKeys:               null, // which physics keys a leader can override per-tile
  tileCategories:        null, // tileId -> physics category name (game/tiles/physicsData.js) - see state/tileCatalog.js

  // Room-wide physics config, kept in sync by physicsChanged packets.
  physics: {},

  // playerId -> { key: value }. Sparse; room-wide `physics` is the fallback
  // for anything not present for a given player/key. Full-replace semantics
  // (the server always sends a player's entire current override set).
  playerOverrides: {},

  // "x,y" -> { key: value }. Sparse; display-only client-side (the server
  // applies the actual behavior). Full-replace per cell.
  tileOverrides: {},

  matchInfo: {
    state:          null,
    settings:       null,
    scores:         null,
    baseElapsedMs:  0,
    receivedAt:     0,
    pausedFrom:     null,
  },
};

function setSettingsSchema(packet) {
  settingsState.matchSettingsDefaults = packet.matchSettingsDefaults || null;
  settingsState.physicsDefaults       = packet.physicsDefaults || null;
  settingsState.physicsCategories     = packet.physicsCategories || null;
  settingsState.settingsSchema        = packet.settingsSchema || null;
  settingsState.playerKeys            = packet.playerKeys || null;
  settingsState.tileKeys              = packet.tileKeys || null;
  settingsState.tileCategories        = packet.tileCategories || null;
  settingsEvents.emit('schema:loaded');
}

// settings: sparse, room-wide - merges onto the tracked physics config and
// emits one event with just the changed keys, so simulation/physicsWorld.js
// can push only what actually changed onto existing bodies.
function setPhysicsSettings(settings) {
  if (!settings) return;
  Object.assign(settingsState.physics, settings);
  settingsEvents.emit('physics:changed', settings);
}

// Full-replace, per playerId - an empty/absent settings object means "no
// overrides for this player", not "don't change anything".
function setPlayerOverrides(playerId, settings) {
  if (settings && Object.keys(settings).length) {
    settingsState.playerOverrides[playerId] = settings;
  } else {
    delete settingsState.playerOverrides[playerId];
  }
  settingsEvents.emit('playerOverrides:changed', playerId);
}

function setTileOverrides(x, y, settings) {
  var key = x + ',' + y;
  if (settings && Object.keys(settings).length) {
    settingsState.tileOverrides[key] = settings;
  } else {
    delete settingsState.tileOverrides[key];
  }
  settingsEvents.emit('tileOverrides:changed', x, y);
}

function getTileOverride(x, y, key) {
  var overrides = settingsState.tileOverrides[x + ',' + y];
  return overrides && overrides[key] !== undefined ? overrides[key] : undefined;
}

// The effective value for a physics-scoped key on a given player: their
// override if the leader set one, else the room-wide default. Mirrors
// game/settingsResolver.js's playerSetting() resolution order exactly.
function playerSetting(playerId, key) {
  var overrides = settingsState.playerOverrides[playerId];
  if (overrides && overrides[key] !== undefined) return overrides[key];
  return settingsState.physics[key];
}

// Session-only wheel zoom while playing (input/cameraControls.js), used
// only when the room's allowWheelZoom is on. null = no wheel input yet, use
// the limit. Deliberately NOT a personal/persisted setting - zoom is
// gameplay visibility, so the leader-set cameraZoom owns it (see
// CLIENT_REWRITE_GUIDE.md §1.5 - do not resurrect a personal zoom slider).
var playerWheelZoom = null;

// Range the wheel can reach, either side of the room's setting. The floor
// matches the free camera's (render/camera.js zoomCamera) - past it the map
// is too small to play off, whichever camera you're on.
var MIN_WHEEL_ZOOM = 0.3;
var MAX_WHEEL_ZOOM = 3;

// The room's zoom for this player - the setting the wheel starts from.
function cameraZoomSetting() {
  var zoom = game.myId !== null ? playerSetting(game.myId, 'cameraZoom') : undefined;
  return zoom === undefined ? 1 : zoom;
}

function setPlayerWheelZoom(zoom) {
  // Clamped symmetrically, to the range that can actually take effect.
  // Previously only the way in was clamped (at 3, by the callers) and the
  // way out was left to allowedCameraZoom's cap, so the stored value drifted
  // past what the view could show: clicks past the cap moved the number
  // without moving the view, and that many clicks back did nothing either
  // before it started responding again. That one-sided drift is what made
  // zoom feel like it worked in one direction only.
  playerWheelZoom = Math.min(MAX_WHEEL_ZOOM, Math.max(MIN_WHEEL_ZOOM, zoom));
}

// The zoom the local player actually gets while playing: the room's
// cameraZoom setting (per-player override, else room-wide), or wherever
// this player has wheeled to if the room allows wheel zoom at all.
//
// cameraZoom is deliberately NOT a cap on that wheel input. It used to be
// one - clamping the wheel to one side of the setting, which is what made
// zooming past it do nothing - but a room's settings apply to the leader on
// the same terms as everyone else, so there's no one whose view this would
// be privileging. allowWheelZoom is the switch for whether players may
// deviate at all; the setting itself is just where they start from.
function allowedCameraZoom() {
  if (settingsState.physics.allowWheelZoom && playerWheelZoom !== null) {
    return playerWheelZoom;
  }
  return cameraZoomSetting();
}

Object.assign(settingsState, {
  setSettingsSchema:   setSettingsSchema,
  setPhysicsSettings:  setPhysicsSettings,
  setPlayerOverrides:  setPlayerOverrides,
  setTileOverrides:    setTileOverrides,
  getTileOverride:     getTileOverride,
  playerSetting:       playerSetting,
  setMatchInfo:        setMatchInfo,
  phaseElapsedMs:      phaseElapsedMs,
  movementFrozen:      movementFrozen,
  setPlayerWheelZoom:  setPlayerWheelZoom,
  allowedCameraZoom:   allowedCameraZoom,
});

function setMatchInfo(packet) {
  settingsState.matchInfo = {
    state:          packet.state,
    settings:       packet.settings,
    scores:         packet.scores,
    baseElapsedMs:  (packet.stepCount - (packet.phaseStartStep || 0)) * (1000 / 60),
    receivedAt:     engineClock.now(),
    pausedFrom:     packet.pausedFrom || null,
  };
  settingsEvents.emit('matchInfo:changed');
}

// Extrapolates the current phase's elapsed time between matchState packets -
// pure function, no DOM. ui/hud.js polls this on an interval to render the
// live clock; this used to be computed inline inside ui.js's timer render
// function, which meant "how much time has passed" (simulation-ish logic)
// lived in the DOM file.
function phaseElapsedMs() {
  var info = settingsState.matchInfo;
  if (info.state === 'paused') return info.baseElapsedMs;
  return info.baseElapsedMs + (engineClock.now() - info.receivedAt);
}

// Movement prediction (loop.js) and menu/HUD code both need this - a single
// definition instead of duplicated state-name checks in multiple files.
function movementFrozen() {
  var state = settingsState.matchInfo.state;
  return state === 'countdown' || state === 'paused' || state === 'ended';
}
