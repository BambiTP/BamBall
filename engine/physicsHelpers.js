(function () {
// Gravity mode's own jump mechanic (applyJumps/counterGravity) used to
// live here - it's engine/gravity.js now, called directly from
// gameInstance.js's tick loop alongside these, since it's mode-specific
// behavior rather than a generic physics helper every room uses.
var ForceFields = (typeof require === 'function') ? require('../shared/forceFields') : globalThis.ForceFields;
const { movePlayerVelocity } = (typeof require === 'function') ? require('../shared/movement') : globalThis;
const { tileSetting } = (typeof require === 'function') ? require('./settingsResolver') : globalThis.SettingsResolver;

var createPhysicsHelpers = function(physicsWorld, gameState, config) {
  return {
    movePlayers() {
      for (const p of gameState.players) {
        if (p.dead || p.frozen || p.matchFrozen) continue;

        // Extra drag on top of Box2D's own linearDamping - 0 by default, so
        // this is a no-op until a leader sets floorFriction above 0. Read
        // per cell (the tile the player is currently over): a leader-set
        // per-tile override wins, else the room-wide config value.
        const x = Math.floor(p.x), y = Math.floor(p.y);
        const floorFriction = tileSetting(gameState, config, x, y, 'floorFriction');

        const vel  = physicsWorld.getVelocity(p.body);
        const next = movePlayerVelocity(vel.x, vel.y, floorFriction, p.accel, p.maxSpeed, p);
        physicsWorld.setVelocity(p.body, next.vx, next.vy);
      }
    },

    // Runs every tick, same cadence as movePlayers - a well is a continuous
    // force, not a one-shot trigger, so it has to apply before each physics
    // step rather than from a contact event.
    applyForceFields() {
      if (!gameState.wells.length) return;

      for (const p of gameState.players) {
        if (p.dead || p.frozen || p.matchFrozen || !p.body) continue;

        const pos = physicsWorld.getPosition(p.body);
        const vel = physicsWorld.getVelocity(p.body);
        const { vx, vy } = ForceFields.applyFields(pos.x, pos.y, vel.x, vel.y, gameState.wells);
        physicsWorld.setVelocity(p.body, vx, vy);
      }
    },

    syncPlayer(player) {
      const pos = physicsWorld.getPosition(player.body);
      const vel = physicsWorld.getVelocity(player.body);
      player.x  = pos.x;
      player.y  = pos.y;
      player.lx = vel.x;
      player.ly = vel.y;
      player.a  = physicsWorld.getAngle(player.body);
    },

    syncPlayers() {
      for (const player of gameState.players) {
        this.syncPlayer(player);
      }
    },

    applyExplosion(cx, cy, radius, strength, exclude) {
      const affected = [];
      for (const player of gameState.players) {
        if (!player.body) continue;
        // Dead balls are frozen at their pop position waiting to respawn -
        // shoving them would give them velocity that leaks into the respawn.
        if (player.dead) continue;
        if (player === exclude) continue;
        const pos  = physicsWorld.getPosition(player.body);
        const dx   = pos.x - cx;
        const dy   = pos.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < radius) {
          const safeDist = Math.max(dist, 1e-6);
          const boost    = strength * (radius - safeDist);
          const vel      = physicsWorld.getVelocity(player.body);
          physicsWorld.setVelocity(player.body,
            vel.x + (dx / safeDist) * boost,
            vel.y + (dy / safeDist) * boost
          );
          affected.push(player);
        }
      }
      return affected;
    },

    // multiplier: the boost tile's own per-tile override when set
    // (callers pass gameHelpers.tileSetting), else the room default.
    applyBoost(player, multiplier) {
      if (!player.body) return;
      const vel   = physicsWorld.getVelocity(player.body);
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (speed < 1e-4) return;
      const target = player.maxSpeed * (multiplier ?? config.boostMultiplier);
      // Already faster than the boost's target (e.g. from a well, an
      // explosion, or a team-tile speed modifier) - scaling down to target
      // would slow the player, so leave their velocity alone instead.
      if (target <= speed) return;
      const scale = target / speed;
      physicsWorld.setVelocity(player.body, vel.x * scale, vel.y * scale);
    },

    teleportPlayer(player, x, y) {
      // Deferred: Box2D is still mid-Step() when this runs (called from a
      // BeginContact callback), and SetPosition there gets overwritten by
      // the solver before Step() returns. Defer to a microtask so it lands
      // after the physics step actually finishes.
      return Promise.resolve().then(() => {
        physicsWorld.setPosition(player.body, x, y);
        player.x = x;
        player.y = y;
        player.snapCount = (player.snapCount || 0) + 1;
      });
    },

    freezePlayer(player) {
      player.frozen = true;
      physicsWorld.setVelocity(player.body, 0, 0);
      physicsWorld.setSensor(player.body, true);
    },

    unfreezePlayer(player) {
      player.frozen = false;
      physicsWorld.setSensor(player.body, false);
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createPhysicsHelpers;
if (typeof globalThis !== 'undefined') globalThis.createPhysicsHelpers = createPhysicsHelpers;
})();
