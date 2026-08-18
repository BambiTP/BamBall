// net.js - the client's outgoing packet shapes, incoming packet dispatch,
// and round-trip-time tracking. Three small, tightly-coupled networking
// concerns that used to be split across net/packetSchema.js,
// net/packetRouter.js, and net/rttTracker.js - one file since none of them
// is used anywhere outside this trio's own callers (app/actions.js wraps
// packetSchema, app bootstrap wires packetRouter, predict/
// localInputApplier.js + ui reads rttTracker).

// ---- outgoing packet shapes ---------------------------------------------
//
// The ONLY place client->server packet shapes are defined. One function per
// outgoing packet type, each a pure function returning a plain object - no
// sending, no socket access, no game-state reads. This is the client-side
// mirror of server/packets/packetBuilders.js, which is the single source of
// truth for server->client shapes; before this file existed every UI/input
// call site hand-assembled its own packet object inline.
//
// app/actions.js is the only caller of this file - it wraps each builder
// with a call to net/socket.js's send().

var packetSchema = {

  joinRed()       { return { type: 'join_red' }; },
  joinBlue()      { return { type: 'join_blue' }; },
  joinSpectator() { return { type: 'join_spectator' }; },
  joinGame()      { return { type: 'join_game' }; },
  leaveGame()     { return { type: 'leave_game' }; },

  // t: this client's own clock, echoed back verbatim in the 'pong' reply -
  // RTT is just (time this arrives back - t), no clock-sync with the server
  // required.
  ping() {
    return { type: 'ping', t: Date.now() };
  },

  // target: 'all' | 'team' - see local/hostSession.js's handleOutgoing
  // 'chat' case for the routing this actually drives.
  chat(text, target) {
    return { type: 'chat', text, target: target === 'team' ? 'team' : 'all' };
  },

  // Reuses the 'identify' packet type (see hostSession.js) with only
  // flairIndex set - a name/tagpro-token re-send would be redundant since
  // those never change mid-session, so this is a lighter, standalone
  // update for the one field that can.
  setFlair(flairIndex) {
    return { type: 'identify', flairIndex: (typeof flairIndex === 'number') ? flairIndex : null };
  },

  input(left, right, up, down) {
    return { type: 'input', left: !!left, right: !!right, up: !!up, down: !!down };
  },

  detonateBomb() {
    return { type: 'detonateBomb' };
  },

  // dirX/dirY: world-space vector from the carrier to wherever they clicked
  // (client/inputs.js) - need not be normalized, the server only
  // cares about its direction (engine/eggballLogic.js's throwEggball).
  // Client-supplied like every movement input this game already trusts
  // (left/right/up/down), not derived server-side from velocity.
  throwEgg(dirX, dirY) {
    return { type: 'throwEgg', dirX: dirX, dirY: dirY };
  },

  setEditMode(on) {
    return { type: 'set_edit_mode', on: !!on };
  },

  updatePhysics(settings) {
    return { type: 'update_physics', settings };
  },

  updatePlayerPhysics(targetId, settings) {
    return { type: 'update_player_physics', targetId, settings };
  },

  changeMap(mapId) {
    return { type: 'changeMap', mapId };
  },

  // In-memory-only game-state snapshots, keyed by leader-chosen name - see
  // engine/matchManager.js's captureSaveState/restoreSaveState/deleteSaveState.
  saveState(name)   { return { type: 'save_state', name }; },
  loadState(name)   { return { type: 'load_state', name }; },
  deleteState(name) { return { type: 'delete_state', name }; },

  startMatch()  { return { type: 'start_match' }; },
  endMatch()    { return { type: 'end_match' }; },
  pauseMatch()  { return { type: 'pause_match' }; },
  resumeMatch() { return { type: 'resume_match' }; },
  resetGame()   { return { type: 'reset_game' }; },

  updateSettings(settings) {
    return { type: 'update_settings', settings };
  },

  kickPlayer(targetId) {
    return { type: 'kick_player', targetId };
  },

  banPlayer(targetId) {
    return { type: 'ban_player', targetId };
  },

  mutePlayer(targetId, muted) {
    return { type: 'mute_player', targetId, muted: !!muted };
  },

  // Leader powers (kick/mute/ban/match control) are identical for the main
  // leader (the host) and anyone promoted - promote/demote only grants or
  // revokes that set, never targets the main leader (see webrtcTransport.js's
  // handleOutgoingFor, which rejects a demote_leader aimed at the host).
  promoteLeader(targetId) {
    return { type: 'promote_leader', targetId };
  },

  demoteLeader(targetId) {
    return { type: 'demote_leader', targetId };
  },

  setTeamFor(targetId, team) {
    return { type: 'set_team_for', targetId, team };
  },

  // cells: [{x, y}, ...] - callers are responsible for batching; this just
  // shapes one already-batched send. Unused by the client since the map
  // editor UI was removed, kept because the server still handles it.
  setTile(id, cells) {
    return { type: 'set_tile', id, cells };
  },

  // radius null removes the point at that cell (editor only).
  setSpawnPoint(team, x, y, radius, weight) {
    return { type: 'set_spawn_point', team, x, y, radius, weight };
  },

  // action: 'add' | 'remove' | 'clear'. 'clear' omits target.
  setTileConnection(source, target, action) {
    var packet = { type: 'set_tile_connection', source, action };
    if (target !== undefined) packet.target = target;
    return packet;
  },

  updateTileSettings(x, y, settings) {
    return { type: 'update_tile_settings', x, y, settings };
  },

  // profile: 'pregame' | 'game'. bundle: { mapId?, physics?, match? } - see
  // engine/matchManager.js's applyProfile for when each auto-applies.
  updateProfile(profile, bundle) {
    return { type: 'update_profile', profile, bundle };
  },
};

// ---- incoming packet dispatch --------------------------------------------
//
// Dispatches one parsed incoming packet to whichever module(s) subscribed
// to that packet.type. Pure routing: never calls into state/, render/,
// simulation/, or the DOM itself, and has no built-in notion of "packets
// that need the renderer to be ready" - that gate is an explicit, visible
// part of app bootstrap instead of being silently baked into the transport
// layer (the old net.js's needsRenderer map + pendingPackets queue lived
// here and coupled dispatch order to renderer boot state).

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

// ---- round-trip-time tracking ---------------------------------------------
//
// Smoothed round-trip-time estimate to whoever's authoritative for this
// session (the host). Feeds client/predict/localInputApplier.js's input
// delay (apply your own input after rtt/2, so your own screen advances in
// lockstep with when the host will actually compute it - see that file's
// header) and client/ui/hud.js's ping readout. Owns the actual ping/pong
// probe loop itself so both of those are just readers of one number.
//
// EMA-smoothed rather than the raw last-sample value: a single ping/pong
// round trip is noisy (OS scheduling jitter, WebRTC channel buffering), and
// a delayed-apply input scheme that jumped straight to each new raw sample
// would make the local player's own ball visibly stutter every time one
// sample came back slow. alpha=0.2 settles to within ~10% of a step change
// in about 10 samples (~2.5s at the interval below) - fast enough to track
// a real connection-quality change, slow enough not to chase single-sample
// noise.

var PING_INTERVAL_MS = 250;
var RTT_EMA_ALPHA    = 0.2;

var rttTracker = (function () {
  var smoothedRtt = 0; // ms - 0 until the first real sample lands (matches the host's own ~0ms loopback)

  function onPingMeasured(rawMs) {
    smoothedRtt = smoothedRtt === 0 ? rawMs : (RTT_EMA_ALPHA * rawMs + (1 - RTT_EMA_ALPHA) * smoothedRtt);
    appEvents.emit('rtt:updated', smoothedRtt);
  }

  function start() {
    appEvents.on('ping:measured', onPingMeasured);
    actions.ping();
    setInterval(actions.ping, PING_INTERVAL_MS);
  }

  return {
    start: start,
    rtt: function () { return smoothedRtt; },
    delayMs: function () { return smoothedRtt / 2; },
  };
})();
