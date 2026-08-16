// packetSchema.js - the ONLY place client->server packet shapes are defined.
// One function per outgoing packet type, each a pure function returning a
// plain object - no sending, no socket access, no game-state reads. This is
// the client-side mirror of server/packets/packetBuilders.js, which is the
// single source of truth for server->client shapes; before this file existed
// every UI/input call site hand-assembled its own packet object inline.
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

  chat(text) {
    return { type: 'chat', text };
  },

  input(left, right, up, down) {
    return { type: 'input', left: !!left, right: !!right, up: !!up, down: !!down };
  },

  detonateBomb() {
    return { type: 'detonateBomb' };
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

  // target: 'map' | {x, y}. stroke: {points, color, size}. seq is this
  // client's opaque echo-dedup token (see net/packetRouter.js consumers).
  overlayStroke(target, stroke, seq) {
    return { type: 'overlay_stroke', target, stroke, seq };
  },

  overlayUndo(target) {
    return { type: 'overlay_undo', target };
  },

  overlayClear(target) {
    return { type: 'overlay_clear', target };
  },
};
