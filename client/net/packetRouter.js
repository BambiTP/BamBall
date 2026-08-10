// packetRouter.js - dispatches one parsed incoming packet to whichever
// module(s) subscribed to that packet.type. Pure routing: this file never
// calls into state/, render/, simulation/, or the DOM itself, and it has no
// built-in notion of "packets that need the renderer to be ready" - that
// gate is an explicit, visible part of app/bootstrap.js instead of being
// silently baked into the transport layer (the old net.js's needsRenderer
// map + pendingPackets queue lived here and coupled dispatch order to
// renderer boot state).

var packetRouter = (function () {
  var listeners = {};
  var anyListeners = [];

  function on(type, handler) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
  }

  // Fires for every packet regardless of type - used for things like the
  // debug console's traffic log, never for state application.
  function onAny(handler) {
    anyListeners.push(handler);
  }

  function dispatch(packet) {
    for (var i = 0; i < anyListeners.length; i++) anyListeners[i](packet);

    var handlers = listeners[packet.type];
    if (!handlers) return;
    for (var j = 0; j < handlers.length; j++) handlers[j](packet);
  }

  return { on, onAny, dispatch };
})();
