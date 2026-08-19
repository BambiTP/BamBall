(function () {
// eggball.js - everything Eggball Mode is: the settings it needs, the
// egg entity itself, and what happens after a score. Previously split
// three ways with no single file that answered "what does eggball mode
// actually do" - eggballEnabled plus its 9 own physics knobs were just
// rows among a hundred others in gameConfig.js, the egg entity (spawn/
// throw/catch/despawn) lived in its own eggballLogic.js, and the scoring
// aftermath (freeze/countdown/respawn, handing the egg to whoever just
// got scored on) lived inside engine/matchManager.js's scoreEggball. This
// file is that one place now - matchManager.js's own 'eggballScore'
// listener is a one-line delegation into scoreEggball below.

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
      // Solid fixture masked away from players - it still bounces off
      // walls/spikes (their category is untouched), it just never
      // physically contacts a player. Catching them is the sensor fixture
      // below instead.
      maskBits: 0xFFFF & ~physicsWorld.CATEGORY_PLAYER,
    });
    physicsWorld.addSensorFixture(body, config.eggballRadius, physicsWorld.CATEGORY_PLAYER);
    body.SetUserData({ isEggball: true });
    return body;
  }

  return {
    // Picks a random living player on `team` to hold the egg - used both
    // for the very first spawn of a round (matchManager.resetField) and
    // after a score, for the team that just got scored on (this file's
    // own scoreEggball below). Does nothing if that team has nobody to
    // give it to (editor room, or the team is empty) - eggballEnabled
    // staying on with nothing spawned is harmless; the next score or
    // eggballEnabled toggle tries again.
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
      egg.throwerId      = null;
      egg.thrownAtStep   = null;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // Enemy popped the carrier: instead of the egg going free (dropEggball
    // below), it goes straight to whoever made the pop - a direct
    // possession change, no free-for-all pickup in between. tiles/
    // tileHandlers.js's tagproPop/flagTagPop/mutualPop call this before
    // popPlayer(carrier) - popPlayer's own dropEggball(carrier) call
    // becomes a no-op by the time it runs, since carrier.hasEgg is already
    // false. Every caller of this is already guaranteed cross-team by
    // tiles/tileLogic.js's own player-vs-player dispatch (same-team
    // contact never reaches tagproPop/flagTagPop/mutualPop at all), so
    // there's no separate enemy check needed here.
    transferEggballOnPop(carrier, popper) {
      if (!carrier.hasEgg || !popper || popper.dead) return;

      carrier.hasEgg = false;
      popper.hasEgg  = true;

      var egg = gameState.eggball;
      egg.carrierId    = popper.id;
      egg.throwerId    = null;
      egg.thrownAtStep = null;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // dirX/dirY need not be normalized - only their direction matters, the
    // resulting speed always comes from eggballThrowStrength. lastBounceStep
    // is deliberately left alone - the 2x bonus window is a pure "did the
    // egg bounce off a wall within the last N seconds" clock (this file's
    // own scoreEggball below), not tied to any one throw/catch in between.
    // throwerId/thrownAtStep start a SEPARATE clock - catchEggball's own
    // interception check.
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
      egg.throwerId    = player.id;
      egg.thrownAtStep = gameState.stepCount;

      emitter.emit('eggballChanged', serializeEggball());
    },

    // A pop (or disconnect) while carrying: the egg goes free right where
    // it was, catchable by anyone (including the dropper) right away - a
    // drop is involuntary, not a play, so there's no equivalent of the
    // throw's own spawn offset to worry about self-contact. Not a throw -
    // no thrower/interception window starts, this is possession being
    // lost by accident, not a pass anyone could pick off.
    dropEggball(player) {
      if (!player.hasEgg) return;
      player.hasEgg = false;

      var body = makeEggballBody(player.x, player.y);

      var egg = gameState.eggball;
      egg.carrierId    = null;
      egg.body         = body;
      egg.x = player.x; egg.y = player.y; egg.vx = 0; egg.vy = 0;
      egg.throwerId    = null;
      egg.thrownAtStep = null;

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

    // Whether a score made right now would earn the 2x bounce bonus - this
    // file's own scoreEggball reads this at the moment of capture.
    eggballBounceBonusActive() {
      var last = gameState.eggball.lastBounceStep;
      if (last === null) return false;
      var elapsedMs = (gameState.stepCount - last) * (1000 / 60);
      return elapsedMs <= config.eggballBounceBonusWindow;
    },

    // Whether a catch made right now would count as an interception -
    // catchEggball reads this at the moment of capture. Past
    // eggballInterceptWindow since the throw, the egg's just been sitting/
    // bouncing around long enough that picking it up isn't a pick-off
    // anymore, enemy or not.
    eggballInterceptActive() {
      var egg = gameState.eggball;
      if (egg.throwerId === null || egg.thrownAtStep === null) return false;
      var elapsedMs = (gameState.stepCount - egg.thrownAtStep) * (1000 / 60);
      return elapsedMs <= config.eggballInterceptWindow;
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
    //
    // An interception - the enemy team catching a throw while
    // eggballInterceptActive() is still true - pops the thrower, same
    // "risk to throwing" this file's own transferEggballOnPop gives to
    // "risk to carrying" (get popped, hand the enemy the egg outright).
    // Checked and resolved BEFORE the catch below clears throwerId, since
    // that's exactly what this check needs to read.
    catchEggball(player) {
      var egg = gameState.eggball;
      if (!egg.body || player.dead) return;

      var thrower = egg.throwerId !== null ? gameState.getPlayer(egg.throwerId) : null;
      var isInterception = !!thrower && thrower.team !== player.team && this.eggballInterceptActive();

      physicsWorld.destroyBody(egg.body);

      player.hasEgg = true;
      egg.carrierId    = player.id;
      egg.body         = null;
      egg.vx = egg.vy  = 0;
      egg.throwerId    = null;
      egg.thrownAtStep = null;
      // lastBounceStep NOT cleared here - see throwEggball's comment.

      emitter.emit('eggballChanged', serializeEggball());

      if (isInterception) {
        emitter.emit('update', this.popPlayer(thrower));
      }
    },
  };
};

// The complete settings bundle Eggball Mode needs in one click - see
// local/localPresets.js's seeded "Eggball" preset, its only current
// caller. Every one of the egg's own physics knobs is spelled out here
// even where it's numerically still the plain gameConfig.js default, so
// this object alone is a complete answer to "what does eggball mode turn
// on" - including explicitly zeroing world gravity back out, so switching
// into Eggball never leaves Gravity mode's pull silently still active
// underneath (map choice - EGGBALL_MAP_ID - is a content decision, not a
// physics rule, so it stays in local/localPresets.js instead of here, same
// reasoning as engine/gravity.js's own MODE_SETTINGS).
var EGGBALL_MODE_SETTINGS = {
  eggballEnabled:           true,
  eggballRadius:            0.25,
  eggballThrowStrength:     12,
  eggballSpeed:             15,
  eggballBounceBonusWindow: 3000,
  eggballInterceptWindow:   2000,
  eggballDensity:           1,
  eggballFriction:          0,
  eggballRestitution:       1,
  eggballLinearDamping:     0,
  eggballAngularDamping:    0,

  gravityX: 0,
  gravityY: 0,
};

// The Eggball scoring aftermath: despawn the egg, award the score (2x if
// a wall-bounce bonus is active), respawn everyone, freeze+countdown
// mid-match, and hand the egg to whoever just got scored on for the next
// round. Not part of createEggballLogic's own closures above because it
// also needs match-lifecycle operations (win-condition checks, freeze/
// respawn, state transitions) that only engine/matchManager.js owns -
// matchManager wires this in as its 'eggballScore' listener (tiles/
// tileHandlers.js's eggballScore handler is what actually emits it),
// passing itself through as `match` rather than this file reaching back
// into matchManager's own internals directly.
function scoreEggball(player, gameHelpers, gameState, emitter, match) {
  if (gameState.mode === 'editor') return;

  var scoringTeam = player.team;
  var losingTeam  = scoringTeam === 'red' ? 'blue' : 'red';
  var bonus       = gameHelpers.eggballBounceBonusActive();

  gameHelpers.despawnEggball();

  gameState.scores[scoringTeam] += bonus ? 2 : 1;
  emitter.emit('score', gameState.scores);
  emitter.emit('update', player);

  // May end the match outright (score limit / mercy / overtime sudden
  // death) - checkCaptureWinConditions calls endMatch() itself in that
  // case, which already freezes everyone and stops all momentum, so the
  // countdown/respawn/next-carrier steps below must not also run.
  match.checkCaptureWinConditions(player);
  if (gameState.state === 'ended') return;

  match.respawnAll();

  // The freeze+countdown only applies mid-match - matchManager's own
  // countdown handling always resolves BACK to 'live' once
  // countdownDuration elapses (it has no notion of "which state this
  // countdown started from"), so running it during pregame warm-up would
  // incorrectly snap a not-yet-started room into 'live'. A pregame score
  // still respawns everyone above, just without the freeze/countdown
  // ceremony.
  if (gameState.state === 'live') {
    match.freezeAll(true);
    gameState.state          = 'countdown';
    gameState.phaseStartStep = gameState.stepCount;
    emitter.emit('matchStateChanged');
  }

  gameHelpers.spawnEggball(losingTeam);
}

var Eggball = {
  createEggballLogic: createEggballLogic,
  MODE_SETTINGS: EGGBALL_MODE_SETTINGS,
  scoreEggball: scoreEggball,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Eggball;
if (typeof globalThis !== 'undefined') globalThis.Eggball = Eggball;

})();
