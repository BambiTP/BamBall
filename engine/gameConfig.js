(function () {
const gameConfig = {
  defaultMapId: 97675,

  gravityX: 0,
  gravityY: 0,

  // Gravity-mode jump: pressing up (edge-triggered, not held) adds
  // -jumpStrength onto the current vy instead of accel-nudging it or
  // overwriting it outright, then normal movement keeps applying accel on
  // top every frame same as always - holding down mid-air still pulls you
  // down faster. Charges refill on touching a wall. Both values are
  // untested guesses (3 TPU/s -> tiles, 1 charge) pending real-game
  // comparison.
  jumpStrength: 7.5,
  jumpCharges:  1,

  // TagPro values converted from TPU to tiles (1 TPU = 2.5 tiles).
  radius:         0.475,
  density:        1,      // TagPro server fixture: { density: 1 }
  friction:       0.5,
  restitution:    0.2,

  // The player ball's own fixture friction, exposed separately from the
  // generic `friction` default above so a leader can tune it without
  // affecting anything else that might fall back to that default.
  playerFriction: 0.5,
  linearDamping:  0.5,
  angularDamping: 0.5,
  accel:          0.0625,  // 1.5 TPU/s^2 = 0.025 TPU/frame = 0.0625 tiles/frame
  maxSpeed:       6.25,    // 2.5 TPU/s
  playerRespawn:  3000,

  // Wall surface properties. Box2D combines restitution as max(ball, wall)
  // and friction as sqrt(ball * wall). These defaults match Box2D's own
  // fixture defaults, so behavior is unchanged until a leader edits them.
  wallRestitution: 0,
  wallFriction:    0.2,

  // Extra per-tick drag on top of Box2D's own linearDamping - 0 means no
  // added friction, matching current behavior until a leader turns it on.
  floorFriction: 0,

  boostMultiplier:     3,    // TagPro server: speedpadModifier

  bombRadius:          7,
  bombStrength:        1.25, // TagPro server: explosionTypes.BOMB maxForce

  rollingBombRadius:   5,
  rollingBombStrength: 0.75,

  portalExploRadius:   4,
  portalExploStrength: 0.25,

  deathExploRadius:    3.5,   // fit from real replay data: 3.509
  deathExploStrength:  0.6175, // fit from real replay data (3 clean spike-death samples, R^2 ~1.0)

  // Grace period after grabbing a flag during which the carrier can't be
  // popped by any cause (spike, gate, tag, mutual pop) - stops a defender
  // from instantly punishing a grab before the carrier has a chance to
  // move.
  flagGrabInvulnEnabled: true,
  flagGrabInvulnMs:      250,

  boostCooldown:     10000,
  redBoostCooldown:  10000,
  blueBoostCooldown: 10000,
  bombCooldown:      30000,

  teamTileAccel:    0.0925,
  teamTileMaxSpeed: 12.5,
  jukeJuiceAccel:   0.0775,
  jukeJuiceMaxSpeed: 6.25,

  // Per-well radius/strength are here (not per-tile in the map data) since
  // every GravityWell tile shares one global tuning, same as bombRadius.
  gravityWellRadius:   3,
  gravityWellStrength: 0.05,
  gravityWellFalloff:  'linear', // 'linear' | 'constant' | 'inverseSquare'
  gravityWellMode:     'attract', // 'attract' | 'repel'

  powerupRespawn:   5000,
  tagproTimer:      20000,
  rollingBombTimer: 20000,
  jukeJuiceTimer:   20000,

  // Toggles matching game/tiles/powerupTypes.js's configKey per pad type -
  // a leader can turn any of these off in Group Settings without a single
  // powerup-specific line changing anywhere else.
  jukeJuiceEnabled:   true,
  rollingBombEnabled: true,
  tagproEnabled:      true,

  // If true, a pad that's about to spawn is awarded immediately to whoever
  // has been in continuous contact with it the longest (instead of only the
  // first *new* contact after it spawns) - lets a player who's been holding
  // ground on a contested pad win it without having to back off and re-touch.
  kothPowerup: false,

  // Eggball - a single catchable/throwable projectile with its own scoring
  // rules; off by default. radius is the egg's own size (0.25 tiles = a
  // 20px-diameter circle at this engine's 40px/tile scale). throwStrength
  // is its launch speed when thrown; speed is a hard velocity cap enforced
  // every tick after that (walls can otherwise add energy back on a bounce,
  // this keeps it from running away). bounceBonusWindow is how long after a
  // wall bounce a score is still worth the 2x bonus (see engine/
  // eggball.js's scoreEggball). density/friction/restitution/damping
  // are its Box2D fixture/body properties - same knobs a leader already
  // has for the player ball itself, just this object's own copies (see
  // engine/eggball.js's makeEggballBody) so its bounciness/weight/
  // spin can be tuned independently. No separate catch-radius setting -
  // catching is real collision with this same body/radius, not a distance
  // check - or a "respawn" delay (after a score the match's own
  // countdownDuration, Match category, is reused for the freeze before
  // everyone - and the egg - respawns).
  eggballEnabled:           false,
  eggballRadius:            0.25,
  eggballThrowStrength:     12,
  eggballSpeed:             15,
  eggballBounceBonusWindow: 3000,
  // How long after a throw an enemy catch still counts as an interception
  // (see engine/eggball.js's catchEggball) - past this window a free-
  // flying egg has just been "sitting on the ground" long enough that
  // picking it up, enemy or not, is an ordinary catch, not a pick-off.
  eggballInterceptWindow:   2000,
  eggballDensity:           1,
  eggballFriction:          0,
  eggballRestitution:       1,
  eggballLinearDamping:     0,
  eggballAngularDamping:    0,

  // Camera. cameraZoom is the zoom level a player renders at (lower =
  // further out = more map), tunable room-wide or per player; allowWheelZoom
  // additionally lets players wheel away from it while playing, in either
  // direction. The server never reads either; they ride the existing
  // physics-settings pipeline to the client.
  cameraZoom:     1,
  allowWheelZoom: false,

  // The view at zoom 1, in world pixels: what snapshotFactory culls players
  // against, and what the client's camera sizes its view from. The two have
  // to agree - a client rendering wider than this has a border zone where
  // players aren't sent to it yet - so this pairs with REFERENCE_VIEW_WIDTH
  // / REFERENCE_VIEW_HEIGHT in client/game/render/camera.js. Change one,
  // change the other.
  //
  // NOTE: snapshotFactory divides these by `viewer.zoom`, which nothing
  // currently sets, so culling is always at zoom 1 - a player whose zoom is
  // below 1 sees a band at the edges that the server isn't populating.
  viewportWidth:  1280,
  viewportHeight: 800,
  snapshotInterval: 250,
};

if (typeof module !== 'undefined' && module.exports) module.exports = gameConfig;
if (typeof globalThis !== 'undefined') globalThis.gameConfig = gameConfig;
})();
