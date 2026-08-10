// cameraControls.js - pan drag, wheel/key zoom, and spectator camera
// follow. Exposes functions the mouse dispatcher (input/fireInput.js) and
// keyboard handler call into, rather than owning its own top-level DOM
// listeners - pan/zoom/select/tool-use are all mutually exclusive
// interpretations of the same mousedown/mousemove/mouseup stream, so one
// dispatcher has to own the actual `addEventListener` calls.

// Uses worldScale, not camera.zoom: the world is drawn at zoom * the
// viewport fit (render/camera.js), so converting with the bare zoom would
// put every click on the wrong tile at any window size but the reference.
function screenToWorld(clientX, clientY) {
  var rect  = renderer.app.canvas.getBoundingClientRect();
  var scale = renderer.worldScale();
  return {
    x: renderer.camera.x + (clientX - rect.left - renderer.app.renderer.width  / 2) / (GRID_SIZE * scale),
    y: renderer.camera.y + (clientY - rect.top  - renderer.app.renderer.height / 2) / (GRID_SIZE * scale),
  };
}

var panDrag = null; // { startClientX, startClientY, startCamX, startCamY } while dragging

function startPan(clientX, clientY) {
  panDrag = {
    startClientX: clientX,
    startClientY: clientY,
    startCamX:    renderer.camera.x,
    startCamY:    renderer.camera.y,
  };
}

function updatePan(clientX, clientY) {
  if (!panDrag) return false;
  var scale = renderer.worldScale();
  var dx = (clientX - panDrag.startClientX) / (GRID_SIZE * scale);
  var dy = (clientY - panDrag.startClientY) / (GRID_SIZE * scale);
  renderer.setCamera(panDrag.startCamX - dx, panDrag.startCamY - dy, renderer.camera.zoom);
  return true;
}

function endPan() {
  panDrag = null;
}

function isPanning() {
  return !!panDrag;
}

// Playing: wheel/key zoom only if the room allows it, and never further out
// than the leader-set cameraZoom limit (render/camera.js applies
// playerWheelZoom through settingsState.allowedCameraZoom each frame).
// Spectating zooms the free camera directly.
//
// An editor room is exempt: zooming out to see the map you're building is
// basic navigation there, not a privilege the room grants, so it works the
// same whether you're playing or watching.
function zoomIsFree() {
  return game.myId === null || game.roomKind === 'editor';
}

// One wheel notch / key press, in either direction. setPlayerWheelZoom owns
// the clamping (state/settingsState.js) - clamping here as well is how the
// two ended up disagreeing, with a ceiling applied on the way in and the
// floor left to allowedCameraZoom on the way out.
function applyZoomStep(factor) {
  if (!zoomIsFree()) {
    if (!settingsState.physics.allowWheelZoom) return;
    var current = playerWheelZoom !== null ? playerWheelZoom : renderer.camera.zoom;
    settingsState.setPlayerWheelZoom(current * factor);
    return;
  }
  renderer.zoomCamera(factor);
}

function wheelZoom(deltaY) {
  applyZoomStep(deltaY < 0 ? 1.1 : 1 / 1.1);
}

function keyZoom(zoomingIn) {
  applyZoomStep(zoomingIn ? 1.1 : 1 / 1.1);
}

// Where "closest on that axis" is measured from - whoever's currently
// followed, or the camera's current position if nobody is.
function spectateFocusPoint() {
  if (game.spectateFollowId !== null) {
    var followed = getPlayer(game.spectateFollowId);
    if (followed) return { x: followed.x, y: followed.y };
  }
  return { x: renderer.camera.x, y: renderer.camera.y };
}

// Not the nearest player overall - specifically the one closest along the
// axis of the key pressed.
function findNextPlayer(direction) {
  var focus     = spectateFocusPoint();
  var best      = null;
  var bestDelta = Infinity;

  for (var i = 0; i < game.players.length; i++) {
    var p = game.players[i];
    if (p.id === game.spectateFollowId) continue;

    var delta;
    if (direction === 'left')  delta = focus.x - p.x;
    if (direction === 'right') delta = p.x - focus.x;
    if (direction === 'up')    delta = focus.y - p.y;
    if (direction === 'down')  delta = p.y - focus.y;

    if (delta > 1e-6 && delta < bestDelta) {
      best      = p;
      bestDelta = delta;
    }
  }
  return best;
}

function spectateFollow(direction) {
  var next = findNextPlayer(direction);
  if (!next) return;
  game.spectateFollowId = next.id;
}

// Snaps back to whoever's followed (in case a manual drag panned away), or
// back to the map center if nobody is.
function spectateCenterCamera() {
  var followed = game.spectateFollowId !== null ? getPlayer(game.spectateFollowId) : null;
  if (followed) {
    renderer.setCamera(followed.x, followed.y, renderer.camera.zoom);
  } else if (game.map.length) {
    renderer.setCamera(game.map[0].length / 2, game.map.length / 2, renderer.camera.zoom);
  }
}

var cameraControls = {
  startPan: startPan,
  updatePan: updatePan,
  endPan: endPan,
  isPanning: isPanning,
  wheelZoom: wheelZoom,
  keyZoom: keyZoom,
  spectateFollow: spectateFollow,
  spectateCenterCamera: spectateCenterCamera,
};
