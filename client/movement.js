// movement.js - client-side wrapper around the shared movePlayerVelocity
// formula (shared/movement.js). This is the ONLY place the client computes
// player acceleration - loop.js calls this, nothing else duplicates the math.

// Mirrors the server's physicsHelpers.applyJumps (game/physicsHelpers.js) -
// same edge-trigger-on-up, same charge consumption, same additive (not
// overwritten) vy - so a jump fires the instant it's pressed instead of
// waiting on the next snapshot. Runs before movePlayers each tick, same
// order as the server's tick(), so the normal accel/damping pass still
// applies on top the same frame.
function applyJumps(players) {
  if (settingsState.movementFrozen()) return;

  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.dead || p.matchFrozen) continue;

    var pressedNow = !!p.up && !p.wasUp;
    p.wasUp = !!p.up;
    if (!pressedNow || p.jumpsRemaining <= 0) continue;

    var vel = physicsWorld.getVelocity(p.body);
    physicsWorld.setVelocity(p.body, vel.x, vel.y - physConfig.jumpStrength);
    p.jumpsRemaining -= 1;
  }
}

function movePlayers(players) {
  if (settingsState.movementFrozen()) return;

  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.dead || p.matchFrozen) continue;

    var floorFriction = settingsState.getTileOverride(Math.floor(p.x), Math.floor(p.y), 'floorFriction');
    if (floorFriction === undefined) floorFriction = physConfig.floorFriction;

    var vel  = physicsWorld.getVelocity(p.body);
    var next = movePlayerVelocity(vel.x, vel.y, floorFriction, p.accel, p.maxSpeed, p);
    physicsWorld.setVelocity(p.body, next.vx, next.vy);
  }
}

// Mirrors the server's physicsHelpers.applyForceFields - same shared
// ForceFields math, same per-tick cadence, so a well predicts instead of
// only correcting in on the next snapshot.
function applyForceFields(players, wells) {
  if (!wells.length) return;

  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (p.dead) continue;

    var pos    = physicsWorld.getPosition(p.body);
    var vel    = physicsWorld.getVelocity(p.body);
    var result = ForceFields.applyFields(pos.x, pos.y, vel.x, vel.y, wells);
    physicsWorld.setVelocity(p.body, result.vx, result.vy);
  }
}

// Writes simulated position/velocity/angle back onto the plain-data player
// records that render/ reads - the one place physics body state crosses
// back into state/.
function syncPlayers(players) {
  for (var i = 0; i < players.length; i++) {
    var player = players[i];
    var pos    = physicsWorld.getPosition(player.body);
    var vel    = physicsWorld.getVelocity(player.body);
    player.x   = pos.x;
    player.y   = pos.y;
    player.lx  = vel.x;
    player.ly  = vel.y;
    player.a   = physicsWorld.getAngle(player.body);
  }
}
