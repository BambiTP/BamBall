// fireInput.js - the canvas mouse dispatcher: player selection and pan/zoom.
//
// The map editor's tools (tile placing, freehand draw, wiring) used to be
// dispatched from here too; they're gone from the client along with the rest
// of the editor UI. What's left is the two things a normal player does with
// the mouse on the canvas - select someone, and move the camera.

var SELECT_CLICK_RADIUS = 0.6; // tiles - a bit more forgiving than the ball's render radius

function playerAtWorldPos(x, y) {
  var best = null;
  var bestDist = SELECT_CLICK_RADIUS;
  for (var i = 0; i < game.players.length; i++) {
    var p = game.players[i];
    var dx = p.x - x;
    var dy = p.y - y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

function initFireInput() {
  var canvas = renderer.app.canvas;

  canvas.addEventListener('mousedown', function (event) {
    if (event.button !== 0 || typingInField()) return;

    // Carrying the egg: a click throws it toward wherever was clicked
    // (server re-derives the actual direction from this vector, see
    // engine/eggballLogic.js's throwEggball) instead of the leader-select/
    // camera-pan behavior below - actually playing takes priority over
    // those while holding it. No-op server-side if eggballEnabled is off
    // or this client isn't really the carrier (game.eggball.carrierId is
    // just the last broadcast, and could in theory be stale for one frame).
    if (game.myId !== null && game.eggball.carrierId === game.myId) {
      var carrier = getPlayer(game.myId);
      if (carrier) {
        var throwWorld = screenToWorld(event.clientX, event.clientY);
        actions.throwEgg(throwWorld.x - carrier.x, throwWorld.y - carrier.y);
        return;
      }
    }

    // Clicking a ball selects that player, opening the per-player settings
    // panel. Leader-only, since that panel's controls are - this used to be
    // gated behind edit mode, which no longer exists.
    if (isLeader()) {
      var world = screenToWorld(event.clientX, event.clientY);
      var hit   = playerAtWorldPos(world.x, world.y);
      if (hit) {
        appEvents.emit('player:toggleSelect', hit.id);
        return;
      }
    }

    if (game.myId === null) {
      // Spectating: drag pans freely. A manual drag means "let me look
      // around" - drop any arrow-key follow target so it doesn't fight
      // the drag on the very next frame.
      game.spectateFollowId = null;
      cameraControls.startPan(event.clientX, event.clientY);
    }
  });

  window.addEventListener('mousemove', function (event) {
    cameraControls.updatePan(event.clientX, event.clientY);
  });

  window.addEventListener('mouseup', function () {
    cameraControls.endPan();
  });

  canvas.addEventListener('wheel', function (event) {
    // While actually playing, wheel zoom is a leader-granted permission;
    // a spectator may always zoom, since it costs no one anything.
    if (game.myId !== null && !settingsState.physics.allowWheelZoom) return;
    event.preventDefault();
    cameraControls.wheelZoom(event.deltaY);
  }, { passive: false });
}
