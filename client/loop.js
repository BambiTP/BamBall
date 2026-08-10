// loop.js - the fixed-step local simulation driver. Pipeline per tick:
// apply sync steps -> apply inputs -> apply force fields -> step physics ->
// sync plain-data records. Camera control is NOT here - the old loop.js
// called renderer.setCamera directly from inside the simulation loop, which
// meant the core tick depended on the render layer. Instead this emits a
// 'frame' event once per animation frame; render/camera.js subscribes to
// it in app/bootstrap.js.

var simulationEvents = createEventBus();

var STEP = 1000 / 60;

// How far (0-1) between the last two completed physics steps "now" falls -
// render/renderer.js and render/camera.js lerp entities from their prevX/Y/A
// to their current x/y/a by this fraction. Physics itself always steps in
// fixed 1/60s chunks regardless of display refresh rate (that part already
// worked fine on a 240Hz monitor); without this, the RENDER of that fixed-
// rate motion still only changes once every 60Hz tick, so a 120/240Hz
// display just redraws the same position several times in a row - visually
// choppier than 60Hz, not smoother, despite the extra frames.
var renderAlpha = 1;

function startPhysicsLoop() {
  var lastTime    = engineClock.now();
  var accumulator = 0;

  function tick() {
    try {
      var now = engineClock.now();
      // Clamped to [0, 250]: the upper bound caps a single frame's catch-up
      // work (a backgrounded tab or a big forward seek must not try to
      // simulate minutes of physics in one go); the lower bound matters on
      // the replay page, where engineClock can jump BACKWARD (a scrub/seek
      // resets replayEngine's virtual clock to an earlier point) - Date.now()
      // alone never goes backward, so this floor is a no-op on the live page.
      accumulator += Math.max(0, Math.min(now - lastTime, 250));
      lastTime = now;

      while (accumulator >= STEP) {
        // The server stops ticking entirely while paused; stepping locally
        // would let balls slide on their residual velocity.
        if (settingsState.matchInfo.state !== 'paused') {
          snapshotRenderOrigins(game.players);
          entityReconciler.applySyncSteps(game.players);
          movePlayers(game.players);
          applyForceFields(game.players, game.wells);
          physicsWorld.step(1 / 60);
          syncPlayers(game.players);
        }
        accumulator -= STEP;
      }

      renderAlpha = accumulator / STEP;
      simulationEvents.emit('frame');
    } catch (err) {
      // A single bad frame (e.g. a listener reacting to a death/respawn
      // event throwing) must never permanently stop the RAF chain - that
      // hangs the whole game until a manual refresh, with no visible error
      // unless devtools happened to be open. Log and keep ticking instead.
      console.error('Physics tick failed:', err);
    } finally {
      requestAnimationFrame(tick);
    }
  }

  tick();
}

// Freezes each entity's current simulated position/angle as its lerp origin
// right before this tick moves it. Called once per completed step, so a
// display doing several render frames per step (any refresh rate above 60Hz)
// always has a stable (prev, current) pair to interpolate between instead of
// prev being overwritten mid-lerp.
function snapshotRenderOrigins(players) {
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    p.prevX = p.x;
    p.prevY = p.y;
    p.prevA = p.a;
  }
}
