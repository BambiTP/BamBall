// inputs.js - everything the player does with keyboard + mouse: key state,
// keybind lookup, movement/menu/chat/detonate/zoom keydown-keyup handling,
// camera pan/drag/zoom/spectate-follow, and the canvas mouse dispatcher
// (player selection, egg throw, pan). One file because these three used to
// be split across keyboard.js/cameraControls.js/fireInput.js and nothing
// outside this file ever called into cameraControls or fireInput's helpers
// directly - splitting bought no isolation, just extra navigation.
//
// Reads localSettings.keys (never hardcodes a binding) and gameState/
// settingsState directly - no coupling to UI-file globals like the old
// input.js had (movementFrozen used to live in ui.js; it's
// client/state.js now).

// ---- camera: pan, zoom, spectate-follow --------------------------------

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
// the clamping (client/state.js) - clamping here as well is how the
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

// ---- mouse: player select, egg throw, pan/zoom dispatch ----------------
//
// The map editor's tools (tile placing, freehand draw, wiring) used to be
// dispatched from here too; they're gone from the client along with the
// rest of the editor UI. What's left is the two things a normal player
// does with the mouse on the canvas - select someone, and move the camera.

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
    // engine/eggball.js's throwEggball) instead of the leader-select/
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

// ---- keyboard: key state, keybind lookup, movement/menu/chat/detonate/zoom ----

var keyState = { left: false, right: false, up: false, down: false };

// event.key -> movement direction, derived from localSettings.keys. Rebuilt
// whenever a binding changes. Single letters match case-insensitively so
// Shift+w still moves.
var keyMap = {};

function rebuildKeyLookup() {
  keyMap = {};
  var directions = ['up', 'down', 'left', 'right'];
  for (var d = 0; d < directions.length; d++) {
    var bindings = localSettings.keys[directions[d]];
    for (var i = 0; i < bindings.length; i++) {
      keyMap[bindings[i]] = directions[d];
      if (bindings[i].length === 1) {
        keyMap[bindings[i].toLowerCase()] = directions[d];
        keyMap[bindings[i].toUpperCase()] = directions[d];
      }
    }
  }
}

function isActionKey(eventKey, action) {
  var bindings = localSettings.keys[action];
  for (var i = 0; i < bindings.length; i++) {
    if (eventKey === bindings[i]) return true;
    if (bindings[i].length === 1 && eventKey.length === 1 &&
        eventKey.toLowerCase() === bindings[i].toLowerCase()) return true;
  }
  return false;
}

function typingInField() {
  var el = document.activeElement;
  return el && el.tagName === 'INPUT';
}

// Chat is the one input where movement and typing overlap: WASD needs to
// stay text while composing a message, but arrow keys should still drive
// the ball rather than getting swallowed like in every other field.
function blockedByTyping(event) {
  if (document.activeElement === document.getElementById('chatInput')) {
    return event.key.indexOf('Arrow') !== 0;
  }
  return typingInField();
}

// Send + delayed local apply both live in client/predict/localInputApplier.js
// now - this just hands off the current key state.
function sendInput() {
  localInputApplier.send(keyState);
}

// Which audience Enter will send to right now - 'all' unless chat:focus was
// last raised with 'team' (client/inputs.js's own teamChat keybind below,
// or client/ui/hud.js triggering it some other way in the future). Reset
// back to 'all' every time the input closes so a leftover team-chat isn't
// silently still armed the next time Enter alone opens it.
var chatTarget = 'all';

// Border/text color while composing - team-colored to match whichever
// audience is about to receive it, same signal tagpro.js's own chat input
// gives (this file's chatColorFor mirrors that handler's red/blue pastel
// pair). 'all' (or a spectator with no team to color by) just uses the
// theme's normal accent.
function chatColorFor(target) {
  if (target === 'team') {
    var me = game.myId !== null ? getPlayer(game.myId) : null;
    if (me && me.team === 'red') return '#FFB5BD';
    if (me && me.team === 'blue') return '#CFCFFF';
  }
  return '';
}

// Enter/Escape on #chatInput itself, not the global keydown handler below -
// blockedByTyping() deliberately lets non-arrow keys pass through untouched
// while chatInput is focused (so typed characters land in the field
// instead of moving the ball), which means send-on-Enter has to be its own
// listener here rather than another branch in that handler.
function initChatInput() {
  var input = document.getElementById('chatInput');
  var log   = document.getElementById('chatLog');
  if (!input) return;

  // Only while actually composing does the log show its full scrollback -
  // collapsing it also re-hides anything that already passed its 20s fade
  // (client/ui/hud.js's appendChatMessage), same "history only while
  // you're typing" behavior real TagPro's own chat has.
  function collapseChatLog() {
    if (!log) return;
    log.classList.remove('expanded');
    var expired = log.querySelectorAll('.chatRow[data-expired="true"]');
    for (var i = 0; i < expired.length; i++) expired[i].classList.add('chatRowFaded');
  }

  appEvents.on('chat:focus', function (target) {
    chatTarget = target === 'team' ? 'team' : 'all';
    var color = chatColorFor(chatTarget);
    input.style.color = color;
    input.style.borderColor = color || '';
    input.placeholder = chatTarget === 'team' ? 'Team chat - Press Enter to send' : 'Press Enter to chat';
    if (log) log.classList.add('expanded');
    input.focus();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      var text = input.value.trim();
      input.value = '';
      input.blur();
      if (text) actions.chat(text, chatTarget);
      chatTarget = 'all';
      collapseChatLog();
      return;
    }
    if (event.key === 'Escape') {
      // Without this, the global keydown handler below (which checks the
      // menu keybind unconditionally, with no typingInField() gate) would
      // also see this same Escape and pop the pause menu open right behind
      // it - not what "cancel this chat message" should do.
      event.stopPropagation();
      input.value = '';
      input.blur();
      chatTarget = 'all';
      collapseChatLog();
    }
  });
}

function initKeyboardInput() {
  rebuildKeyLookup();
  localSettingsEvents.on('localSettings:changed', rebuildKeyLookup);
  initChatInput();

  window.addEventListener('keydown', function (event) {
    if (isActionKey(event.key, 'menu')) {
      appEvents.emit('menu:toggle');
      return;
    }

    if (isActionKey(event.key, 'chat') && !typingInField()) {
      event.preventDefault();
      appEvents.emit('chat:focus', 'all');
      return;
    }

    if (isActionKey(event.key, 'teamChat') && !typingInField()) {
      event.preventDefault();
      appEvents.emit('chat:focus', 'team');
      return;
    }

    if (blockedByTyping(event)) return;

    if (isActionKey(event.key, 'zoomIn') || isActionKey(event.key, 'zoomOut')) {
      event.preventDefault();
      cameraControls.keyZoom(isActionKey(event.key, 'zoomIn'));
      return;
    }

    // Not in a game: movement keys no-op as movement anyway, so repurpose
    // them as the spectator camera controls instead of falling through.
    if (game.myId === null) {
      var followDirection = keyMap[event.key];
      if (followDirection) {
        event.preventDefault();
        cameraControls.spectateFollow(followDirection);
        return;
      }
      if (isActionKey(event.key, 'detonate')) {
        event.preventDefault();
        cameraControls.spectateCenterCamera();
        return;
      }
    }

    if (isActionKey(event.key, 'detonate')) {
      event.preventDefault();
      actions.detonateBomb();
      return;
    }

    // Unbound by default (see localSettings.js) - server rejects it for a
    // non-leader anyway, so no client-side leadership check needed here.
    if (isActionKey(event.key, 'pause')) {
      event.preventDefault();
      if (settingsState.matchInfo.state === 'paused') actions.resumeMatch(); else actions.pauseMatch();
      return;
    }

    var direction = keyMap[event.key];
    if (!direction || keyState[direction]) return;

    keyState[direction] = true;
    sendInput();
  });

  window.addEventListener('keyup', function (event) {
    if (blockedByTyping(event)) return;

    var direction = keyMap[event.key];
    if (!direction || !keyState[direction]) return;

    keyState[direction] = false;
    sendInput();
  });
}
