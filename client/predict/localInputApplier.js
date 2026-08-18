// localInputApplier.js - applies the LOCAL player's own input to their
// prediction with a delay of roughly half the current round trip to the
// host (rttTracker.delayMs()), so the local player's own screen advances
// in lockstep with when the host will actually see and act on the real
// input packet - the host's own tab always has ~0 delay (rttTracker's
// synchronous host loopback), everyone else's tracks their real
// connection. Sending to the host itself is never delayed - that part of
// sendInput happens immediately, same as it always has; only the LOCAL
// reflection of the change waits.
//
// Was embedded directly in client/inputs.js, which should only
// own "what keys are currently down" - split out so that responsibility
// (deciding WHEN an input takes local effect) lives in exactly one place,
// separate from capturing it.

var localInputApplier = (function () {
  // A later input's delayed apply can finish before an earlier one that got
  // delayed longer (e.g. an RTT spike mid-flight) - this only ever lets
  // state move forward to a NEWER captured input, never backward to a
  // stale one that happens to land late.
  var seq        = 0;
  var appliedSeq = 0;

  // flags: { left, right, up, down } - the caller's current key state.
  // Sent to the host immediately; captured by value now (not re-read from
  // the caller's live object when the timeout fires) so a key that's
  // already changed again by then doesn't retroactively rewrite what THIS
  // particular update represents.
  function send(flags) {
    actions.sendInput(flags.left, flags.right, flags.up, flags.down);

    var captured  = { left: flags.left, right: flags.right, up: flags.up, down: flags.down };
    var thisSeq   = ++seq;
    var delayMs   = rttTracker.delayMs();

    setTimeout(function () {
      if (thisSeq < appliedSeq) return; // superseded by a newer update that already applied - drop this stale one
      appliedSeq = thisSeq;
      var me = game.myId !== null ? getPlayer(game.myId) : null;
      if (!me) return;
      me.left  = captured.left;
      me.right = captured.right;
      me.up    = captured.up;
      me.down  = captured.down;
    }, delayMs);
  }

  return { send: send };
})();
