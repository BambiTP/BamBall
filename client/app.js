// app.js - the app bootstrap/wiring layer: a small cross-cutting event bus,
// the "user/UI intent -> typed outgoing packet" layer, the default sprite
// sheet loader, incoming-packet application (state/simulation/render), and
// binding state changes to their simulation/render consequences. Five
// files that used to be split across app/appEvents.js, app/actions.js,
// app/spriteSheetLoader.js, app/packetApplier.js, app/stateWiring.js - one
// file since they're all "the glue between transport, state, and the rest
// of the client" and read each other constantly.

// ---- appEvents: cross-cutting event bus ------------------------------------
//
// For signals that don't belong to one specific state module (menu
// toggling, chat focus requests, debug-log lines, edit-mode player-
// selection toggles). input/render emit on this; ui/ subscribes. Keeps
// input/render from importing ui/ directly just to flip a DOM panel open.

var appEvents = createEventBus();

// ---- actions: user/UI intent -> typed outgoing packet ----------------------
//
// Every button handler, keybind, and tool in ui/ and input/ calls a
// function here instead of building a packet object and calling
// socket.send itself - this is the client-side counterpart to the server's
// single packetBuilders.js, which the client never had (every UI call site
// used to hand-assemble its own JSON, duplicating the same packet's shape
// across dozens of places).

var actions = {
  joinTeam: function (team) {
    if (team === 'red')  return socket.send(packetSchema.joinRed());
    if (team === 'blue') return socket.send(packetSchema.joinBlue());
    return socket.send(packetSchema.joinSpectator());
  },
  joinGame:  function () { socket.send(packetSchema.joinGame()); },
  leaveGame: function () { socket.send(packetSchema.leaveGame()); },

  // target: 'all' | 'team' - see client/inputs.js's teamChat keybind.
  chat: function (text, target) { socket.send(packetSchema.chat(text, target)); },

  // Live flair change - re-sends the same 'identify' packet type a fresh
  // join uses (see local/hostSession.js's handleOutgoing), just with only
  // flairIndex set, so it applies immediately without needing to leave and
  // rejoin. Called by local/flairPicker.js whenever already connected.
  setFlair: function (flairIndex) { socket.send(packetSchema.setFlair(flairIndex)); },

  ping: function () { socket.send(packetSchema.ping()); },

  sendInput: function (left, right, up, down) {
    socket.send(packetSchema.input(left, right, up, down));
  },

  detonateBomb: function () { socket.send(packetSchema.detonateBomb()); },
  throwEgg:     function (dirX, dirY) { socket.send(packetSchema.throwEgg(dirX, dirY)); },

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

  updateProfile: function (profile, bundle) {
    socket.send(packetSchema.updateProfile(profile, bundle));
  },

  // Debug console only - an explicit, clearly-labeled escape hatch that
  // bypasses packetSchema entirely, rather than sharing a code path with
  // every typed action above.
  sendRaw: function (packet) { socket.send(packet); },
};

// ---- spriteSheetLoader: default packed sprite sheet ------------------------
//
// Static-build replacement for the original's POST /api/spritesheet call
// (server/api/spritesheet.js, no server here). Points at the one default
// packed sheet baked ahead of time (assets/sprites/default.png +
// default.json, via the unmodified server/assets/buildSpriteSheet.js, run
// as a one-off script) instead of building one per-account on demand.
// Custom/local texture packs (see the plan's texture-pack-picker section)
// swap this out per pick; until that lands every player sees the same
// default pack.

var spriteSheetLoader = {
  loadedHash: 'default',

  fetch: function () {
    return Promise.resolve({
      hash: 'default',
      sheetUrl: GAME_BASE_PATH + 'assets/sprites/default.png',
      manifestUrl: GAME_BASE_PATH + 'assets/sprites/default.json',
      wallsUrl: GAME_BASE_PATH + 'assets/sprites/walls/classic.png',
    });
  },

  refetch: function () {
    // No per-account state to change yet in this build - see task #8
    // (texture pack picker network-call adaptation) for local/IndexedDB
    // pack switching, which will make this a real refresh again.
    return Promise.resolve(null);
  },
};

// ---- packetApplier: incoming packet -> state/simulation/render -------------
//
// Applies one incoming packet to state/simulation/render. This is the
// client-side counterpart to the old packetHandlers.js, but split from
// transport (client/net.js only dispatches) and never touches the DOM
// directly - UI-visible effects (status text, chat log, roster refresh) go
// through appEvents; ui/ subscribes and renders them. App bootstrap
// registers every handler below onto packetRouter once, at startup.
//
// 'joined' is deliberately NOT registered through the normal per-type
// table - it needs two-phase handling (seed state now, boot renderer/
// physics/sprites after an async fetch), so bootstrap calls applyJoined
// directly instead of going through packetRouter for it.

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
  game.mapSource = packet.mapSource !== undefined ? packet.mapSource : null;
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

  game.dataMap = game.map.map(function (row) {
    return row.map(function (id) { return { id: id, sprite: null, backgroundSprite: null }; });
  });
}

var packetApplier = {

  // Called directly by app bootstrap, not through packetRouter - see
  // header comment.
  applyJoined: function (packet) {
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

    physicsWorld.buildWalls(game.wallMap);
    physicsWorld.buildSpikes(game.map);

    if (packet.physics) settingsState.setPhysicsSettings(packet.physics);

    settingsState.setMatchInfo({
      state:          packet.matchState,
      settings:       packet.matchSettings,
      scores:         packet.scores,
      stepCount:      packet.stepCount,
      phaseStartStep: packet.phaseStartStep,
    });

    if (packet.eggball) game.eggball = packet.eggball;
    if (packet.profiles) game.profiles = packet.profiles;

    appEvents.emit('leader:changed');
    appEvents.emit('map:changed', packet);
    appEvents.emit('profiles:changed', game.profiles);
  },

  snapshot: function (packet) {
    for (var i = 0; i < packet.updated.length; i++) {
      applySnapshotEntity(packet.updated[i], packet.immediate);
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
    game.roster = packet.players;
    var mainLeader = packet.players.find(function (p) { return p.mainLeader; });
    game.leaderId = mainLeader ? mainLeader.id : null;
    appEvents.emit('roster:changed', packet.players);
    for (var k = 0; k < packet.players.length; k++) {
      var entry = packet.players[k];
      if (!entry.inGame) removePlayerLocal(entry.id);
    }
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

  saveStatesChanged: function (packet) {
    game.saveStateNames = packet.names || [];
    appEvents.emit('saveStates:changed', game.saveStateNames);
  },

  profilesChanged: function (packet) {
    game.profiles = packet.profiles;
    appEvents.emit('profiles:changed', game.profiles);
  },

  // Room-wide, not per-viewer culled - see engine/packetBuilders.js's
  // eggballChanged for why. Fires on every state change (spawn/throw/
  // catch) and every tick while free-flying, so this is intentionally just
  // a store-and-redraw with no interpolation of its own yet - client/
  // render/eggballRenderer.js draws straight from game.eggball each frame.
  eggballChanged: function (packet) {
    game.eggball = { carrierId: packet.carrierId, x: packet.x, y: packet.y, vx: packet.vx, vy: packet.vy };
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

  // Hands the whole packet through (name/text plus target/team/authed/
  // leader) - client/ui/hud.js's appendChatMessage does the actual
  // tagpro-style color-coding, this is pure routing.
  chat: function (packet) {
    appEvents.emit('chat:message', packet);
  },

  // Gets back to a clean mode-select screen once the connection this
  // packet arrived on is about to close (the host closes it right after
  // sending this, see webrtcTransport.js's kickClient) - same "return to
  // fresh start" the Leave Group button already uses (local/joinUI.js).
  // Nothing survives a reload on its own, so the reason rides along in
  // sessionStorage for main.js's mode-select screen to pick up and show.
  kicked: function (packet) {
    try { sessionStorage.setItem('bamball_kicked_reason', packet.message || 'You were removed from the room.'); } catch (err) {}
    location.reload();
  },

  // Reply to actions.ping() (see client/net.js) - packet.t is this
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
};

// applyEntity (client/state.js) only updates non-physics fields and emits
// flag-change events; position/velocity reconciliation needs the physics
// body, so it's a separate call into simulation/entityReconciler.js. Kept
// as one helper so 'snapshot' reads as a single step per entity.
function applySnapshotEntity(entity, immediate) {
  var player = getPlayer(entity.id);
  if (!player) {
    createPlayer(entity); // also applies flags for the initial state
    return;
  }
  applyEntity(entity); // non-physics fields + flag-change events
  entityReconciler.reconcilePlayerPosition(player, entity, immediate, entity.id === game.myId);
}

// ---- stateWiring: state changes -> simulation/render consequences ---------
//
// A player appearing needs a physics body and a sprite, a physics setting
// changing needs pushing onto every live body, and so on.
//
// Shared by the game page and the map editor. Both run the same engine and
// the same renderer, so both need exactly this wiring; it used to live in
// client/game/app/bootstrap.js, which the editor can't load (that file also
// owns the game page's own boot sequence and globals).

function wireGameStateEvents() {
  gameEvents.on('player:created', function (player, entity) {
    player.body = physicsWorld.createBall(entity.x, entity.y);
    player.body.SetUserData(player); // player.isPlayer=true lets the contact listener spot it vs. a wall body
    // A player who is already dead when first seen (joining mid-respawn) is
    // frozen server-side, so its snapshot velocity is stale - same reasoning
    // as the deadChanged handler below.
    physicsWorld.setVelocity(player.body, player.dead ? 0 : player.lx, player.dead ? 0 : player.ly);
    physicsWorld.setSensor(player.body, player.dead);
    renderer.drawPlayer(player.id);

    // A per-player friction/damping override that arrived (on 'joined', or
    // a live playerPhysicsChanged) before this player's first snapshot
    // needs to be pushed onto the body right now.
    if (settingsState.playerOverrides[player.id]) {
      physicsWorld.setFriction(player.body, settingsState.playerSetting(player.id, 'playerFriction'));
      physicsWorld.setDamping(player.body,
        settingsState.playerSetting(player.id, 'linearDamping'),
        settingsState.playerSetting(player.id, 'angularDamping'));
    }
  });

  gameEvents.on('player:removed', function (player) {
    physicsWorld.destroyBody(player.body);
    clearTimeout(player.rollingBombParticleTimer);
    renderer.clearPupAuras(player.id);
    // .destroyed guard: a map change destroys the whole scene graph (including
    // every player container) and only then drops the players, so by the time
    // this runs the container may already be gone - and a second destroy()
    // throws in Pixi v8.
    if (player.container && !player.container.destroyed) player.container.destroy({ children: true });
  });

  gameEvents.on('player:deadChanged', function (player, wasDead) {
    physicsWorld.setSensor(player.body, player.dead);

    // Mirrors the server's freezePlayer (game/physicsHelpers.js), which
    // zeroes velocity as well as setting the sensor flag. Only the sensor
    // half was mirrored here, so a ball that died carrying speed - which is
    // most of them, since it just took a hit and a death explosion - kept
    // coasting on the client while the server had it stopped dead at the
    // pop position. As a sensor it coasted straight through walls, then got
    // dragged back by the next snapshot, then coasted again: the glitching
    // around on death. The client already skips input for dead players
    // (simulation/movement.js), so this is the last thing still moving them.
    if (player.dead) physicsWorld.setVelocity(player.body, 0, 0);

    if (player.container) player.container.alpha = player.dead ? 0.3 : 1;
    if (player.dead && !wasDead) {
      renderer.spawnBurst(player.x, player.y, player.team === 'blue' ? 0x3388ff : 0xff4433, 18);
    }

    // Mirrors the server's respawnPlayer resetting jumpsRemaining - a
    // respawn is a dead stop, jump charges included, not whatever was left
    // over from however they died.
    if (!player.dead && wasDead) {
      player.jumpsRemaining = physConfig.jumpCharges;
      player.wasUp = false;
    }
  });

  gameEvents.on('player:flagChanged', function (player) {
    if (player.hasFlag) renderer.attachFlag(player.id, player.flagId);
    else renderer.detachFlag(player.id);
  });

  // Someone already on screen picked a different flair mid-life (local/
  // flairPicker.js's live update) - initial flair for a freshly-created
  // player is drawn straight from player.flairIndex by drawPlayer itself,
  // so this only ever fires for an in-place change.
  gameEvents.on('player:flairChanged', function (player) {
    renderer.updatePlayerFlair(player.id);
  });

  gameEvents.on('player:jukeJuiceChanged', function (player) {
    renderer.setPupIcon(player.id, 'jj', 6.1, player.jukeJuice);
  });

  gameEvents.on('player:rollingBombChanged', function (player) {
    renderer.setPupIcon(player.id, 'rb', 6.2, player.rollingBomb);
    renderer.setPupAura(player.id, 'rb', player.rollingBomb);
    if (!player.rollingBomb) clearTimeout(player.rollingBombParticleTimer);
  });

  gameEvents.on('player:tagproChanged', function (player) {
    renderer.setPupIcon(player.id, 'tp', 6.3, player.tagpro);
    renderer.setPupAura(player.id, 'tp', player.tagpro);
  });

  gameEvents.on('player:kothLeaderChanged', function (player) {
    renderer.setKothLeader(player.id, player.kothLeader && game.kothPowerup);
  });
}

function wireSettingsStateEvents() {
  settingsEvents.on('physics:changed', function (settings) {
    // physConfig (simulation/physicsWorld.js) holds the defaults used for
    // brand-new bodies (ball creation) - keep it in
    // sync with the authoritative settingsState.physics copy.
    Object.assign(physConfig, settings);

    if (settings.gravityX !== undefined || settings.gravityY !== undefined) {
      physicsWorld.setGravity(settingsState.physics.gravityX, settingsState.physics.gravityY);
    }

    if (settings.playerFriction !== undefined) {
      for (var i = 0; i < game.players.length; i++) {
        if (game.players[i].body) physicsWorld.setFriction(game.players[i].body, settingsState.physics.playerFriction);
      }
    }

    if (settings.wallRestitution !== undefined || settings.wallFriction !== undefined) {
      physicsWorld.applyWallSettings();
    }

    if (settings.linearDamping !== undefined || settings.angularDamping !== undefined) {
      for (var j = 0; j < game.players.length; j++) {
        if (game.players[j].body) {
          physicsWorld.setDamping(game.players[j].body, settingsState.physics.linearDamping, settingsState.physics.angularDamping);
        }
      }
    }

    if (settings.kothPowerup !== undefined) {
      game.kothPowerup = settings.kothPowerup;
      if (!game.kothPowerup) {
        for (var k = 0; k < game.players.length; k++) {
          var p = game.players[k];
          if (p.kothLeader) {
            p.kothLeader = false;
            renderer.setKothLeader(p.id, false);
          }
        }
      }
    }
  });

  settingsEvents.on('tileOverrides:changed', function () {
    // Per-tile wallFriction/wallRestitution must reach the prediction
    // bodies too, not just display - handled directly in
    // packetApplier.tileSettingsChanged since it has the specific packet;
    // nothing additional needed here.
  });
}

function wireLocalSettingsEvents() {
  rebuildKeyLookup();
  localSettingsEvents.on('localSettings:changed', rebuildKeyLookup);
}
