// engineClock.js - the single time source simulation/loop.js and
// state/settingsState.js read from, instead of calling Date.now() directly.
// On the live page this is pure passthrough (Date.now()), so nothing here
// changes live behavior. client/replay/app/bootstrap.js overrides .now to
// return replayEngine.currentMs() instead - a virtual clock that freezes
// while paused, advances at speed*real-time during playback, and jumps on
// seeks. Since loop.js's fixed-step accumulator and settingsState's timer
// extrapolation both derive from this one value, pause/speed/seek all fall
// out correctly with no change to either file's own control flow.

var engineClock = {
  now: function () { return Date.now(); },
};
