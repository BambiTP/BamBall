(function () {
// settingsSchema.js - single source of truth for every leader-adjustable
// setting: room-wide physics/gameplay numbers, per-player overrides, and
// match-level rules. Adding a new setting means adding one entry here;
// validation (coerce/applyPartial below), the client's rendering, and
// matchManager's derived key lists (getPhysics/getPlayerKeys/etc.) all read
// off this one array instead of duplicating it.
//
// Entry shape:
//   key         - the config/matchSettings property name
//   scope       - 'physics' (room-wide, lives in gameConfig.js) | 'match' (lives in matchSettings.js)
//   type        - 'number' | 'bool' | 'enum'
//   zeroOk      - number only; if true, 0 is a valid value (default: must be strictly positive)
//   signedOk    - number only; if true, skips the non-negative check entirely (negative values meaningful)
//   intOnly     - number only; if true, value must be an integer
//   max         - number only; if set, value must be <= this (no default upper bound otherwise)
//   nullable    - if true, `null` is a valid value (match settings' unlimited fields;
//                 for scope:'physics' + playerScoped entries, null instead means
//                 "clear this player's override", handled by matchManager, not coerce())
//   options     - enum only, the fixed list of valid string values
//   category    - display grouping bucket, both settings tabs
//   playerScoped- physics only; true => also settable per-player via updatePlayerPhysics
//   tileScoped  - physics only; true => also settable per-tile via updateTileSettings
//                 (hitbox geometry is never per-tile, owner rule)
//   tileCategories - tileScoped only; the game/tiles/physicsData.js category
//                 names this key is meaningful for. matchManager.updateTileSettings
//                 rejects writing a tileScoped key onto a cell whose current
//                 category isn't listed - without this, a leader could leave
//                 e.g. boostCooldown sitting inertly on a Wall cell forever
//                 (only cleared by a category-changing repaint, which a Wall
//                 that's never repainted again would never get). This is
//                 also the client's single source of truth for which tile
//                 ids should show which setting rows, shipped in
//                 settingsSchema.physics - the client must not hardcode its
//                 own id-to-key table.
//   hooks       - tags into matchManager's side-effect registries; omit/empty = no side effect
//   scale       - optional, client display conversion: display = raw / scale,
//                 raw = display * scale (e.g. 1000 to show stored ms as
//                 seconds; 1/60 to show a stored per-tick 60Hz velocity
//                 delta as its true per-second rate)
//   unit        - optional display unit label. Every length is 'tiles',
//                 every velocity 'tiles/s', every acceleration 'tiles/s²' -
//                 the client never sees TPU, pixels, or raw per-tick units.
var POWERUP_TYPES = (typeof require === 'function') ? require('./tiles/powerupTypes') : globalThis.PowerupTypes;

const PHYSICS_SCHEMA = [
  // Movement
  // accel is stored as the raw per-tick (60Hz) velocity increment, same unit
  // Box2D's own gravity/damping never bother displaying - scale:1/60 turns
  // that into the true tiles/s^2 a leader actually reasons about.
  { key: 'accel',          scope: 'physics', type: 'number', category: 'Movement', playerScoped: true, hooks: ['playerBaseStats'], scale: 1/60, unit: 'tiles/s²' },
  { key: 'maxSpeed',       scope: 'physics', type: 'number', category: 'Movement', playerScoped: true, hooks: ['playerBaseStats'], unit: 'tiles/s' },
  { key: 'linearDamping',  scope: 'physics', type: 'number', zeroOk: true, category: 'Movement', playerScoped: true, hooks: ['playerBody'] },
  { key: 'angularDamping', scope: 'physics', type: 'number', zeroOk: true, category: 'Movement', playerScoped: true, hooks: ['playerBody'] },
  // floorFriction reads per-cell at the moment of use (the player's
  // current tile in movePlayers, both sides), so tileScoped needs no hook;
  // wall surface values are baked into fixtures, so their tileScoped
  // writes go through matchManager.syncWallSurface + the wallSurface hook.
  // max: 1 - shared/movement.js computes `friction = 1 - floorFriction`,
  // which goes negative (damping flips into oscillating repulsion) past 1,
  // with nothing else to catch it.
  { key: 'floorFriction',  scope: 'physics', type: 'number', zeroOk: true, max: 1, category: 'Movement', tileScoped: true, tileCategories: ['floor'] },
  { key: 'wallRestitution', scope: 'physics', type: 'number', zeroOk: true, category: 'Movement', hooks: ['wallSurface'], tileScoped: true, tileCategories: ['wall'] },
  { key: 'wallFriction',    scope: 'physics', type: 'number', zeroOk: true, category: 'Movement', hooks: ['wallSurface'], tileScoped: true, tileCategories: ['wall'] },
  { key: 'playerFriction',  scope: 'physics', type: 'number', zeroOk: true, category: 'Movement', playerScoped: true, hooks: ['playerBody'] },

  // Boosts
  { key: 'boostMultiplier',    scope: 'physics', type: 'number', category: 'Boosts', tileScoped: true, tileCategories: ['boost', 'redBoost', 'blueBoost'] },
  { key: 'boostCooldown',      scope: 'physics', type: 'number', category: 'Boosts', tileScoped: true, tileCategories: ['boost'], scale: 1000, unit: 's' },
  { key: 'redBoostCooldown',   scope: 'physics', type: 'number', category: 'Boosts', tileScoped: true, tileCategories: ['redBoost'], scale: 1000, unit: 's' },
  { key: 'blueBoostCooldown',  scope: 'physics', type: 'number', category: 'Boosts', tileScoped: true, tileCategories: ['blueBoost'], scale: 1000, unit: 's' },

  // Bombs & Hazards
  // bombRadius/bombStrength are the explosion's force field, not the
  // tile's contact sensor - per-tile is fine under the "no hitbox
  // geometry" rule, same as gravityWellRadius below.
  { key: 'bombRadius',           scope: 'physics', type: 'number', category: 'Bombs & Hazards', tileScoped: true, tileCategories: ['bomb'], unit: 'tiles' },
  { key: 'bombStrength',         scope: 'physics', type: 'number', category: 'Bombs & Hazards', tileScoped: true, tileCategories: ['bomb'] },
  { key: 'bombCooldown',         scope: 'physics', type: 'number', category: 'Bombs & Hazards', tileScoped: true, tileCategories: ['bomb'], scale: 1000, unit: 's' },
  { key: 'rollingBombRadius',    scope: 'physics', type: 'number', category: 'Bombs & Hazards', unit: 'tiles' },
  { key: 'rollingBombStrength',  scope: 'physics', type: 'number', category: 'Bombs & Hazards' },
  { key: 'portalExploRadius',    scope: 'physics', type: 'number', category: 'Bombs & Hazards', unit: 'tiles' },
  { key: 'portalExploStrength',  scope: 'physics', type: 'number', category: 'Bombs & Hazards' },
  { key: 'deathExploRadius',     scope: 'physics', type: 'number', category: 'Bombs & Hazards', unit: 'tiles' },
  { key: 'deathExploStrength',   scope: 'physics', type: 'number', category: 'Bombs & Hazards' },

  // Flags
  // Both read per-cell at grab time (flagLogic.pickupFlag), same pattern as
  // floorFriction - the resolved values get baked onto the player
  // (flagGrabInvulnUntil) right there, so no hook is needed.
  { key: 'flagGrabInvulnEnabled', scope: 'physics', type: 'bool', category: 'Flags', tileScoped: true, tileCategories: ['redFlag', 'blueFlag', 'yellowFlag'] },
  { key: 'flagGrabInvulnMs',      scope: 'physics', type: 'number', zeroOk: true, category: 'Flags', tileScoped: true, tileCategories: ['redFlag', 'blueFlag', 'yellowFlag'], scale: 1000, unit: 's' },

  // Team Tiles
  { key: 'teamTileAccel',    scope: 'physics', type: 'number', category: 'Team Tiles', tileScoped: true, tileCategories: ['redTeamTile', 'blueTeamTile', 'yellowTeamTile'], scale: 1/60, unit: 'tiles/s²' },
  { key: 'teamTileMaxSpeed', scope: 'physics', type: 'number', category: 'Team Tiles', tileScoped: true, tileCategories: ['redTeamTile', 'blueTeamTile', 'yellowTeamTile'], unit: 'tiles/s' },

  // Powerups
  { key: 'powerupRespawn',    scope: 'physics', type: 'number', category: 'Powerups', tileScoped: true, tileCategories: ['powerup'], scale: 1000, unit: 's' },
  { key: 'jukeJuiceAccel',    scope: 'physics', type: 'number', category: 'Powerups', scale: 1/60, unit: 'tiles/s²' },
  { key: 'jukeJuiceMaxSpeed', scope: 'physics', type: 'number', category: 'Powerups', unit: 'tiles/s' },
  { key: 'jukeJuiceTimer',    scope: 'physics', type: 'number', category: 'Powerups', playerScoped: true, scale: 1000, unit: 's' },
  { key: 'rollingBombTimer',  scope: 'physics', type: 'number', category: 'Powerups', playerScoped: true, scale: 1000, unit: 's' },
  { key: 'tagproTimer',       scope: 'physics', type: 'number', category: 'Powerups', playerScoped: true, scale: 1000, unit: 's' },
  { key: 'kothPowerup', scope: 'physics', type: 'bool', category: 'Powerups' },

  // Respawn
  { key: 'playerRespawn', scope: 'physics', type: 'number', category: 'Respawn', playerScoped: true, scale: 1000, unit: 's' },

  // Camera - consumed client-side only (loop.js updateCamera); no hooks
  // because nothing server-side bakes the value in anywhere.
  { key: 'cameraZoom',     scope: 'physics', type: 'number', category: 'Camera', playerScoped: true },
  { key: 'allowWheelZoom', scope: 'physics', type: 'bool',   category: 'Camera' },

  // Gravity
  { key: 'gravityX', scope: 'physics', type: 'number', signedOk: true, category: 'Gravity', hooks: ['gravity'], unit: 'tiles/s²' },
  { key: 'gravityY', scope: 'physics', type: 'number', signedOk: true, category: 'Gravity', hooks: ['gravity'], unit: 'tiles/s²' },
  { key: 'jumpStrength', scope: 'physics', type: 'number', category: 'Gravity', unit: 'tiles/s' },
  { key: 'jumpCharges',  scope: 'physics', type: 'number', category: 'Gravity' },

  // Gravity Wells
  // tileScoped here writes through to the well object baked into
  // gameState.wells (matchManager syncWellSettings), since the per-tick
  // force loops (server physicsHelpers, client loop.js) read wells, not
  // config. The well's field radius is force reach, not its hitbox.
  { key: 'gravityWellRadius',   scope: 'physics', type: 'number', category: 'Gravity Wells', hooks: ['gravityWells'], tileScoped: true, tileCategories: ['gravityWell'], unit: 'tiles' },
  // Same per-tick (60Hz) velocity-delta storage as accel - scale:1/60 shows
  // a leader the true tiles/s^2 pull at the well's center.
  { key: 'gravityWellStrength', scope: 'physics', type: 'number', zeroOk: true, category: 'Gravity Wells', hooks: ['gravityWells'], tileScoped: true, tileCategories: ['gravityWell'], scale: 1/60, unit: 'tiles/s²' },
  { key: 'gravityWellFalloff',  scope: 'physics', type: 'enum', options: ['linear', 'constant', 'inverseSquare'], category: 'Gravity Wells', hooks: ['gravityWells'], tileScoped: true, tileCategories: ['gravityWell'] },
  { key: 'gravityWellMode',     scope: 'physics', type: 'enum', options: ['attract', 'repel'], category: 'Gravity Wells', hooks: ['gravityWells'], tileScoped: true, tileCategories: ['gravityWell'] },

  // Eggball - a single catchable/throwable projectile with its own scoring
  // rules, room-wide (not per-player/per-tile - there's only ever one of
  // it). eggballEnabled is its own toggle rather than "any non-default
  // value here turns it on" (same reasoning as kothPowerup/the Powerups
  // toggles above) - the rules differ enough from standard play that a
  // leader needs an explicit on/off. hooks:['eggballToggle'] spawns/
  // despawns the egg immediately on flip, same live-effect pattern as
  // gravity/gravityWells above, instead of only taking effect on the next
  // match start. No separate catch-radius setting - catching is real
  // Box2D collision with the egg's own body (engine/eggball.js's
  // catchEggball), so eggballRadius doubles as the catch distance. See
  // engine/gameConfig.js for what each of the keys below actually controls.
  { key: 'eggballEnabled',           scope: 'physics', type: 'bool',   category: 'Eggball', hooks: ['eggballToggle'] },
  { key: 'eggballRadius',            scope: 'physics', type: 'number', category: 'Eggball', unit: 'tiles' },
  { key: 'eggballThrowStrength',     scope: 'physics', type: 'number', category: 'Eggball', unit: 'tiles/s' },
  { key: 'eggballSpeed',             scope: 'physics', type: 'number', category: 'Eggball', unit: 'tiles/s' },
  { key: 'eggballBounceBonusWindow', scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball', scale: 1000, unit: 's' },
  { key: 'eggballInterceptWindow',   scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball', scale: 1000, unit: 's' },
  { key: 'eggballDensity',           scope: 'physics', type: 'number', category: 'Eggball' },
  { key: 'eggballFriction',          scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball' },
  { key: 'eggballRestitution',       scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball' },
  { key: 'eggballLinearDamping',     scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball' },
  { key: 'eggballAngularDamping',    scope: 'physics', type: 'number', zeroOk: true, category: 'Eggball' },

];

// One entry per powerupTypes.js pad type - a new toggleable powerup only
// ever needs a row in that one table.
const POWERUP_TOGGLE_SCHEMA = POWERUP_TYPES.map(p => ({
  key: p.configKey,
  scope: 'physics',
  type: 'bool',
  category: 'Powerups',
  hooks: ['powerupToggle'],
}));

const MATCH_SCHEMA = [
  // Capped at 1h - server/replay/replayRecorder.js holds a whole match's
  // replay in memory for the life of the match (see its own header
  // comment), and this is the bound that keeps "a few MB at most" true.
  { key: 'timeLimit',         scope: 'match', type: 'number', category: 'Match', scale: 60000, unit: 'min', max: 60 * 60 * 1000 },
  { key: 'scoreLimit',        scope: 'match', type: 'number', intOnly: true, nullable: true, category: 'Match' },
  { key: 'overtimeEnabled',   scope: 'match', type: 'bool', category: 'Match' },
  { key: 'mercyRule',         scope: 'match', type: 'number', intOnly: true, nullable: true, category: 'Match' },
  { key: 'countdownDuration', scope: 'match', type: 'number', category: 'Match', scale: 1000, unit: 's' },
];

const SCHEMA = [...PHYSICS_SCHEMA, ...POWERUP_TOGGLE_SCHEMA, ...MATCH_SCHEMA];

const SCHEMA_BY_KEY = Object.fromEntries(SCHEMA.map(entry => [entry.key, entry]));

function coerce(entry, raw) {
  if (raw === null) {
    if (!entry.nullable) {
      throw new Error(`${entry.key} cannot be null`);
    }
    return null;
  }

  if (entry.type === 'enum') {
    if (!entry.options.includes(raw)) {
      throw new Error(`${entry.key} must be one of: ${entry.options.join(', ')}`);
    }
    return raw;
  }

  if (entry.type === 'bool') {
    return !!raw;
  }

  const value = Number(raw);
  if (entry.intOnly ? !Number.isInteger(value) : !Number.isFinite(value)) {
    throw new Error(`${entry.key} must be a ${entry.intOnly ? 'integer' : 'number'}`);
  }
  if (!entry.signedOk) {
    const min = entry.zeroOk ? 0 : Number.MIN_VALUE;
    if (value < min) {
      throw new Error(`${entry.key} must be a ${entry.zeroOk ? 'non-negative' : 'positive'} number`);
    }
  }
  if (entry.max !== undefined && value > entry.max) {
    throw new Error(`${entry.key} must be at most ${entry.max}`);
  }
  return value;
}

// Validates+coerces every key in `partial` against SCHEMA_BY_KEY, merging
// the result onto a copy of `current`. `allowKey` restricts which schema
// entries are acceptable for this call site (room-wide physics vs
// per-player override vs match settings all share this one function but
// draw from different subsets of SCHEMA).
function applyPartial(partial, current, { allowKey } = {}) {
  const next = { ...current };
  for (const [key, raw] of Object.entries(partial ?? {})) {
    const entry = SCHEMA_BY_KEY[key];
    if (!entry || (allowKey && !allowKey(entry))) {
      throw new Error(`unknown setting: ${key}`);
    }
    next[key] = coerce(entry, raw);
  }
  return next;
}

var SettingsSchema = { SCHEMA, SCHEMA_BY_KEY, coerce, applyPartial };
if (typeof module !== 'undefined' && module.exports) module.exports = SettingsSchema;
if (typeof globalThis !== 'undefined') globalThis.SettingsSchema = SettingsSchema;

})();
