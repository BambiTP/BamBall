// packetApplier.js - applies one incoming packet to state/simulation/
// render. This is the client-side counterpart to the old packetHandlers.js,
// but split from transport (net/packetRouter.js only dispatches) and no
// longer touching the DOM directly - UI-visible effects (status text, chat
// log, roster refresh) go through appEvents; ui/ subscribes and renders
// them. app/bootstrap.js registers every handler below onto packetRouter
// once, at startup.
//
// 'joined' is deliberately NOT registered through the normal per-type
// table - it needs two-phase handling (seed state now, boot renderer/
// physics/sprites after an async fetch), so app/bootstrap.js calls
// applyJoined directly instead of going through packetRouter for it.

var ROLLING_BOMB_PARTICLE_LEAD_MS = 5000;

// playerId -> {left,right,up,down} for an 'input' packet that arrived
// before that player existed locally yet (see the 'input' handler below).
// Flushed onto the real player object the moment it's created.
var pendingInput = {};
gameEvents.on('player:created', function (player) {
  var pending = pendingInput[player.id];
  if (!pending) return;
  player.left  = pending.left;
  player.right = pending.right;
  player.up    = pending.up;
  player.down  = pending.down;
  delete pendingInput[player.id];
});

// Wall edits redraw every tile through renderer.redrawTiles (autotiled wall
// art can't be patched per cell), which is too heavy to run once per cell
// of a drag-painted wall line. Debounce: a burst of setTile packets from
// one stroke batch redraws once.
var wallRedrawTimer = null;
var WALL_REDRAW_DEBOUNCE_MS = 50;

function scheduleWallRedraw() {
  if (wallRedrawTimer !== null) return;
  wallRedrawTimer = setTimeout(function () {
    wallRedrawTimer = null;
    physicsWorld.buildWalls(game.wallMap);
    physicsWorld.buildSpikes(game.map);
    renderer.redrawTiles();
  }, WALL_REDRAW_DEBOUNCE_MS);
}

function seedMapState(packet) {
  game.map       = packet.map;
  game.wallMap   = packet.wallMap;
  game.wells     = packet.wells || [];
  game.mapId     = packet.mapId     !== undefined ? packet.mapId     : null;
  game.mapName   = packet.mapName   !== undefined ? packet.mapName   : null;
  game.mapAuthor = packet.mapAuthor !== undefined ? packet.mapAuthor : null;

  game.switches = packet.switches || {};
  game.portals  = packet.portals  || {};

  // Leader-set per-tile physics overrides ride along on 'joined'/'mapChanged'
  // (server/roomRegistry.js) so a late joiner or a reconnecting client
  // predicts with the same values the server simulates with, instead of
  // room defaults until the leader happens to re-touch the tile.
  settingsState.tileOverrides = packet.tileOverrides || {};

  // Authored spawn discs - editor-only data, but seeded here so the editor
  // page gets them from the same 'joined'/'mapChanged' payload as the map.
  game.spawnPoints = packet.spawnPoints || {};

  game.mapOverlayStrokes  = packet.mapOverlayStrokes || [];
  game.tileOverlayStrokes = packet.tileOverlayStrokes || {};

  game.dataMap = game.map.map(function (row) {
    return row.map(function (id) { return { id: id, sprite: null, backgroundSprite: null }; });
  });
}

var packetApplier = {

  // Called directly by app/bootstrap.js, not through packetRouter - see
  // header comment.
  applyJoined: async function (packet) {
    game.myId     = packet.inGame ? packet.id : null;
    game.clientId = packet.id !== undefined ? packet.id : null;
    game.leaderId = packet.leaderId !== undefined ? packet.leaderId : null;
    game.roomKind = packet.roomKind || 'game';

    appEvents.emit('spectating:changed', !packet.inGame);

    settingsState.setSettingsSchema(packet);
    var overrides = packet.playerOverrides || {};
    for (var playerId in overrides) settingsState.setPlayerOverrides(Number(playerId), overrides[playerId]);
    game.pendingPupPreviews = packet.pupPreviews || [];

    seedMapState(packet);

    // Custom tiles placed on the map still need their draw metadata and
    // art registered, even though the client can no longer author them.
    // Room-scoped, not map-scoped (game/gameInstance.js physicsLookup
    // survives a map change) - only seeded here, on join, never touched by
    // the mapChanged handler below.
    for (var ct = 0; ct < (packet.customTiles || []).length; ct++) {
      renderer.applyCustomTileDef(packet.customTiles[ct]);
    }

    // Chunked (not the plain buildWalls/buildSpikes a live wall edit uses
    // below in scheduleWallRedraw) - this is the full-map pass at boot,
    // the same "don't build ~1000+ Box2D bodies in one synchronous block"
    // reasoning as engine/gameInstance.js's createMapChunked.
    await physicsWorld.buildWallsAndSpikesChunked(game.wallMap, game.map, 40);

    if (packet.physics) settingsState.setPhysicsSettings(packet.physics);

    settingsState.setMatchInfo({
      state:          packet.matchState,
      settings:       packet.matchSettings,
      scores:         packet.scores,
      stepCount:      packet.stepCount,
      phaseStartStep: packet.phaseStartStep,
    });

    appEvents.emit('leader:changed');
    appEvents.emit('map:changed', packet);
  },

  snapshot: function (packet) {
    for (var i = 0; i < packet.updated.length; i++) {
      applySnapshotEntity(packet.updated[i]);
    }
    var removed = packet.removed || [];
    for (var j = 0; j < removed.length; j++) {
      if (removed[j] !== game.myId) removePlayerLocal(removed[j]);
    }
  },

  // A player's first 'input' packet can legitimately arrive before their
  // first 'snapshot' entity creates them locally (input is broadcast the
  // instant a key changes; position only goes out on the ~250ms snapshot
  // cadence or a discrete event) - live, the race window is small enough
  // to rarely matter, but a recorded replay reproduces the exact original
  // packet order every time, so if it happened once during recording it
  // happens on every playback. Dropping it silently left that player
  // stuck at left/right/up/down: false (createPlayer's default) until
  // their NEXT real input change - which, since movement.js locally
  // predicts every player's motion from these flags every frame, looked
  // like the ball only moving during each ~250ms position correction and
  // sitting still in between (see pendingInputFlush below for the other
  // half of this fix).
  input: function (packet) {
    var player = getPlayer(packet.id);
    var flags  = { left: !!packet.left, right: !!packet.right, up: !!packet.up, down: !!packet.down };
    if (!player) {
      pendingInput[packet.id] = flags;
      return;
    }
    player.left  = flags.left;
    player.right = flags.right;
    player.up    = flags.up;
    player.down  = flags.down;
  },

  setTile: function (packet) {
    var row      = game.map[packet.y];
    var inBounds = row !== undefined && row[packet.x] !== undefined;
    var wasSpike = inBounds && row[packet.x] === 7;
    if (inBounds) row[packet.x] = packet.id;

    var isWallId  = tileCatalog.isWallTile(packet.id);
    var oldWallId = inBounds ? game.wallMap[packet.y][packet.x] : 0;
    if (inBounds && (isWallId || oldWallId)) {
      game.wallMap[packet.y][packet.x] = isWallId ? packet.id : 0;
      var entry = game.dataMap[packet.y][packet.x];
      if (entry) entry.id = packet.id;
      scheduleWallRedraw();
      appEvents.emit('tile:changed', packet.x, packet.y);
      return;
    }

    renderer.changeTile(packet.x, packet.y, packet.id);

    if (wasSpike || packet.id === 7) {
      physicsWorld.buildWalls(game.wallMap);
      physicsWorld.buildSpikes(game.map);
    }

    appEvents.emit('tile:changed', packet.x, packet.y);
  },

  connections: function (packet) {
    game.switches = packet.switches || {};
    game.portals  = packet.portals  || {};
    appEvents.emit('connections:changed');
  },

  joinedGame: function (packet) {
    game.myId = packet.player.id;
    appEvents.emit('spectating:changed', false);
  },

  leftGame: function () {
    if (game.myId !== null) removePlayerLocal(game.myId);
    game.myId = null;
    appEvents.emit('spectating:changed', true);
  },

  roomState: function (packet) {
    appEvents.emit('roster:changed', packet.players);
    for (var k = 0; k < packet.players.length; k++) {
      var entry = packet.players[k];
      if (!entry.inGame) removePlayerLocal(entry.id);
    }
  },

  leaderChanged: function (packet) {
    game.leaderId = packet.leaderId;
    appEvents.emit('leader:changed');
  },

  matchState: function (packet) {
    settingsState.setMatchInfo(packet);
  },

  matchEnd: function (packet) {
    appEvents.emit('matchEnd', packet);
  },

  physicsChanged: function (packet) {
    settingsState.setPhysicsSettings(packet.settings);
    if (packet.wells) {
      game.wells = packet.wells;
      // The packet carries wells so a radius/strength change reaches client
      // prediction; the drawn pull radius is read off the same list, so it
      // has to be re-drawn here or it keeps showing the old size.
      renderer.refreshWellCircles();
    }
  },

  playerPhysicsChanged: function (packet) {
    settingsState.setPlayerOverrides(packet.playerId, packet.settings);

    var player = getPlayer(packet.playerId);
    if (!player || !player.body) return;
    var friction = settingsState.playerSetting(packet.playerId, 'playerFriction');
    var linear   = settingsState.playerSetting(packet.playerId, 'linearDamping');
    var angular  = settingsState.playerSetting(packet.playerId, 'angularDamping');
    physicsWorld.setFriction(player.body, friction);
    physicsWorld.setDamping(player.body, linear, angular);
  },

  tileSettingsChanged: function (packet) {
    settingsState.setTileOverrides(packet.x, packet.y, packet.settings);
    // Not display-only: per-tile wallFriction/wallRestitution must reach
    // the prediction bodies or the ball bounces differently than the
    // server says.
    physicsWorld.applyWallSettings();
  },

  overlayStroke: function (packet) {
    overlayStrokeLog(packet.target).push(packet.stroke);
    renderer.drawOverlayStroke(packet.target, packet.stroke);
  },

  overlayUndo: function (packet) {
    overlayStrokeLog(packet.target).pop();
    renderer.redrawOverlay(packet.target);
  },

  overlayClear: function (packet) {
    if (packet.target === 'map') {
      game.mapOverlayStrokes = [];
    } else {
      delete game.tileOverlayStrokes[packet.target.x + ',' + packet.target.y];
    }
    renderer.redrawOverlay(packet.target);
  },

  kicked: function () {
    appEvents.emit('kicked');
  },

  score: function (packet) {
    appEvents.emit('score:changed', packet.data);
  },

  mapChanged: function (packet) {
    seedMapState(packet);

    physicsWorld.buildWalls(game.wallMap);
    physicsWorld.buildSpikes(game.map);
    renderer.createMap();
    spriteSheetLoader.refetch();
    appEvents.emit('connections:changed');
    appEvents.emit('map:changed', packet);

    while (game.players.length) removePlayerLocal(game.players[0].id);
    game.myId = null;
  },

  team: function (packet) {
    appEvents.emit('team:changed', packet.team);
  },

  error: function (packet) {
    appEvents.emit('error', packet.message);
  },

  chat: function (packet) {
    appEvents.emit('chat:message', packet.name, packet.text);
  },

  // Reply to actions.ping() (see net/packetSchema.js) - packet.t is this
  // client's own clock, so the round trip time is just "now minus that".
  pong: function (packet) {
    appEvents.emit('ping:measured', Date.now() - packet.t);
  },

  powerupPreview: function (packet) {
    renderer.setPupPreview(packet.x, packet.y, packet.previewId);
  },

  // Only the collecting client gets this - schedule rolling bomb's warning
  // particles to start shortly before it detonates.
  powerupCollected: function (packet) {
    if (packet.key !== 'rb') return;
    var player = game.myId !== null ? getPlayer(game.myId) : null;
    if (!player) return;

    clearTimeout(player.rollingBombParticleTimer);
    renderer.setBombParticles(player.id, false); // re-pickup restarts the countdown

    var delay = Math.max(0, packet.timerMs - ROLLING_BOMB_PARTICLE_LEAD_MS);
    player.rollingBombParticleTimer = setTimeout(function () {
      renderer.setBombParticles(player.id, true);
    }, delay);
  },

  // The server broadcasts this on every flag capture, but nothing ever
  // consumed it (dead packet, confirmed by the texture-system bug hunt).
  // Wiring it to a log line rather than leaving the gap silent again -
  // ui/hud.js can build a real capture flash/banner off this event later
  // without another protocol change.
  spawnPointsChanged: function (packet) {
    game.spawnPoints = packet.spawnPoints || {};
    appEvents.emit('spawnPoints:changed');
  },

  capture: function (packet) {
    appEvents.emit('capture', packet.data);
  },

  // Tile creator (server/db.js custom_tiles): one tile created/edited/
  // re-uploaded. The client can't author these any more, but it still has
  // to render one when the server says a map cell now holds it.
  customTileUpsert: function (packet) {
    renderer.applyCustomTileDef(packet.tile);
  },

  customTileCatalog: function (packet) {
    for (var i = 0; i < packet.tiles.length; i++) renderer.applyCustomTileDef(packet.tiles[i]);
  },

  // A leader deleted a custom tile. Cells already painted with it keep
  // rendering their last texture until repainted (registerCustomTile's own
  // "orphaned tile" design - see game/gameInstance.js) - this just drops the
  // now-stale render metadata/texture so it can't be confused with a future
  // tile that reuses the id.
  customTileDeleted: function (packet) {
    renderer.removeCustomTileDef(packet.id);
  },
};

// applyEntity (gameState.js) only updates non-physics fields and emits
// flag-change events; position/velocity reconciliation needs the physics
// body, so it's a separate call into simulation/entityReconciler.js. Kept
// as one helper so 'snapshot' reads as a single step per entity.
function applySnapshotEntity(entity) {
  var player = getPlayer(entity.id);
  if (!player) {
    createPlayer(entity); // also applies flags for the initial state
    return;
  }
  applyEntity(entity); // non-physics fields + flag-change events
  entityReconciler.reconcilePlayerPosition(player, entity);
}
