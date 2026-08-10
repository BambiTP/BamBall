// keyboard.js - key state, keybind lookup, and the movement/menu/chat/
// detonate/zoom keydown-keyup handling. Reads localSettings.keys (never
// hardcodes a binding) and gameState/settingsState directly - no more
// coupling to UI-file globals like the old input.js had (movementFrozen
// used to live in ui.js; it's state/settingsState.js now).

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

function sendInput() {
  actions.sendInput(keyState.left, keyState.right, keyState.up, keyState.down);

  // Server never relays our own input back - apply it locally.
  var me = game.myId !== null ? getPlayer(game.myId) : null;
  if (me) {
    me.left  = keyState.left;
    me.right = keyState.right;
    me.up    = keyState.up;
    me.down  = keyState.down;
  }
}

function initKeyboardInput() {
  rebuildKeyLookup();
  localSettingsEvents.on('localSettings:changed', rebuildKeyLookup);

  window.addEventListener('keydown', function (event) {
    if (isActionKey(event.key, 'menu')) {
      appEvents.emit('menu:toggle');
      return;
    }

    if (isActionKey(event.key, 'chat') && !typingInField()) {
      event.preventDefault();
      appEvents.emit('chat:focus');
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
