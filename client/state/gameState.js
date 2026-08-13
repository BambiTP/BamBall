// gameState.js - players/map as plain data, plus non-physics
// entity fields (name, team, dead, hasFlag, powerup flags). Never imports
// Pixi, Box2D, or the DOM, and never calls render/simulation functions
// directly - it emits events on gameEvents instead, which app/bootstrap.js
// wires to render/ and simulation/ once at startup. Position/velocity
// reconciliation (which does need the physics body) lives in
// simulation/entityReconciler.js, not here.

var gameEvents = createEventBus();

var game = {
  players: [],
  map:     [],
  wallMap: [],
  wells:   [],
  dataMap: [],

  myId:     null, // player id, set only while spawned in the game
  clientId: null, // this connection's client id, set on 'joined'
  leaderId: null, // the room's current leader client id

  mapId:     null,
  mapName:   null,
  mapAuthor: null,

  // "x,y" -> { timer, toggle: [{ pos: {x,y} }] } / "x,y" -> { destination, cooldown }.
  // The server's canonical wiring structures, sent whole and replaced whole.
  switches: {},
  portals:  {},

  // 'game' or 'editor', from the server on 'joined'. An editor room has no
  // match and lets anyone edit; shared code checks this rather than asking
  // the editor page, which the game page doesn't load.
  roomKind: 'game',

  // Authored spawn discs, { red: [{x,y,radius,weight}], blue: [...] }.
  // Editor-only: the game page never reads these (spawning is server-side),
  // but they ride along on 'joined'/'mapChanged' so the editor can draw and
  // edit them.
  spawnPoints: {},

  // Paint-mode drawing overlay stroke logs (§1.13 of the rewrite guide) -
  // mirrors the server's authoritative log.
  mapOverlayStrokes:  [],
  tileOverlayStrokes: {},

  // Which players the leader has selected (per-player settings panel) -
  // local only, never sent to the server.
  selectedPlayerIds: [],

  // Spectator camera follow target - local only.
  spectateFollowId:    null,
  spectateCameraReady: false,

  // Room-wide KOTH toggle, kept in sync from settingsState so a stale KOTH
  // dot can't survive the leader turning the mode off.
  kothPowerup: false,
};

function teamFromCode(t) {
  return t === 2 ? 'blue' : 'red';
}

function getPlayer(id) {
  return game.players.find(function (p) { return p.id === id; }) || null;
}

// entity: the (possibly partial) wire-format snapshot fields. Builds the
// plain-data player record and emits 'player:created' so a listener can
// attach a physics body + sprite - see simulation/ and render/ wiring in
// app/bootstrap.js. applyEntityFlags below then emits the granular flag
// events for a fresh entity's initial state (dead/flag/powerups).
function createPlayer(entity) {
  var player = {
    id:   entity.id,
    name: entity.n || ('Player ' + entity.id),
    authed: !!entity.au, // true only once the host has verified their TagPro login token - see webrtcTransport.js's handleOutgoingFor 'identify' case
    team: teamFromCode(entity.t),

    x: entity.x, y: entity.y,
    lx: entity.lx || 0, ly: entity.ly || 0,
    a: entity.a || 0,

    left: false, right: false, up: false, down: false,

    maxSpeed: entity.ms,
    accel:    entity.ac,

    dead:      !!entity.d,
    hasFlag:   !!entity.f,
    flagId:    entity.f || null,
    jukeJuice:   false,
    rollingBomb: false,
    tagpro:      false,
    kothLeader:  false,
    matchFrozen: false,
    snapCount: entity.s || 0,
    sync:      null, // simulation/entityReconciler.js owns this

    body:      null, // filled in by the simulation listener on player:created
    container: null, // filled in by the render listener on player:created
  };

  game.players.push(player);
  gameEvents.emit('player:created', player, entity);
  applyEntityFlags(player, entity);

  return player;
}

function removePlayerLocal(id) {
  var index = game.players.findIndex(function (p) { return p.id === id; });
  if (index === -1) return;

  var player = game.players[index];
  // Emit before splicing: render/playerRenderer.js's clearPupAuras (and any
  // other 'player:removed' listener) looks the player back up by id via
  // getPlayer(), which searches game.players - spliced first, that lookup
  // silently returns null and the listener no-ops instead of cleaning up.
  gameEvents.emit('player:removed', player);
  game.players.splice(index, 1);
}

// Applies every field present on entity EXCEPT position/velocity (that's
// simulation/entityReconciler.js's job, since it needs the physics body).
// Called for both a freshly-created player (createPlayer above) and an
// update to an existing one (applyEntity below).
function applyEntityFlags(player, entity) {
  if (entity.n !== undefined) player.name = entity.n;
  if (entity.au !== undefined) player.authed = !!entity.au;
  if (entity.t !== undefined) player.team = teamFromCode(entity.t);
  if (entity.ac !== undefined) player.accel = entity.ac;
  if (entity.ms !== undefined) player.maxSpeed = entity.ms;

  if (entity.d !== undefined) {
    var wasDead = player.dead;
    player.dead = !!entity.d;
    gameEvents.emit('player:deadChanged', player, wasDead);
  }

  if (entity.f !== undefined) {
    player.hasFlag = !!entity.f;
    player.flagId  = entity.f || null;
    gameEvents.emit('player:flagChanged', player);
  }

  if (entity.jj !== undefined) {
    player.jukeJuice = !!entity.jj;
    gameEvents.emit('player:jukeJuiceChanged', player);
  }

  if (entity.rb !== undefined) {
    var wasRollingBomb = player.rollingBomb;
    player.rollingBomb = !!entity.rb;
    gameEvents.emit('player:rollingBombChanged', player, wasRollingBomb);
  }

  if (entity.tp !== undefined) {
    player.tagpro = !!entity.tp;
    gameEvents.emit('player:tagproChanged', player);
  }

  if (entity.kl !== undefined) {
    player.kothLeader = !!entity.kl;
    gameEvents.emit('player:kothLeaderChanged', player);
  }

  // Per-player freeze (pregame countdown, eggball post-score kickoff) - the
  // server already honors this in physicsHelpers.movePlayers, but until now
  // it was never serialized, so local prediction (simulation/movement.js)
  // kept moving a frozen player from held input keys during the freeze.
  if (entity.mf !== undefined) player.matchFrozen = !!entity.mf;
}

// entity: a snapshot delta for an existing player - see net/packetRouter.js
// 'snapshot' wiring in app/, which calls this for the non-physics fields and
// simulation/entityReconciler.js for x/y/a/lx/ly/snapCount.
function applyEntity(entity) {
  var player = getPlayer(entity.id);
  if (!player) {
    createPlayer(entity);
    return player;
  }
  applyEntityFlags(player, entity);
  return player;
}

// The stroke log an overlay target ('map' or {x,y}) addresses, creating a
// cell's list on first use - shared by the local pen tool and the
// overlayStroke broadcast handler so both append to the same array.
function overlayStrokeLog(target) {
  if (target === 'map') return game.mapOverlayStrokes;
  var key = target.x + ',' + target.y;
  if (!game.tileOverlayStrokes[key]) game.tileOverlayStrokes[key] = [];
  return game.tileOverlayStrokes[key];
}
