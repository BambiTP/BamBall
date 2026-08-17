(function () {
// eggballLogic.js - the Eggball mode's single projectile: spawn it to a
// random player on a team, throw it (a real Box2D body, its own density/
// friction/restitution/damping - see gameConfig.js - so it bounces off
// walls using the room's own wallRestitution/wallFriction like everything
// else solid), and catch it - real Box2D collision with a player, same
// body/fixture the egg already bounces off walls with (physicsWorld.js's
// contact listener tells the two cases apart by whether the other body is
// a player). Also tracks the wall-bounce timestamp the 2x score bonus
// reads. Split out the same way flagLogic.js is (CODEBASE_AUDIT.md
// pattern) - these methods reach sibling gameHelpers methods via `this.`,
// same reasoning as flagLogic.js's own header comment.
var createEggballLogic = function(gameState, physicsWorld, config, emitter) {
  function serializeEggball() {
    var egg = gameState.eggball;
    return { carrierId: egg.carrierId, x: egg.x, y: egg.y, vx: egg.vx, vy: egg.vy };
  }

  function makeEggballBody(x, y) {
    var body = physicsWorld.createDynamicBody(x, y, {
      radius:         config.eggballRadius,
      density:        config.eggballDensity,
      friction:       config.eggballFriction,
      restitution:    config.eggballRestitution,
      linearDamping:  config.eggballLinearDamping,
      angularDamping: config.eggballAngularDamping,
    });
    body.SetUserData({ isEggball: true });
    return body;
  }

  return {
    // Picks a random living player on `team` to hold the egg - used both
    // for the very first spawn of a round (matchManager.resetField) and
    // after a score, for the team that just got scored on (matchManager's
    // scoreEggball). Does nothing if that team has nobody to give it to
    // (editor room, or the team is empty) - eggballEnabled staying on with
    // nothing spawned is harmless; the next score or eggballEnabled
    // toggle tries again.
    spawnEggball(team) {
      this.despawnEggball();

      var candidates = gameState.players.filter(function (p) { return p.team === team && !p.dead; });
      if (!candidates.length) candidates = gameState.players.filter(function (p) { return p.team === team; });
      if (!candidates.length) return;

      var carrier = candidates[Math.floor(Math.random() * candidates.length)];
      carrier.hasEgg = true;
      gameState.eggball.carrierId = carrier.id;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // Clears whoever's holding it and destroys the free-flying body, if
    // any - "eggball mode just got turned off" or "about to (re)spawn a
    // fresh one" path.
    despawnEggball() {
      var egg = gameState.eggball;
      if (egg.carrierId !== null) {
        var carrier = gameState.getPlayer(egg.carrierId);
        if (carrier) carrier.hasEgg = false;
      }
      if (egg.body) physicsWorld.destroyBody(egg.body);

      egg.carrierId      = null;
      egg.body           = null;
      egg.x = egg.y = egg.vx = egg.vy = 0;
      egg.lastBounceStep = null;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // dirX/dirY need not be normalized - only their direction matters, the
    // resulting speed always comes from eggballThrowStrength. lastBounceStep
    // is deliberately left alone - the 2x bonus window is a pure "did the
    // egg bounce off a wall within the last N seconds" clock (engine/
    // matchManager.js's scoreEggball), not tied to any one throw/catch in
    // between.
    throwEggball(player, dirX, dirY) {
      if (!config.eggballEnabled || !player.hasEgg || gameState.eggball.body) return;

      var len = Math.hypot(dirX, dirY);
      var nx  = len > 0 ? dirX / len : 1;
      var ny  = len > 0 ? dirY / len : 0;

      player.hasEgg = false;

      // Starts just outside the thrower's own hitbox so the new body isn't
      // born already overlapping them - Box2D would otherwise resolve that
      // as a hard separation impulse (or, worse here, an instant self-
      // catch) on the very first step.
      var startDist = config.radius + config.eggballRadius + 0.05;
      var startX    = player.x + nx * startDist;
      var startY    = player.y + ny * startDist;
      var body      = makeEggballBody(startX, startY);
      physicsWorld.setVelocity(body, nx * config.eggballThrowStrength, ny * config.eggballThrowStrength);

      var egg = gameState.eggball;
      egg.carrierId = null;
      egg.body      = body;
      egg.x = startX; egg.y = startY;
      egg.vx = nx * config.eggballThrowStrength;
      egg.vy = ny * config.eggballThrowStrength;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // A pop (or disconnect) while carrying: the egg goes free right where
    // it was, catchable by anyone (including the dropper) right away - a
    // drop is involuntary, not a play, so there's no equivalent of the
    // throw's own spawn offset to worry about self-contact.
    dropEggball(player) {
      if (!player.hasEgg) return;
      player.hasEgg = false;

      var body = makeEggballBody(player.x, player.y);

      var egg = gameState.eggball;
      egg.carrierId = null;
      egg.body      = body;
      egg.x = player.x; egg.y = player.y; egg.vx = 0; egg.vy = 0;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // physicsWorld.js's contact listener (deferred to after the physics
    // step - Box2D forbids mutating bodies inside a contact callback, same
    // reasoning as tiles/tileHandlers.js's afterStep) calls this or
    // catchEggball below depending on whether the other body was a player.
    recordEggballWallBounce() {
      if (!gameState.eggball.body) return; // already caught this step
      gameState.eggball.lastBounceStep = gameState.stepCount;
    },

    // Whether a score made right now would earn the 2x bounce bonus -
    // matchManager.scoreEggball reads this at the moment of capture.
    eggballBounceBonusActive() {
      var last = gameState.eggball.lastBounceStep;
      if (last === null) return false;
      var elapsedMs = (gameState.stepCount - last) * (1000 / 60);
      return elapsedMs <= config.eggballBounceBonusWindow;
    },

    // Called once per tick (gameInstance.js) - pulls the free-flying body's
    // live position/velocity into gameState.eggball (nothing to do while
    // held: the carrier's own position IS the egg's position, already
    // covered by the ordinary player snapshot), clamps speed to
    // eggballSpeed (Box2D restitution can otherwise hand energy back on a
    // bounce), and broadcasts the result. Catching itself happens via real
    // collision (see catchEggball), not anything checked here.
    syncEggball() {
      var egg = gameState.eggball;
      if (!egg.body) return;

      var pos = physicsWorld.getPosition(egg.body);
      var vel = physicsWorld.getVelocity(egg.body);

      var speed = Math.hypot(vel.x, vel.y);
      if (speed > config.eggballSpeed && speed > 0) {
        var scale = config.eggballSpeed / speed;
        vel.x *= scale; vel.y *= scale;
        physicsWorld.setVelocity(egg.body, vel.x, vel.y);
      }

      egg.x = pos.x; egg.y = pos.y; egg.vx = vel.x; egg.vy = vel.y;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // player just physically collided with the free-flying egg (deferred
    // contact - see recordEggballWallBounce's comment). Guarded against
    // the egg already being gone: two contacts (e.g. a mutual near-
    // simultaneous touch) can both defer into the same post-step tick.
    catchEggball(player) {
      var egg = gameState.eggball;
      if (!egg.body || player.dead) return;

      physicsWorld.destroyBody(egg.body);

      player.hasEgg = true;
      egg.carrierId = player.id;
      egg.body      = null;
      egg.vx = egg.vy = 0;
      // lastBounceStep NOT cleared here - see throwEggball's comment.

      emitter.emit('eggballChanged', serializeEggball());
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createEggballLogic;
if (typeof globalThis !== 'undefined') globalThis.createEggballLogic = createEggballLogic;

})();
