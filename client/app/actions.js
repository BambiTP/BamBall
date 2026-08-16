// actions.js - the "user/UI intent -> typed outgoing packet" layer. Every
// button handler, keybind, and tool in ui/ and input/ calls a function here
// instead of building a packet object and calling socket.send itself - this
// is the client-side counterpart to the server's single packetBuilders.js,
// which the client never had (every UI call site used to hand-assemble its
// own JSON, duplicating the same packet's shape across dozens of places).

var actions = {
  joinTeam: function (team) {
    if (team === 'red')  return socket.send(packetSchema.joinRed());
    if (team === 'blue') return socket.send(packetSchema.joinBlue());
    return socket.send(packetSchema.joinSpectator());
  },
  joinGame:  function () { socket.send(packetSchema.joinGame()); },
  leaveGame: function () { socket.send(packetSchema.leaveGame()); },

  chat: function (text) { socket.send(packetSchema.chat(text)); },

  ping: function () { socket.send(packetSchema.ping()); },

  sendInput: function (left, right, up, down) {
    socket.send(packetSchema.input(left, right, up, down));
  },

  detonateBomb: function () { socket.send(packetSchema.detonateBomb()); },

  setEditMode: function (on) { socket.send(packetSchema.setEditMode(on)); },

  updatePhysics:       function (settings) { socket.send(packetSchema.updatePhysics(settings)); },
  updatePlayerPhysics: function (targetId, settings) { socket.send(packetSchema.updatePlayerPhysics(targetId, settings)); },

  changeMap: function (mapId) { socket.send(packetSchema.changeMap(mapId)); },

  saveState:   function (name) { socket.send(packetSchema.saveState(name)); },
  loadState:   function (name) { socket.send(packetSchema.loadState(name)); },
  deleteState: function (name) { socket.send(packetSchema.deleteState(name)); },

  startMatch:  function () { socket.send(packetSchema.startMatch()); },
  endMatch:    function () { socket.send(packetSchema.endMatch()); },
  pauseMatch:  function () { socket.send(packetSchema.pauseMatch()); },
  resumeMatch: function () { socket.send(packetSchema.resumeMatch()); },
  resetGame:   function () { socket.send(packetSchema.resetGame()); },

  updateSettings: function (settings) { socket.send(packetSchema.updateSettings(settings)); },

  kickPlayer:  function (targetId) { socket.send(packetSchema.kickPlayer(targetId)); },
  banPlayer:   function (targetId) { socket.send(packetSchema.banPlayer(targetId)); },
  mutePlayer:  function (targetId, muted) { socket.send(packetSchema.mutePlayer(targetId, muted)); },
  promoteLeader: function (targetId) { socket.send(packetSchema.promoteLeader(targetId)); },
  demoteLeader:  function (targetId) { socket.send(packetSchema.demoteLeader(targetId)); },
  setTeamFor:  function (targetId, team) { socket.send(packetSchema.setTeamFor(targetId, team)); },

  setTile: function (id, cells) { socket.send(packetSchema.setTile(id, cells)); },

  setSpawnPoint: function (team, x, y, radius, weight) {
    socket.send(packetSchema.setSpawnPoint(team, x, y, radius, weight));
  },

  setTileConnection: function (source, target, action) {
    socket.send(packetSchema.setTileConnection(source, target, action));
  },

  updateTileSettings: function (x, y, settings) {
    socket.send(packetSchema.updateTileSettings(x, y, settings));
  },

  overlayStroke: function (target, stroke, seq) {
    socket.send(packetSchema.overlayStroke(target, stroke, seq));
  },
  overlayUndo:  function (target) { socket.send(packetSchema.overlayUndo(target)); },
  overlayClear: function (target) { socket.send(packetSchema.overlayClear(target)); },

  // Debug console only - an explicit, clearly-labeled escape hatch that
  // bypasses packetSchema entirely, rather than sharing a code path with
  // every typed action above.
  sendRaw: function (packet) { socket.send(packet); },
};
