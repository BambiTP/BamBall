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

// Set by local/main.js only when this tab owns the authoritative
// GameInstance (host or solo - see webrtcTransport.js/localTransport.js's
// gameInstance()). A pure peer (or a real remote-server client, if this
// ever talks to one again) leaves this null and gets the ordinary
// network-driven prediction/reconciliation below, unchanged.
var authoritativeLocalSource = null;
function setAuthoritativeLocalSource(fn) { authoritativeLocalSource = fn; }

// Re-anchors the local player's own body to the in-process, authoritative
// GameInstance instead of trusting this file's independent prediction of
// it. Host/solo run TWO separate Box2D worlds in the same tab - this one
// (still needed for every OTHER player, who has no authoritative body to
// read) and the engine's own - and even given identical input and physics
// constants, two independently-built Box2D worlds aren't guaranteed to
// resolve a collision identically (solver/contact order depends on each
// World's own body list, populated in a different order by each build).
// Over real network latency that's invisible, normal snapshot correction
// absorbs it - but for the host (0 ping) it showed up as this file's OWN
// prediction quietly disagreeing with what this same tab already knows is
// true, drifting until it crossed entityReconciler's SYNC_SNAP_DISTANCE
// and then hard-teleporting to catch up - most visible right after a
// corner hit each simulation resolved slightly differently. Since gi lives
// in this same process, reading its answer costs nothing; doing it right
// before this step's own prediction runs bounds any disagreement to a
// single step (sub-pixel, self-heals next frame) instead of letting two
// guesses compound into genuinely different trajectories.
function mirrorAuthoritativeLocalPlayer() {
  if (!authoritativeLocalSource || game.myId === null) return;
  var authPlayer = authoritativeLocalSource();
  if (!authPlayer) return;
  var me = getPlayer(game.myId);
  if (!me || !me.body) return;
  physicsWorld.setPosition(me.body, authPlayer.x, authPlayer.y);
  physicsWorld.setVelocity(me.body, authPlayer.lx, authPlayer.ly);
  me.body.SetAngle(authPlayer.a);
}

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
          mirrorAuthoritativeLocalPlayer();
          snapshotRenderOrigins(game.players);
          entityReconciler.applySyncSteps(game.players);
          applyJumps(game.players);
          movePlayers(game.players);
          applyForceFields(game.players, game.wells);
          counterGravity(game.players);
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
