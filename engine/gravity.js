(function () {
// gravity.js - everything Gravity Mode is: the settings it needs, and the
// jump mechanic it adds. Previously split three ways with no single file
// that answered "what does gravity mode actually do" - gravityX/Y and
// jumpStrength/jumpCharges were just rows among a hundred others in
// gameConfig.js, the jump mechanic itself (applyJumps/counterGravity) lived
// in physicsHelpers.js alongside every generic, mode-agnostic physics
// helper, and the wall-contact jump recharge (resetJump) lived in
// tiles/tileHandlers.js. This file is that one place now.
//
// World gravity (config.gravityX/Y) itself is still just a plain b2World
// property (see physicsWorld.js's constructor/setGravity) - that's a raw
// Box2D primitive, not gravity-MODE behavior, so it stays there. What
// belongs here is everything gravity being on actually causes: the jump
// mechanic, and the settings bundle a leader flips on to get all of it.

const Gravity = {
  // The complete settings bundle Gravity Mode needs in one click - see
  // local/localPresets.js's seeded "Gravity" preset, its only current
  // caller. Every gravity-adjacent key is spelled out here even where it's
  // numerically still the plain gameConfig.js default, so this object
  // alone is a complete answer to "what does gravity mode turn on" -
  // including explicitly turning Eggball off, so switching into Gravity
  // never leaves the other mode's toggle silently still on underneath.
  MODE_SETTINGS: {
    gravityX: 0,
    gravityY: 15,
    jumpStrength: 7.5,
    jumpCharges: 1,

    // Gravity Wells share the room's one global tuning (gameConfig.js) -
    // included here too even though a well only ever does anything on a
    // map that actually has GravityWell tiles placed on it.
    gravityWellRadius: 3,
    gravityWellStrength: 0.05,
    gravityWellFalloff: 'linear',
    gravityWellMode: 'attract',

    eggballEnabled: false,
  },
};

// gameState/physicsWorld/config-bound jump logic, same factory shape as
// engine/physicsHelpers.js's own (and previously part of that very file) -
// gameInstance.js constructs one alongside physicsHelpers and passes it
// into tiles/tileHandlers.js as a trusted input, same as physicsHelpers
// itself (tileHandlers.js's own header comment: handlers never require()
// anything, every dependency arrives this way), plus calls applyJumps/
// counterGravity directly every tick, in the same order they always ran in.
function createGravityLogic(gameState, physicsWorld, config) {
  return {
    // Wall-contact jump refill - touching a wall counts as "grounded"
    // (untested guess for what should grant a jump back, easy to swap for
    // a narrower check later, e.g. only the bottom-facing contact normal).
    // Called from tiles/tileHandlers.js's own resetJump entry, which every
    // wall BeginContact dispatches through (tiles/tileLogic.js) - a plain
    // property write, not a body mutation, so it's safe to call inline
    // from a contact callback with no afterStep defer needed.
    resetJump(player) {
      player.jumpsRemaining = config.jumpCharges;
    },

    // Edge-triggered on a fresh up-press (not held), adds -jumpStrength
    // onto whatever vy the player already has rather than overwriting it -
    // falling into a jump snaps up harder, and stacking a second charge
    // mid-rise launches higher instead of just resetting to the same
    // launch speed. Runs before movePlayers each tick so the normal
    // accel/damping pass still applies on top the same frame - holding
    // down while airborne pulls you down faster, same as any other frame.
    // wasUp/jumpsRemaining are per-player, so this is a no-op (0 charges)
    // until something (wall contact, via resetJump above) grants one.
    applyJumps() {
      // Gravity-mode only - same "is gravity actually on" check
      // counterGravity below also uses. Without this, pressing up (also
      // one of the four movement directions) launched players in standard
      // play too, with nothing to pull them back down since gravityY is 0.
      if (!config.gravityX && !config.gravityY) return;

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

    // World gravity (config.gravityX/Y, set on the b2World itself) applies
    // to every dynamic body every step with no per-body opt-out - this
    // Box2D build predates gravityScale. A dead player is otherwise fully
    // excluded from everything else that could move them (movePlayers,
    // applyForceFields, applyExplosion all skip p.dead), so without this
    // gravity was the one thing still quietly sinking/drifting a "frozen
    // at their pop position" dead ball for the whole respawn wait. Same
    // story in 'pregame': freezeAll(false) there deliberately leaves
    // players able to walk around before the match starts, but gravity-
    // mode's fall shouldn't be live yet either. Applying an equal-and-
    // opposite force before the step (not zeroing vy after) cancels
    // gravity's contribution to THIS step exactly, so an excluded player's
    // position doesn't even momentarily nudge from it - ApplyForce is
    // scaled by mass because Box2D's solver divides back out by mass
    // during integration, same as how real gravity ends up mass-independent.
    counterGravity() {
      if (!config.gravityX && !config.gravityY) return;

      for (const p of gameState.players) {
        if (!p.body) continue;
        if (!(p.dead || p.frozen || p.matchFrozen || gameState.state === 'pregame')) continue;

        const mass = physicsWorld.getMass(p.body);
        physicsWorld.applyForce(p.body, -mass * config.gravityX, -mass * config.gravityY);
      }
    },
  };
}

Gravity.createGravityLogic = createGravityLogic;

if (typeof module !== 'undefined' && module.exports) module.exports = Gravity;
if (typeof globalThis !== 'undefined') globalThis.Gravity = Gravity;
})();
