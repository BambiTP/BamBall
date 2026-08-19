(function () {
// Isomorphic: require() in Node, or the matching <script>-loaded global in
// a browser (web/index.html loads every engine/ file in dependency order).
var createEventBus  = (typeof require === 'function') ? require('./eventBus').createEventBus : globalThis.createEventBus;
var PhysicsWorld  = (typeof require === 'function') ? require('./physicsWorld') : globalThis.PhysicsWorld;
var GameState     = (typeof require === 'function') ? require('./gameState') : globalThis.GameState;
var physicsData   = (typeof require === 'function') ? require('./tiles/physicsData') : globalThis.PhysicsData;
const { TILE_ID }   = physicsData;
var createPhysicsHelpers = (typeof require === 'function') ? require('./physicsHelpers') : globalThis.createPhysicsHelpers;
var Gravity = (typeof require === 'function') ? require('./gravity') : globalThis.Gravity;
var createGameHelpers    = (typeof require === 'function') ? require('./gameHelpers') : globalThis.createGameHelpers;
var createSnapshotFactory = (typeof require === 'function') ? require('./snapshotFactory') : globalThis.createSnapshotFactory;
var setupTileLogic       = (typeof require === 'function') ? require('./tiles/tileLogic') : globalThis.setupTileLogic;
var mapFormat = (typeof require === 'function') ? require('./tiles/mapFormat') : globalThis.MapFormat;
var createMatchManager   = (typeof require === 'function') ? require('./matchManager') : globalThis.createMatchManager;
var createMapWiring      = (typeof require === 'function') ? require('./mapWiring') : globalThis.createMapWiring;

class GameInstance {
  // mode: 'game' or 'editor' (see GameState). Set once at construction -
  // a room doesn't change what kind it is.
  constructor(config, mode = 'game') {
    const self = this;

    this.config  = config;
    this.mode    = mode;
    // Local build: game/'s emitter only ever used via .on(event, fn)/.emit(event, ...args)
    // (grepped, no .once/.removeListener/.emit('error', ...) anywhere) - createEventBus's
    // .on/.emit-only factory is a drop-in swap for Node's EventEmitter here.
    this.emitter = createEventBus();

    this.physicsLookup = {};
    for (const t of physicsData) {
      this.physicsLookup[t.id] = t;
    }

    this.gameState     = new GameState(mode);
    this.physicsWorld  = new PhysicsWorld(config, this.emitter);
    this.physicsHelpers = createPhysicsHelpers(this.physicsWorld, this.gameState, config);
    this.gravityLogic   = Gravity.createGravityLogic(this.gameState, this.physicsWorld, config);
    this.gameHelpers    = createGameHelpers(this.gameState, this.physicsHelpers, this.physicsWorld, config, this.emitter);
    this.snapshotFactory = createSnapshotFactory(this.gameState, config);
    this.matchManager   = createMatchManager(this.gameState, this.gameHelpers, this.physicsWorld, config, this.emitter, this.physicsLookup);
    this.mapWiring      = createMapWiring(this.gameState, this.gameHelpers, this.physicsLookup, this.emitter);
    setupTileLogic(this);

    this.emitter.on('setTile', function (x, y, id) {
      self.setTile(x, y, id);
    });

    this.emitter.on('update', function (target) {
      const players = Array.isArray(target) ? target : [target];
      for (const player of players) {
        if (player && player.body) self.physicsHelpers.syncPlayer(player);
      }
      self.pushSnapshotsFor(target);
    });

    // physicsWorld.js's contact listener fires from inside Box2D's own
    // Step() - mutating bodies there (catchEggball destroys the egg's) is
    // forbidden and has previously crashed a whole room from inside
    // SolveTOI, same issue tiles/tileHandlers.js's afterStep works around
    // for player-vs-player pops. Deferring to a microtask lets the step
    // finish resolving the collision first.
    this.emitter.on('eggballContact', function (egg, other) {
      Promise.resolve().then(function () {
        if (other.isPlayer) self.gameHelpers.catchEggball(other);
        else self.gameHelpers.recordEggballWallBounce();
      }).catch(function (err) {
        console.error('[gameInstance] deferred eggball contact failed:', err);
      });
    });

    this.timeStep    = 1 / 60;
    this.running     = false;
    this.accumulator = 0;
    this.lastTime    = 0;
    this.snapshotTimer = null;
  }

  // doc is a resolved mapFormat document; ref is where it came from
  // (server/mapSource.js), kept only so clients can display/reuse it. The
  // engine never fetches a map itself - a stored map and one imported from
  // Fortunate Maps arrive here identically.
  loadMap(doc, ref = null) {
    this._seedMapState(doc, ref);
    this.createMap();
    this._afterCreateMap(doc);
  }

  _seedMapState(doc, ref) {
    const mapData = mapFormat.toRuntime(doc);
    this.gameState.map      = mapData.map;
    this.gameState.wallMap  = mapData.wallMap;
    this.gameState.spawnPool = mapData.spawnPool;
    this.gameState.mapId     = ref ? ref.id : null;
    this.gameState.mapSource = ref ? ref.type : null;
    this.gameState.mapName   = mapData.name;
    this.gameState.mapAuthor = mapData.author;

    // Authored (not derived) map data - carried through untouched so
    // toDocument() below can rebuild exactly what was loaded, plus whatever
    // an editor room has changed since.
    this.gameState.spawnPoints = doc.spawnPoints ?? {};
    this.gameState.fields      = doc.fields ?? {};

    // Bare positions from the map become full field definitions here, using
    // whatever the current group physics settings are (leader-tunable like
    // any other config field).
    this.gameState.wells = mapData.wells.map(pos => ({
      x: pos.x,
      y: pos.y,
      radius:   this.config.gravityWellRadius,
      strength: this.config.gravityWellStrength,
      falloff:  this.config.gravityWellFalloff,
      mode:     this.config.gravityWellMode,
    }));

    // Pristine copy of the freshly loaded map. Gameplay mutates
    // gameState.map in place (flags taken, boosts used, gates toggled);
    // match start/reset diffs against this to restore every tile.
    this.gameState.initialMap = mapData.map.map(function (row) {
      return row.slice();
    });

    // The JSON wiring structures live on gameState verbatim (see
    // gameState.js) - the connect tool edits them in place and they're
    // sent back to clients as-is.
    this.gameState.portals  = mapData.portals;
    this.gameState.switches = mapData.switches;

    // Per-tile overrides are keyed by cell position, meaningless on a
    // different map - a map change starts clean (match resets keep them).
    this.gameState.tileOverrides = {};
  }

  _afterCreateMap(doc) {
    const mapData = { portals: this.gameState.portals, switches: this.gameState.switches };
    this.mapWiring.applyPortalData(mapData.portals);
    this.mapWiring.applySwitchData(mapData.switches);

    // Every portal on the map must end up with a gameState.portals entry
    // and a synced id - one with no outgoing wire is the true exit-portal
    // state (destination: null, id base+0.1), not a self-connection (see
    // mapWiring.js syncPortalId). Runs after applyPortalData so JSON-wired
    // portals keep their real destinations.
    this.mapWiring.normalizePortals();

    // Pads load in empty (mapLoader never picks a random type) - without
    // this, pregame would sit with every pad empty forever since nothing
    // else ever triggers a *first* spawn.
    this.gameHelpers.scheduleAllPowerupSpawns();
  }

  // The inverse of loadMap: live room state -> a storable mapFormat
  // document. gameState.map is the LIVE grid, which gameplay mutates in
  // place (flags taken, gates toggled, boosts spent), so this reads
  // initialMap - the pristine copy taken at load - and lets an editor
  // room's tile edits write through to both (see mapEditManager.setTiles).
  // Without that, saving mid-match would bake a flag someone is carrying
  // into the map as missing.
  toDocument() {
    const { gameState } = this;
    return mapFormat.normalizeDocument({
      name:        gameState.mapName,
      author:      gameState.mapAuthor,
      tiles:       gameState.initialMap,
      portals:     gameState.portals,
      switches:    gameState.switches,
      fields:      gameState.fields,
      spawnPoints: gameState.spawnPoints,
    });
  }

  // Spawn points are authored discs, not tiles, so they don't go through
  // changeTiles - but they have the same authoritative shape: mutate
  // gameState, rebuild what's derived from it, emit for broadcast.
  //
  // radius null removes the point. Placing on a cell that already has one
  // for that team replaces it, so a click is idempotent rather than
  // stacking duplicates on one cell.
  setSpawnPoint(team, x, y, radius, weight) {
    if (team !== 'red' && team !== 'blue') throw new Error(`unknown team ${team}`);
    if (!Number.isInteger(x) || !Number.isInteger(y)
        || this.gameState.map[y]?.[x] === undefined) {
      throw new Error('cell out of bounds');
    }

    const points = (this.gameState.spawnPoints[team] ?? []).filter(
      (p) => Math.floor(p.x) !== x || Math.floor(p.y) !== y
    );

    if (radius !== null) {
      const r = Math.max(0, Math.min(GameInstance.MAX_SPAWN_RADIUS, Math.floor(radius)));
      const w = Math.max(1, Math.min(GameInstance.MAX_SPAWN_WEIGHT, Math.floor(weight ?? 1)));
      points.push({ x, y, radius: r, weight: w });
      if (points.length > GameInstance.MAX_SPAWN_POINTS) {
        throw new Error(`at most ${GameInstance.MAX_SPAWN_POINTS} spawn points per team`);
      }
    }

    this.gameState.spawnPoints[team] = points;
    this.rebuildSpawnPool();
    this.emitter.emit('spawnPointsChanged', this.gameState.spawnPoints);
  }

  // spawnPool is derived from spawnPoints (game/tiles/mapFormat.js) and is
  // what spawning actually reads - rebuild it so an edit takes effect on
  // the very next spawn rather than at the next map load.
  rebuildSpawnPool() {
    this.gameState.spawnPool = mapFormat.toRuntime({
      tiles:       this.gameState.map,
      spawnPoints: this.gameState.spawnPoints,
      portals:     {}, switches: {}, fields: {},
      name: null, author: null,
    }).spawnPool;
  }

  createMap() {
    this._resetDataMap();
    for (let y = 0; y < this.gameState.map.length; y++) {
      for (let x = 0; x < this.gameState.map[y].length; x++) {
        this._buildTileBody(x, y);
      }
    }
  }

  _resetDataMap() {
    this.clearTiles();
    this.gameState.dataMap = this.gameState.map.map(function (row) {
      return row.map(function () {
        return null;
      });
    });
  }

  _buildTileBody(x, y) {
    const id = this.gameState.map[y][x];
    if (!id) return;

    const body = this.physicsWorld.makeBody(id, x, y, this.physicsLookup);

    const entry = {
      id,
      name:     this.physicsLookup[id]?.name     ?? 'unknown',
      category: this.physicsLookup[id]?.category ?? 'unknown',
      actions:  this.physicsLookup[id]?.actions,
      isTile:   true,
      x, y,
      body,
      sprite: null,
    };

    if (body) body.SetUserData(entry);
    this.gameState.setDataTile(x, y, entry);
  }

  clearTiles() {
    for (let y = 0; y < this.gameState.dataMap.length; y++) {
      for (let x = 0; x < this.gameState.dataMap[y]?.length; x++) {
        const data = this.gameState.dataMap[y]?.[x];
        if (data?.body)      this.physicsWorld.destroyBody(data.body);
        if (data?.fieldBody) this.physicsWorld.destroyBody(data.fieldBody);
      }
    }
    this.gameState.dataMap = [];
  }

  // Fields that must survive a tile id change. Without this, toggling a
  // gate or resetting a tile would rebuild the entry and lose its button
  // wiring, gate counts, and portal destination.
  static PERSISTENT_TILE_KEYS = [
    'defaultState', 'currentState', 'red', 'blue', 'stickyHandler', 'controllingButtons',
    'switchTimer', 'switchGates', 'switchBombs',
    'destinationX', 'destinationY', 'destinationTileX', 'destinationTileY',
    'portalCooldown', 'portalOnCooldown',
  ];

  // Pad families whose states are all the same physical sensor - just a
  // different id/name for which effect (if any) it currently applies. For
  // these, setTile keeps the existing body alive across a state change
  // instead of destroying and recreating it: a body that's never destroyed
  // never gives Box2D a reason to re-fire BeginContact for a player who was
  // already standing there, so a pad resetting/respawning under someone
  // can't re-trigger on them - they have to actually leave and come back.
  static REUSABLE_CATEGORIES = [
    'boost', 'redBoost', 'blueBoost', 'bomb', 'powerup',
    'portal', 'redPortal', 'bluePortal',
  ];

  // changeTiles' own tile-id tables - see changeTiles for what each guards.
  static TRANSIENT_TILE_IDS = new Set([
    3.1, 4.1, 16.1,        // taken flags
    5.1, 14.1, 15.1,       // used boosts
    10.1,                  // used bomb
    6.1, 6.2, 6.3, 6.4,    // spawned powerups (paint 6, the empty pad)
    19.1, 20.1, 21.1,      // taken potatoes
  ]);
  // Derived from physicsData.js's category field, not hand-typed id lists -
  // the same fact ("which ids are walls/portals") used to be independently
  // hardcoded here AND in client/game/packets/packetHandlers.js AND twice
  // more in client/game/renderer.js, all four kept in sync only by hand.
  static PORTAL_TILE_IDS = new Set(
    physicsData.filter(t => t.category === 'portal' || t.category === 'redPortal' || t.category === 'bluePortal').map(t => t.id)
  );
  static WALL_TILE_IDS = new Set(physicsData.filter(t => t.category === 'wall').map(t => t.id));
  static MAX_CHANGE_TILE_CELLS = 256;
  // Spawn discs are expanded into a per-cell pool, so an unbounded radius
  // or count would let one packet build an enormous array.
  static MAX_SPAWN_RADIUS  = 20;
  static MAX_SPAWN_WEIGHT  = 100;
  static MAX_SPAWN_POINTS  = 64;

  setTile(x, y, id) {
    this.gameState.setMapTile(x, y, id);

    const old         = this.gameState.getTile(x, y);
    const newData     = this.physicsLookup[id];
    const newCategory = newData?.category ?? 'unknown';

    if (old?.body
        && old.category === newCategory
        && GameInstance.REUSABLE_CATEGORIES.includes(newCategory)) {
      old.id   = id;
      old.name = newData?.name ?? 'unknown';
      return old;
    }

    if (old?.body) this.physicsWorld.destroyBody(old.body);

    if (!id) {
      this.gameState.setDataTile(x, y, null);
      return null;
    }

    const body = this.physicsWorld.makeBody(id, x, y, this.physicsLookup);

    const entry = {
      id,
      name:     newData?.name     ?? 'unknown',
      category: newCategory,
      actions:  newData?.actions,
      isTile:   true,
      x, y,
      body,
      sprite: null,
    };

    if (old) {
      for (const key of GameInstance.PERSISTENT_TILE_KEYS) {
        if (old[key] !== undefined) entry[key] = old[key];
      }
    }

    if (body) body.SetUserData(entry);
    this.gameState.setDataTile(x, y, entry);

    // A rebuilt solid body starts with the room-wide wall surface values
    // (physicsWorld.makeBody); layer this cell's per-tile override back on.
    this.applyTileSurface(entry);
    return entry;
  }

  // Per-tile wallFriction/wallRestitution override onto a solid cell body's
  // fixtures. matchManager.syncWallSurface is the runtime-change
  // counterpart; this covers body (re)creation.
  applyTileSurface(entry) {
    if (!entry?.body) return;
    const overrides = this.gameState.tileOverrides?.[`${entry.x},${entry.y}`];
    if (!overrides) return;
    for (let f = entry.body.GetFixtureList(); f; f = f.GetNext()) {
      if (f.IsSensor()) continue;
      if (overrides.wallRestitution !== undefined) f.SetRestitution(overrides.wallRestitution);
      if (overrides.wallFriction    !== undefined) f.SetFriction(overrides.wallFriction);
    }
  }

  // Bulk map-edit paint (DO-NEXT-011): validate id/cells against this
  // instance's own tile data, then apply every cell and emit everything
  // the change implies. Throws on invalid input, same convention as
  // setTileConnection - mapEditManager.setTiles catches it and reports the
  // message as an error packet. Moved here (out of the old leaderManager/
  // mapEditManager) so gameState/wallMap/wells/tileOverrides mutation and
  // the events it implies stay owned by the engine, not the packet layer.
  changeTiles(id, cells) {
    if (typeof id !== 'number' || !Number.isFinite(id)
        || (id !== 0 && !this.physicsLookup[id])) {
      throw new Error(`unknown tile id ${id}`);
    }
    if (GameInstance.TRANSIENT_TILE_IDS.has(id)) {
      throw new Error(`${id} is a transient tile state, paint its base tile instead`);
    }
    if (!Array.isArray(cells) || cells.length === 0 || cells.length > GameInstance.MAX_CHANGE_TILE_CELLS) {
      throw new Error(`cells must be an array of 1-${GameInstance.MAX_CHANGE_TILE_CELLS} entries`);
    }

    const gameState = this.gameState;

    for (const cell of cells) {
      const x = cell?.x;
      const y = cell?.y;
      if (!Number.isInteger(x) || !Number.isInteger(y)
          || gameState.map[y]?.[x] === undefined) {
        throw new Error('cell out of bounds');
      }
    }

    let connectionsChanged = false;

    for (const { x, y } of cells) {
      const oldId = gameState.map[y][x];
      if (oldId === id) continue;

      // Painting over a wired button/gate/bomb/portal severs its
      // connections on both sides (DO-NEXT-012) - before the setTile
      // emit below rebuilds the entry.
      if (this.mapWiring.severTileConnections(x, y, id)) connectionsChanged = true;

      // Per-tile setting overrides (DO-NEXT-013) belong to the tile that
      // was there: repainting to a different category drops them, while a
      // same-category repaint (boost -> boost variant) keeps them.
      const overrideKey = `${x},${y}`;
      if (gameState.tileOverrides[overrideKey]
          && this.physicsLookup[oldId]?.category !== this.physicsLookup[id]?.category) {
        delete gameState.tileOverrides[overrideKey];
        this.emitter.emit('tileSettingsChanged', x, y, {});
      }

      // Per-cell texture overrides (DO-NEXT-016/018) are keyed by the exact
      // state id they customize ("x,y,tileId"), not by category - unlike
      // physics overrides above, even a same-category repaint (boost ->
      // redBoost) puts a different id family at this cell, so any id change
      // orphans every state-keyed entry for the old family. Left in place,
      // an orphaned entry silently reactivates later if this cell is ever
      // repainted back to a tile that happens to share that exact state id
      // (e.g. two different flag colors both having a ".1 taken" variant
      // would not collide, but repainting away and back to the SAME flag
      // would resurrect a texture the leader had already moved on from).
      // Clearing on every id change makes "this cell's texture picks
      // belong to what's painted here right now" the one consistent rule,
      // matching how tileOverrides/connections already work above.
      // Gravity wells are a load-time-derived structure (loadMap builds
      // gameState.wells once) - keep it in step here, or an erased well
      // would keep pulling and a painted one would never pull.
      if (oldId === TILE_ID.GRAVITYWELL) {
        gameState.wells = gameState.wells.filter(w => w.x !== x + 0.5 || w.y !== y + 0.5);
      }
      if (id === TILE_ID.GRAVITYWELL) {
        gameState.wells.push({
          x: x + 0.5,
          y: y + 0.5,
          radius:   this.config.gravityWellRadius,
          strength: this.config.gravityWellStrength,
          falloff:  this.config.gravityWellFalloff,
          mode:     this.config.gravityWellMode,
        });
      }

      // Keep the parallel wallMap grid in step (see WALL_TILE_IDS).
      gameState.wallMap[y][x] = GameInstance.WALL_TILE_IDS.has(id) ? id : 0;

      // 'setTile' rebuilds the server body and broadcasts to clients; the
      // initialMap write is what makes the edit survive match resets
      // (resetTiles restores from initialMap).
      this.emitter.emit('setTile', x, y, id);
      gameState.initialMap[y][x] = id;

      // A pad painted in never went through loadMap's initial arming, so
      // it would sit empty forever without its own first spawn cycle.
      if (id === TILE_ID.PUPEMPTY) this.gameHelpers.schedulePowerupSpawn(x, y);

      // A painted portal starts self-connected (exit portal) - the id is
      // synced to base+0.1 by initPaintedPortal, and the room needs the
      // new wiring structures.
      if (GameInstance.PORTAL_TILE_IDS.has(id)) {
        this.mapWiring.initPaintedPortal(x, y);
        connectionsChanged = true;
      }
    }

    // One broadcast per stroke, not per severed cell.
    if (connectionsChanged) {
      this.emitter.emit('connectionsChanged', this.mapWiring.getConnectionData());
    }
  }

  // Connect-tool entry points (map-edit connect/right-click clear) -
  // thin delegates so mapEditManager's public API doesn't have to know the
  // implementation lives in mapWiring.js (see game/mapWiring.js).
  setTileConnection(sx, sy, tx, ty, action) {
    return this.mapWiring.setTileConnection(sx, sy, tx, ty, action);
  }

  clearTileConnections(x, y) {
    return this.mapWiring.clearTileConnections(x, y);
  }

  start() {
    if (this.running) return;
    this.running  = true;
    this.lastTime = Date.now();

    const STEP = 1000 / 60;
    const self = this;

    // How much simulated-but-not-yet-ticked time the accumulator is allowed
    // to carry. A single slow frame is already bounded by the
    // Math.min(frameTime, 250) below; this instead bounds the *running*
    // accumulator itself, so a stretch of ticks that each take longer than
    // STEP (a slow tile handler, GC pressure, whatever) can't compound call
    // over call into an ever-growing catch-up queue - once debt passes this,
    // the extra is dropped (the sim visibly loses time) instead of queuing
    // more work that makes the next call take longer still.
    const MAX_ACCUMULATOR_MS = 250;

    function loop() {
      if (!self.running) return;
      const now       = Date.now();
      const frameTime = now - self.lastTime;
      self.lastTime   = now;

      self.accumulator += Math.min(frameTime, 250);

      if (self.accumulator > MAX_ACCUMULATOR_MS) {
        console.warn(`[gameInstance] tick loop falling behind: dropping ${(self.accumulator - MAX_ACCUMULATOR_MS).toFixed(1)}ms of accumulator debt`);
        self.accumulator = MAX_ACCUMULATOR_MS;
      }

      try {
        while (self.accumulator >= STEP) {
          self.tick();
          self.accumulator -= STEP;
        }
      } catch (err) {
        self.crash(err);
        return;
      }

      // Sleep until the next tick is actually due instead of polling at max
      // speed - self.accumulator is always < STEP here (the while loop above
      // only exits once it's drained below that), so STEP - accumulator is
      // the real time left before there's work to do. Node clamps 0/negative
      // delays to ~1ms, so an unconditional setTimeout(loop, 0) would still
      // fire ~600-1000x/sec per room chasing 60 real ticks/sec of work -
      // wasted Date.now() calls, closures, and timer churn that scales
      // linearly with room count on this single-threaded event loop.
      setTimeout(loop, Math.max(0, STEP - self.accumulator));
    }

    loop();

    this.snapshotTimer = setInterval(function () {
      try {
        self.pushSnapshots();
      } catch (err) {
        self.crash(err);
      }
    }, this.config.snapshotInterval);
  }

  stop() {
    this.running = false;
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
  }

  // A room's state is presumed corrupt once its tick loop throws - this
  // stops the loop (reusing stop(), no duplicate teardown) and hands the
  // error off through the same emitter seam everything else uses, so
  // server-side code (which owns the room/registry, not this file) can log
  // it, close the room's clients, and remove it from the registry. Guarded
  // by `running` since the tick loop and the snapshot timer can both throw
  // in the same tick and would otherwise both call this.
  crash(err) {
    if (!this.running) return;
    this.stop();
    this.emitter.emit('crashed', err);
  }

  pushSnapshots() {
    const deltas = this.snapshotFactory.buildAllDeltas();
    if (deltas.size > 0) {
      // false: this is the regular interval tick (config.snapshotInterval,
      // ~every 250ms) - routine drift correction, meant to be eased in
      // smoothly rather than snapped. See pushSnapshotsFor below for the
      // other case.
      this.emitter.emit('snapshot', deltas, false);
    }
    // Un-culled, globally-deduplicated equivalent for replay recording -
    // emitted every call regardless of whether the per-viewer path above had
    // anything, so the listener (if any) decides whether the delta is empty.
    this.emitter.emit('replayPlayers', this.snapshotFactory.buildReplayDelta());
  }

  pushSnapshotsFor(target) {
    // Nulls are expected here, not a caller bug: playerLifecycle.popPlayer
    // returns null for a pop that didn't happen - most often a tag landing
    // inside the victim's flag-grab invulnerability window - and the tile
    // handlers emit that result straight through ('update', popPlayer(x)).
    // Without this filter that null reached buildDeltasForPlayers, which
    // read .id off it and threw INSIDE the Box2D contact listener, killing
    // the tick loop and tearing down the whole room. Grabbing a flag and
    // being tagged a moment later is ordinary play, and it took the room
    // down with it every time.
    const players = (Array.isArray(target) ? target : [target]).filter(Boolean);

    if (players.length) {
      const deltas = this.snapshotFactory.buildDeltasForPlayers(players);
      if (deltas.size > 0) {
        // true: this is an out-of-band push triggered by a discrete event
        // (boost, bomb, pop, flag grab, teleport, respawn, ...) via the
        // 'update' emit gameHelpers/tileHandlers fire for exactly this
        // reason - not routine drift, so the client should snap straight
        // to the new state instead of smoothly easing into it. Easing a
        // sudden velocity change (a boost, most visibly) looked like the
        // player was gliding into their new speed instead of actually
        // being boosted.
        this.emitter.emit('snapshot', deltas, true);
      }
    }

    // Emitted even when there was nothing to push, matching pushSnapshots -
    // the replay recorder decides for itself whether an empty delta matters.
    this.emitter.emit('replayPlayers', this.snapshotFactory.buildReplayDelta());
  }

  tick() {
    if (this.gameState.state === 'paused') return;

    this.gameState.stepCount++;
    this.gravityLogic.applyJumps();
    this.physicsHelpers.movePlayers();
    this.physicsHelpers.applyForceFields();
    this.gravityLogic.counterGravity();
    this.physicsWorld.step(this.timeStep);
    this.physicsHelpers.syncPlayers();
    this.gameHelpers.syncEggball();
    this.matchManager.tick();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = GameInstance;
if (typeof globalThis !== 'undefined') globalThis.GameInstance = GameInstance;
})();
