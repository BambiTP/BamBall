(function () {
// eventBus.js - tiny synchronous pub/sub, promoted from
// client/game/state/eventBus.js to web/engine/ so the same factory backs
// both GameInstance's server-side-shaped emitter (game/gameInstance.js,
// .on(event, fn)/.emit(event, ...args) only - no .once/.removeListener/
// error-event special-casing anywhere in game/ or server/, confirmed by
// grep) and the client state modules that already used it. Isomorphic:
// required in Node, <script>-loaded as a global in the browser.
//
// Listeners run synchronously, in registration order, during emit().
// factory, not a singleton: each caller that needs one creates its own bus
// so listeners can subscribe to exactly the module they care about.

function createEventBus() {
  var listeners = {};

  function on(event, handler) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(handler);
  }

  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    var handlers = listeners[event];
    if (!handlers) return;
    for (var i = 0; i < handlers.length; i++) {
      // One listener throwing must not skip every listener registered
      // after it.
      try {
        handlers[i].apply(null, args);
      } catch (err) {
        console.error('Listener for "' + event + '" failed:', err);
      }
    }
  }

  return { on: on, emit: emit };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createEventBus: createEventBus };
if (typeof globalThis !== 'undefined') globalThis.createEventBus = createEventBus;

})();
