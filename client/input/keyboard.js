// keyboard.js - key state, keybind lookup, and the movement/menu/chat/
// detonate/zoom keydown-keyup handling. Reads localSettings.keys (never
// hardcodes a binding) and gameState/settingsState directly - no more
// coupling to UI-file globals like the old input.js had (movementFrozen
// used to live in ui.js; it's state/settingsState.js now).

var keyState = { left: false, right: false, up: false, down: false };

// Updated on every 'ping:measured' (see initKeyboardInput) - sendInput
// below holds the LOCAL player's own predicted input flags back by half
// of this, so local prediction lines up with roughly when the host will
// actually see and act on the real packet, instead of visibly running
// ping/2 ahead of the authoritative sim the way instant local-apply does.
var currentPingMs = 0;

// A later input's delayed apply can finish before an earlier one that got
// delayed longer (e.g. a ping spike mid-flight) - this only ever lets
// state move forward to a NEWER captured input, never backward to a
// stale one that happens to land late.
var localInputSeq  = 0;
var appliedInputSeq = 0;

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
  // Sent immediately - this function's own delay below is purely about
  // when OUR OWN local prediction reflects the change, never about when
  // the host finds out (the host must always get it as soon as possible).
  actions.sendInput(keyState.left, keyState.right, keyState.up, keyState.down);

  // Server never relays our own input back - applied locally instead, but
  // not until roughly half a round trip has passed (see currentPingMs
  // above). Captured now rather than re-read from keyState when the
  // timeout fires, so a key that's already changed again by then doesn't
  // retroactively rewrite what THIS particular update represents.
  var flags = { left: keyState.left, right: keyState.right, up: keyState.up, down: keyState.down };
  var seq = ++localInputSeq;
  setTimeout(function () {
    if (seq < appliedInputSeq) return; // superseded by a newer update that already applied - drop this stale one
    appliedInputSeq = seq;
    var me = game.myId !== null ? getPlayer(game.myId) : null;
    if (me) {
      me.left  = flags.left;
      me.right = flags.right;
      me.up    = flags.up;
      me.down  = flags.down;
    }
  }, currentPingMs / 2);
}

// Enter/Escape on #chatInput itself, not the global keydown handler above -
// blockedByTyping() deliberately lets non-arrow keys pass through untouched
// while chatInput is focused (so typed characters land in the field
// instead of moving the ball), which means send-on-Enter has to be its own
// listener here rather than another branch in that handler.
function initChatInput() {
  var input = document.getElementById('chatInput');
  if (!input) return;

  appEvents.on('chat:focus', function () { input.focus(); });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      var text = input.value.trim();
      input.value = '';
      input.blur();
      if (text) actions.chat(text);
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
    }
  });
}

function initKeyboardInput() {
  rebuildKeyLookup();
  localSettingsEvents.on('localSettings:changed', rebuildKeyLookup);
  appEvents.on('ping:measured', function (ms) { currentPingMs = ms; });
  initChatInput();

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
