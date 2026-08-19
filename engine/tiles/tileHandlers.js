(function () {
// tileHandlers.js - the logic helper file. Every function here is the full
// behavior for one tile interaction. tileLogic.js is only allowed to do
// name/team/state checks and then call exactly one of these.
//
// Trusted inputs only: gameState, gameHelpers, physicsHelpers, gravityLogic,
// config, emitter - all passed in by gameInstance. Handlers never require()
// anything else.

var createTileHandlers = function createTileHandlers(gameState, gameHelpers, physicsHelpers, gravityLogic, config, emitter) {

  // Runs `fn` once the current physics step has finished, via the same
  // microtask deferral gameHelpers.scheduleTileChange already uses (a
  // Promise callback can't run until the synchronous world.Step call
  // unwinds).
  //
  // Player-vs-player pops need this. They fire from a Box2D contact
  // callback, which runs DURING the step and BEFORE the solver applies the
  // collision impulse - and popPlayer freezes the victim, which zeroes its
  // velocity and turns its body into a sensor. Killing inline therefore
  // deleted the contact before it could push anybody: a tag read as passing
  // straight through instead of bumping off, and both balls were left at
  // positions the solver never got to resolve, which is the visible glitch
  // when someone dies. Deferring lets the step resolve the bump first and
  // applies the kill immediately after, on a clean body state.
  //
  // It's also simply the rule: Box2D forbids mutating bodies inside a
  // contact callback, which is how a null deref in here previously managed
  // to take down a whole room from inside SolveTOI.
  //
  // The catch is not optional. Deferred work escapes the tick loop's
  // try/catch, and an unhandled rejection terminates the entire node
  // process under Node's default - one bad pop would take down every room
  // on the server instead of the one it happened in.
  function afterStep(fn) {
    return Promise.resolve().then(fn).catch((err) => {
      console.error('[tileHandlers] deferred pop failed:', err);
    });
  }

  // Shared piece: a used boost flips to its "taken" id, then flips back
  // after its cooldown.
  function useBoost(player, tile, takenId, baseId, cooldown) {
    physicsHelpers.applyBoost(player, gameHelpers.tileSetting(tile.x, tile.y, 'boostMultiplier'));
    gameHelpers.scheduleTileChange(tile.x, tile.y, takenId);
    gameHelpers.scheduleTimeout(function () {
      gameHelpers.scheduleTileChange(tile.x, tile.y, baseId);
    }, cooldown);
    emitter.emit('update', player);
  }

  // Shared piece: a consumed powerup goes empty (6), then respawns as a
  // random enabled powerup after the respawn timer. Waits for the empty
  // tile change to actually land before arming the spawn, since that spawn
  // reads/writes the tile's entry object - racing ahead would write the
  // preview onto the about-to-be-replaced entry instead of the new one.
  // The taker is passed through as the new cycle's holdover contestant -
  // see schedulePowerupSpawn's comment for why that has to be done by hand.
  function consumePowerup(player, tile) {
    gameHelpers.scheduleTileChange(tile.x, tile.y, 6)
      .then(() => gameHelpers.schedulePowerupSpawn(tile.x, tile.y, player.id));
  }

  return {

    // ---- gravity mode --------------------------------------------------------

    // See engine/gravity.js's own resetJump for what this actually does -
    // a plain property write, not a body mutation, so it's safe to run
    // inline from a contact callback (unlike popPlayer, this needs no
    // afterStep defer).
    resetJump(player) {
      gravityLogic.resetJump(player);
    },

    // ---- boosts ------------------------------------------------------------

    // Cooldowns go through gameHelpers.tileSetting: this one boost's
    // leader-set override (DO-NEXT-013) if it has one, else room config.
    boost(player, tile) {
      useBoost(player, tile, 5.1, 5, gameHelpers.tileSetting(tile.x, tile.y, 'boostCooldown'));
    },

    redBoost(player, tile) {
      useBoost(player, tile, 14.1, 14, gameHelpers.tileSetting(tile.x, tile.y, 'redBoostCooldown'));
    },

    blueBoost(player, tile) {
      useBoost(player, tile, 15.1, 15, gameHelpers.tileSetting(tile.x, tile.y, 'blueBoostCooldown'));
    },

    // ---- hazards -----------------------------------------------------------

    bomb(player, tile) {
      const affected = gameHelpers.triggerBomb(tile.x, tile.y);
      emitter.emit('update', affected);
    },

    spike(player) {
      afterStep(() => emitter.emit('update', gameHelpers.popPlayer(player)));
    },

    gate(player) {
      afterStep(() => emitter.emit('update', gameHelpers.popPlayer(player)));
    },

    // ---- flags -------------------------------------------------------------

    flagPickup(player, tile) {
      gameHelpers.pickupFlag(player, tile);
      emitter.emit('update', player);
    },

    // captureAllowed is decided by tileLogic (it's a state check).
    flagCapture(player) {
      gameHelpers.captureFlag(player);
      emitter.emit('update', player);
      emitter.emit('capture', player);
    },

    // ---- eggball -------------------------------------------------------------
    // The score itself (points, win-condition check, post-score freeze/
    // countdown/respawn, next carrier) all needs matchManager's own private
    // state machine, which this file has no reference to - same reasoning
    // flagCapture's separate 'capture' emit already follows, just its own
    // event instead of piggybacking on that one (a normal flag capture
    // doesn't freeze/respawn everyone the way an eggball score does).
    eggballScore(player) {
      emitter.emit('eggballScore', player);
    },

    // ---- powerups ----------------------------------------------------------

    pupJukeJuice(player, tile) {
      gameHelpers.applyJukeJuice(player);
      consumePowerup(player, tile);
      emitter.emit('update', player);
    },

    pupRollingBomb(player, tile) {
      gameHelpers.applyRollingBomb(player);
      consumePowerup(player, tile);
      emitter.emit('update', player);
    },

    pupTagpro(player, tile) {
      gameHelpers.applyTagpro(player);
      consumePowerup(player, tile);
      emitter.emit('update', player);
    },

    // ---- koth powerup contest ------------------------------------------

    pupContestBegin(player, tile) {
      gameHelpers.pupContestBegin(player, tile);
    },

    pupContestEnd(player, tile) {
      gameHelpers.pupContestEnd(player, tile);
    },

    // ---- team tiles ----------------------------------------------------------

    teamTileEnter(player, tile) {
      gameHelpers.addTeamTile(player, tile);
      emitter.emit('update', player);
    },

    teamTileExit(player, tile) {
      gameHelpers.removeTeamTile(player, tile);
      emitter.emit('update', player);
    },

    // ---- portals -----------------------------------------------------------

    portalEnter(player, tile) {
      if (player.lastPortalX === tile.x && player.lastPortalY === tile.y) return;
      player.lastPortalX = tile.destinationTileX;
      player.lastPortalY = tile.destinationTileY;
      physicsHelpers.teleportPlayer(player, tile.destinationX, tile.destinationY).then(() => {
        emitter.emit('update', player);
      });
    },

    portalExit(player, tile) {
      if (player.lastPortalX === tile.x && player.lastPortalY === tile.y) {
        player.lastPortalX = null;
        player.lastPortalY = null;
      }
    },

    // ---- buttons -----------------------------------------------------------

    buttonPress(player, tile) {
      gameHelpers.buttonBegin(player, tile);
      emitter.emit('update', player);
    },

    buttonRelease(player, tile) {
      gameHelpers.buttonEnd(player, tile);
      emitter.emit('update', player);
    },

    // ---- player vs player ----------------------------------------------------

    // Every call site here is already guaranteed cross-team (tileLogic.js's
    // handlePlayerPlayerBegin returns early on a same-team contact before
    // any of these ever dispatch), so an eggball carrier popped through any
    // of these was popped by an enemy - engine/eggball.js's
    // transferEggballOnPop hands it straight to whoever did the popping
    // instead of it dropping free for anyone to grab. Called before
    // popPlayer so its own dropEggball(victim) sees hasEgg already false
    // and no-ops.

    tagproPop(tagger, victim) {
      afterStep(() => {
        gameHelpers.transferEggballOnPop(victim, tagger);
        emitter.emit('update', gameHelpers.popPlayer(victim));
      });
    },

    flagTagPop(tagger, victim) {
      afterStep(() => {
        gameHelpers.transferEggballOnPop(victim, tagger);
        emitter.emit('update', gameHelpers.popPlayer(victim));
      });
    },

    // Both die at once with no single "who popped whom" - whichever of the
    // two happened to be carrying goes to the other, same as either
    // one-sided pop above.
    mutualPop(a, b) {
      afterStep(() => {
        gameHelpers.transferEggballOnPop(a, b);
        gameHelpers.transferEggballOnPop(b, a);
        emitter.emit('update', [].concat(gameHelpers.popPlayer(a), gameHelpers.popPlayer(b)));
      });
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createTileHandlers;
if (typeof globalThis !== 'undefined') globalThis.createTileHandlers = createTileHandlers;
})();
