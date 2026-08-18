// state.js - client-side plain-data state: the simulation clock, the game/
// player mirror, server-authoritative room settings, tile-category lookups
// derived from those settings, and per-user local settings (keybinds,
// particles toggle). Five small, tightly-coupled state modules that used to
// be split across state/engineClock.js, state/gameState.js,
// state/settingsState.js, state/tileCatalog.js, state/localSettings.js -
// one file since they're read by nearly everything else in client/ and none
// of the split was hiding real independence between them.
//
// None of these ever import Pixi, Box2D, or the DOM (localSettings' fetch/
// localStorage calls aside), and none call render/simulation functions
// directly - they emit events instead, which app/stateWiring.js wires to
// render/ and simulation/ once at startup.

// ---- engineClock: the single time source ---------------------------------
//
// simulation/loop.js and settingsState (below) read from this instead of
// calling Date.now() directly. On the live page this is pure passthrough
// (Date.now()), so nothing here changes live behavior. The replay page's
// bootstrap overrides .now to return replayEngine.currentMs() instead - a
// virtual clock that freezes while paused, advances at speed*real-time
// during playback, and jumps on seeks. Since loop.js's fixed-step
// accumulator and settingsState's timer extrapolation both derive from this
// one value, pause/speed/seek all fall out correctly with no change to
// either's own control flow.

var engineClock = {
  now: function () { return Date.now(); },
};

// ---- gameState: players/map as plain data ---------------------------------
//
// Plus non-physics entity fields (name, team, dead, hasFlag, powerup
// flags). Never imports Pixi, Box2D, or the DOM, and never calls render/
// simulation functions directly - it emits events on gameEvents instead.
// Position/velocity reconciliation (which does need the physics body) lives
// in simulation/entityReconciler.js, not here.

var gameEvents = createEventBus();

var game = {
  players: [],
  map:     [],
  wallMap: [],
  wells:   [],
  dataMap: [],

  myId:     null, // player id, set only while spawned in the game
  clientId: null, // this connection's client id, set on 'joined'
  leaderId: null, // the room's main leader (the host) client id

  // Every connected client (host + peers), including spectators who never
  // spawned - see engine/packetBuilders.js's roomState. Empty in solo play
  // (nothing ever broadcasts a roomState packet there), so UI reading this
  // must treat an empty list as "unknown," not "empty room."
  roster: [],

  mapId:     null,
  mapSource: null,
  mapName:   null,
  mapAuthor: null,

  // "x,y" -> { timer, toggle: [{ pos: {x,y} }] } / "x,y" -> { destination, cooldown }.
  // The server's canonical wiring structures, sent whole and replaced whole.
  switches: {},
  portals:  {},

  // In-memory save-state slot names, kept in sync by saveStatesChanged
  // packets - see engine/matchManager.js/local/controlPanel.js.
  saveStateNames: [],

  // 'game' or 'editor', from the server on 'joined'. An editor room has no
  // match and lets anyone edit; shared code checks this rather than asking
  // the editor page, which the game page doesn't load.
  roomKind: 'game',

  // Authored spawn discs, { red: [{x,y,radius,weight}], blue: [...] }.
  // Editor-only: the game page never reads these (spawning is server-side),
  // but they ride along on 'joined'/'mapChanged' so the editor can draw and
  // edit them.
  spawnPoints: {},

  // Which players the leader has selected (per-player settings panel) -
  // local only, never sent to the server.
  selectedPlayerIds: [],

  // Spectator camera follow target - local only.
  spectateFollowId:    null,
  spectateCameraReady: false,

  // Room-wide KOTH toggle, kept in sync from settingsState so a stale KOTH
  // dot can't survive the leader turning the mode off.
  kothPowerup: false,

  // Eggball's one projectile (engine/eggballLogic.js's eggballChanged
  // packets, seeded on 'joined'). carrierId set means render it at that
  // player's own position instead of x/y here - see client/render/
  // eggballRenderer.js.
  eggball: { carrierId: null, x: 0, y: 0, vx: 0, vy: 0 },

  // The pregame/game auto-switch profiles (engine/matchManager.js's
  // getProfiles) - full {physics,match,mapId} buckets, seeded on 'joined'
  // and kept in sync by profilesChanged. Used by local/menu.js's map cards
  // (preview) and local/controlPanel.js's forms (editing); only a leader
  // can actually change these, but everyone receives them.
  profiles: {
    pregame: { physics: {}, match: {}, mapId: null },
    game:    { physics: {}, match: {}, mapId: null },
  },
};

function teamFromCode(t) {
  return t === 2 ? 'blue' : 'red';
}

function getPlayer(id) {
  return game.players.find(function (p) { return p.id === id; }) || null;
}

// entity: the (possibly partial) wire-format snapshot fields. Builds the
// plain-data player record and emits 'player:created' so a listener can
// attach a physics body + sprite - see simulation/ and render/ wiring in
// app/bootstrap.js. applyEntityFlags below then emits the granular flag
// events for a fresh entity's initial state (dead/flag/powerups).
function createPlayer(entity) {
  var player = {
    id:   entity.id,
    name: entity.n || ('Player ' + entity.id),
    authed: !!entity.au, // true only once the host has verified their TagPro login token - see webrtcTransport.js's handleOutgoingFor 'identify' case
    team: teamFromCode(entity.t),

    x: entity.x, y: entity.y,
    lx: entity.lx || 0, ly: entity.ly || 0,
    a: entity.a || 0,

    left: false, right: false, up: false, down: false,
    wasUp: false, // edge-detects a fresh up-press for jump, vs. holding it
    jumpsRemaining: physConfig.jumpCharges,

    isPlayer: true, // lets the contact listener (physicsWorld.js) tell a player body from a wall body

    maxSpeed: entity.ms,
    accel:    entity.ac,

    dead:      !!entity.d,
    hasFlag:   !!entity.f,
    flagId:    entity.f || null,
    jukeJuice:   false,
    rollingBomb: false,
    tagpro:      false,
    kothLeader:  false,
    matchFrozen: false,
    snapCount: entity.s || 0,
    sync:      null, // simulation/entityReconciler.js owns this

    body:      null, // filled in by the simulation listener on player:created
    container: null, // filled in by the render listener on player:created
  };

  game.players.push(player);
  gameEvents.emit('player:created', player, entity);
  applyEntityFlags(player, entity);

  return player;
}

function removePlayerLocal(id) {
  var index = game.players.findIndex(function (p) { return p.id === id; });
  if (index === -1) return;

  var player = game.players[index];
  // Emit before splicing: render/playerRenderer.js's clearPupAuras (and any
  // other 'player:removed' listener) looks the player back up by id via
  // getPlayer(), which searches game.players - spliced first, that lookup
  // silently returns null and the listener no-ops instead of cleaning up.
  gameEvents.emit('player:removed', player);
  game.players.splice(index, 1);
}

// Applies every field present on entity EXCEPT position/velocity (that's
// simulation/entityReconciler.js's job, since it needs the physics body).
// Called for both a freshly-created player (createPlayer above) and an
// update to an existing one (applyEntity below).
function applyEntityFlags(player, entity) {
  if (entity.n !== undefined) player.name = entity.n;
  if (entity.au !== undefined) player.authed = !!entity.au;
  if (entity.t !== undefined) player.team = teamFromCode(entity.t);
  if (entity.ac !== undefined) player.accel = entity.ac;
  if (entity.ms !== undefined) player.maxSpeed = entity.ms;

  if (entity.d !== undefined) {
    var wasDead = player.dead;
    player.dead = !!entity.d;
    gameEvents.emit('player:deadChanged', player, wasDead);
  }

  if (entity.f !== undefined) {
    player.hasFlag = !!entity.f;
    player.flagId  = entity.f || null;
    gameEvents.emit('player:flagChanged', player);
  }

  if (entity.jj !== undefined) {
    player.jukeJuice = !!entity.jj;
    gameEvents.emit('player:jukeJuiceChanged', player);
  }

  if (entity.rb !== undefined) {
    var wasRollingBomb = player.rollingBomb;
    player.rollingBomb = !!entity.rb;
    gameEvents.emit('player:rollingBombChanged', player, wasRollingBomb);
  }

  if (entity.tp !== undefined) {
    player.tagpro = !!entity.tp;
    gameEvents.emit('player:tagproChanged', player);
  }

  if (entity.kl !== undefined) {
    player.kothLeader = !!entity.kl;
    gameEvents.emit('player:kothLeaderChanged', player);
  }

  // Per-player freeze (pregame countdown, eggball post-score kickoff) - the
  // server already honors this in physicsHelpers.movePlayers, but until now
  // it was never serialized, so local prediction (simulation/movement.js)
  // kept moving a frozen player from held input keys during the freeze.
  if (entity.mf !== undefined) player.matchFrozen = !!entity.mf;
}

// entity: a snapshot delta for an existing player - see client/net.js
// 'snapshot' wiring in app/, which calls this for the non-physics fields and
// simulation/entityReconciler.js for x/y/a/lx/ly/snapCount.
function applyEntity(entity) {
  var player = getPlayer(entity.id);
  if (!player) {
    createPlayer(entity);
    return player;
  }
  applyEntityFlags(player, entity);
  return player;
}

// ---- settingsState: server-authoritative room/match config ----------------
//
// The settings schema itself (so the UI never hardcodes a setting list),
// room-wide physics values, per-player and per-tile leader overrides, and
// match phase/timer info. Emits events instead of calling simulation/
// render/DOM directly - simulation/physicsWorld.js and ui/hud.js subscribe
// to these in app/bootstrap.js.

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
  tileCategories:        null, // tileId -> physics category name (game/tiles/physicsData.js) - see tileCatalog below

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

// Session-only wheel zoom while playing (client/inputs.js), used
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

// ---- tileCatalog: tile-id -> category/settings lookups --------------------
//
// Derives "which tile ids are portals/buttons/gates/bombs/walls" and "which
// settings apply to this tile" from server-sent data (settingsState.
// tileCategories, settingsState.settingsSchema) instead of hand-typed id
// lists. The old ui.js hardcoded isButtonTile/isPortalTile/isGateTile/
// isBombTile (raw id literals) and a separate tileSettingKeysFor(id) id->key
// table that had to be kept in step with the server's schema by hand, with
// nothing enforcing agreement. Category NAME sets below are still literal,
// but they're a much smaller and more stable surface (a new boost-colored
// tile variant needs zero changes here, since it's just another id mapping
// to an existing category name server-side).

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

// ---- localSettings: per-user client settings -------------------------------
//
// Keybinds and the particles toggle. These follow the
// person, not the room - never sent into the game simulation. Two-layer
// persistence: localStorage always, account sync (debounced) when logged
// in, with the account copy winning on page load (see CLIENT_REWRITE_
// GUIDE.md §1.12 - no timestamps, no per-key merge, deliberately dumb).
//
// Zoom is NOT here: it's gameplay visibility, owned by the leader-set
// cameraZoom in settingsState above. See CLIENT_REWRITE_GUIDE.md §1.5.

var localSettingsEvents = createEventBus();

var LOCAL_SETTINGS_DEFAULTS = {
  keys: {
    up:       ['w', 'ArrowUp'],
    down:     ['s', 'ArrowDown'],
    left:     ['a', 'ArrowLeft'],
    right:    ['d', 'ArrowRight'],
    detonate: [' '],
    chat:     ['Enter'],
    menu:     ['Escape'],
    zoomIn:   ['=', '+'],
    zoomOut:  ['-'],
    pause:    [], // unbound by default - opt-in, leader-only in practice (server rejects it for anyone else)
  },
  particles:    true,
};

var LOCAL_SETTINGS_STORAGE_KEY = 'grabtag_settings';

// Validated merge over the defaults: unknown keys dropped, missing/wrong-
// typed keys fall back - an old or corrupt saved blob never breaks a newer
// client.
function mergeLocalSettings(stored) {
  var merged = {
    keys: {},
    particles: LOCAL_SETTINGS_DEFAULTS.particles,
  };

  var action;
  for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
    merged.keys[action] = LOCAL_SETTINGS_DEFAULTS.keys[action].slice();
  }

  if (!stored || typeof stored !== 'object') return merged;

  if (stored.keys && typeof stored.keys === 'object') {
    for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
      var bindings = stored.keys[action];
      if (!Array.isArray(bindings)) continue;
      var clean = [];
      for (var i = 0; i < bindings.length && clean.length < 2; i++) {
        if (typeof bindings[i] === 'string' && bindings[i].length) clean.push(bindings[i]);
      }
      if (clean.length) merged.keys[action] = clean;
    }
  }

  if (typeof stored.particles === 'boolean') merged.particles = stored.particles;

  return merged;
}

function loadLocalSettings() {
  var stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(LOCAL_SETTINGS_STORAGE_KEY));
  } catch (err) {
    // Corrupt blob - fall back to defaults; the next save overwrites it.
  }
  return mergeLocalSettings(stored);
}

var localSettings = loadLocalSettings();
var settingsSyncTimer = null;

function saveLocalSettings() {
  try {
    localStorage.setItem(LOCAL_SETTINGS_STORAGE_KEY, JSON.stringify(localSettings));
  } catch (err) {
    // Storage full/blocked (private mode) - settings still apply this session.
  }
  localSettingsEvents.emit('localSettings:changed');

  clearTimeout(settingsSyncTimer);
  settingsSyncTimer = setTimeout(function () {
    fetch('/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(localSettings),
    }).catch(function () {});
  }, 400);
}

// Account copy wins on page load. Runs async; until it lands, the
// localStorage copy applies.
function syncLocalSettingsFromAccount() {
  fetch('/api/settings').then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (stored) {
    if (!stored || !Object.keys(stored).length) return;
    localSettings = mergeLocalSettings(stored);
    try {
      localStorage.setItem(LOCAL_SETTINGS_STORAGE_KEY, JSON.stringify(localSettings));
    } catch (err) {}
    localSettingsEvents.emit('localSettings:changed');
  }).catch(function () {});
}

function setKeybind(action, slot, key) {
  if (!LOCAL_SETTINGS_DEFAULTS.keys[action]) return;

  // A key means one global thing - remove it from every other action first.
  for (var otherAction in localSettings.keys) {
    var bindings = localSettings.keys[otherAction];
    var index = bindings.indexOf(key);
    if (index !== -1) bindings.splice(index, 1);
  }

  var slots = localSettings.keys[action];
  slots[slot] = key;
  saveLocalSettings();
}

function resetKeybinds() {
  var action;
  for (action in LOCAL_SETTINGS_DEFAULTS.keys) {
    localSettings.keys[action] = LOCAL_SETTINGS_DEFAULTS.keys[action].slice();
  }
  saveLocalSettings();
}

function setParticlesEnabled(enabled) {
  localSettings.particles = !!enabled;
  saveLocalSettings();
}
