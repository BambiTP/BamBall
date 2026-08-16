(function () {
var ForceFields = (typeof require === 'function') ? require('../shared/forceFields') : globalThis.ForceFields;
const { movePlayerVelocity } = (typeof require === 'function') ? require('../shared/movement') : globalThis;
const { tileSetting } = (typeof require === 'function') ? require('./settingsResolver') : globalThis.SettingsResolver;

var createPhysicsHelpers = function(physicsWorld, gameState, config) {
  return {
    // Gravity-mode jump: edge-triggered on a fresh up-press (not held), adds
    // -jumpStrength onto whatever vy the player already has rather than
    // overwriting it - falling into a jump snaps up harder, and stacking a
    // second charge mid-rise launches higher instead of just resetting to
    // the same launch speed. Runs before movePlayers each tick so the
    // normal accel/damping pass still applies on top the same frame -
    // holding down while airborne pulls you down faster, same as any other
    // frame. wasUp/jumpsRemaining are per-player so this is a no-op (0
    // charges) until something (wall contact) grants one.
    applyJumps() {
      for (const p of gameState.players) {
        if (p.dead || p.frozen || p.matchFrozen) continue;

        const pressedNow = !!p.up && !p.wasUp;
        p.wasUp = !!p.up;
        if (!pressedNow || p.jumpsRemaining <= 0) continue;

        const vel = physicsWorld.getVelocity(p.body);
        physicsWorld.setVelocity(p.body, vel.x, vel.y - config.jumpStrength);
        p.jumpsRemaining -= 1;
      }
    },

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

    // World gravity (config.gravityX/Y, set on the b2World itself) applies to
    // every dynamic body every step with no per-body opt-out - this Box2D
    // build predates gravityScale. A dead player is otherwise fully excluded
    // from everything else that could move them (movePlayers, applyForceFields,
    // applyExplosion all skip p.dead above), so without this gravity was the
    // one thing still quietly sinking/drifting a "frozen at their pop
    // position" dead ball for the whole respawn wait. Same story in
    // 'pregame': freezeAll(false) there deliberately leaves players able to
    // walk around before the match starts, but gravity-mode's fall shouldn't
    // be live yet either. Applying an equal-and-opposite force before the
    // step (not zeroing vy after) cancels gravity's contribution to THIS
    // step exactly, so an excluded player's position doesn't even
    // momentarily nudge from it - ApplyForce is scaled by mass because
    // Box2D's solver divides back out by mass during integration, same as
    // how real gravity ends up mass-independent.
    counterGravity() {
      if (!config.gravityX && !config.gravityY) return;

      for (const p of gameState.players) {
        if (!p.body) continue;
        if (!(p.dead || p.frozen || p.matchFrozen || gameState.state === 'pregame')) continue;

        const mass = physicsWorld.getMass(p.body);
        physicsWorld.applyForce(p.body, -mass * config.gravityX, -mass * config.gravityY);
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
