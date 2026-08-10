// entityReconciler.js - server snapshot reconciliation: velocity applies
// immediately (authoritative), position/angle either snaps (teleport,
// signaled by the server's snap counter, or a delta past SYNC_SNAP_DISTANCE)
// or eases in over a few fixed-step ticks. This is simulation logic, not
// pure state, because it reads/writes the physics body directly - state/
// gameState.js only tracks the non-physics entity fields (name, team,
// flags); this module and simulation/loop.js own everything position-
// related.

var SYNC_SNAP_DISTANCE = 5; // tiles - fallback only, the server's snap counter is the real signal
var STEP_MS = 1000 / 60;

// entity: the wire-format snapshot delta (x/y/a/lx/ly/s may be partial).
function reconcilePlayerPosition(player, entity) {
  var now = engineClock.now();
  // Real elapsed time since the LAST correction actually applied, not an
  // assumed broadcast cadence - corrections can arrive faster than any fixed
  // assumption (a burst around a boost/bomb, replay dispatching several
  // records that happened close together in the same frame) or slower (a
  // quiet stretch). Easing over the wrong-for-this-gap window is what turned
  // a real, fast correction into a bigger-than-intended snap: the old fixed
  // 250ms/15-frame window kept assuming a slow trickle even when three
  // corrections landed within one tick of each other, so the first two got
  // discarded (each new call recomputes fresh from the body's CURRENT
  // position) and the third had to cover the whole combined distance in the
  // few frames still left on that stale window - a visible teleport, most
  // noticeable exactly where the position is moving fast (bombs, boosts).
  var elapsed = player.lastReconcileMs !== undefined ? now - player.lastReconcileMs : 250;
  player.lastReconcileMs = now;

  var snapRequested = entity.s !== undefined && entity.s !== player.snapCount;
  if (entity.s !== undefined) player.snapCount = entity.s;

  // Server velocity is authoritative - apply directly so prediction between
  // snapshots starts from the right momentum.
  if (entity.lx !== undefined || entity.ly !== undefined) {
    var vel = physicsWorld.getVelocity(player.body);
    physicsWorld.setVelocity(
      player.body,
      entity.lx !== undefined ? entity.lx : vel.x,
      entity.ly !== undefined ? entity.ly : vel.y
    );
  }

  if (entity.x === undefined && entity.y === undefined && entity.a === undefined) return;

  var pos = physicsWorld.getPosition(player.body);
  var tx  = entity.x !== undefined ? entity.x : pos.x;
  var ty  = entity.y !== undefined ? entity.y : pos.y;
  var ta  = entity.a !== undefined ? entity.a : physicsWorld.getAngle(player.body);

  var dx = tx - pos.x;
  var dy = ty - pos.y;

  var dist = Math.sqrt(dx * dx + dy * dy);

  // TEMP DEBUG - remove once the teleport bug is found.
  if (window.DEBUG_RECONCILE) {
    console.log('[reconcile]', player.id, 'dist=' + dist.toFixed(3), 'elapsed=' + elapsed,
      snapRequested ? 'SNAP(counter)' : (dist > SYNC_SNAP_DISTANCE ? 'SNAP(distance)' : 'ease'));
  }

  if (snapRequested || dist > SYNC_SNAP_DISTANCE) {
    physicsWorld.setPosition(player.body, tx, ty);
    player.body.SetAngle(ta);
    player.sync = null;
    return;
  }

  // Frames to catch up, sized to how long it's actually been since the last
  // correction (clamped so a long quiet gap - a pause, a slow tick - doesn't
  // demand an implausibly long ease, and a burst of near-simultaneous
  // corrections doesn't demand fewer than 1).
  var frames = Math.max(1, Math.min(30, Math.round(elapsed / STEP_MS)));
  player.sync = {
    frames: frames,
    to:   { x: tx, y: ty, a: ta },
    step: {
      x: dx / frames,
      y: dy / frames,
      a: (ta - physicsWorld.getAngle(player.body)) / frames,
    },
  };
}

// Advances every player's in-progress interpolation by one fixed
// step. Overshoot protection: if an axis already passed its target, kill
// that axis's step instead of vibrating around it.
function applySyncSteps(players) {
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (!p.sync) continue;

    var o   = p.sync;
    var pos = physicsWorld.getPosition(p.body);
    var n   = { x: pos.x, y: pos.y, a: physicsWorld.getAngle(p.body) };

    ((o.step.x > 0 && n.x < o.to.x) || (o.step.x < 0 && n.x > o.to.x)) ? (n.x += o.step.x) : (o.step.x = 0);
    ((o.step.y > 0 && n.y < o.to.y) || (o.step.y < 0 && n.y > o.to.y)) ? (n.y += o.step.y) : (o.step.y = 0);
    ((o.step.a > 0 && n.a < o.to.a) || (o.step.a < 0 && n.a > o.to.a)) ? (n.a += o.step.a) : (o.step.a = 0);

    physicsWorld.setPosition(p.body, n.x, n.y);
    p.body.SetAngle(n.a);

    o.frames--;
    if (o.frames <= 0) p.sync = null;
  }
}

var entityReconciler = {
  reconcilePlayerPosition: reconcilePlayerPosition,
  applySyncSteps:          applySyncSteps,
};
