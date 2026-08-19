(function () {
const { validateSettings } = (typeof require === 'function') ? require('./matchSettings') : globalThis.MatchSettings;
const { SCHEMA, SCHEMA_BY_KEY, coerce, applyPartial } = (typeof require === 'function') ? require('./settingsSchema') : globalThis.SettingsSchema;
const Eggball = (typeof require === 'function') ? require('./eggball') : globalThis.Eggball;

const STEP_MS = 1000 / 60;

// How long the 'ended' state's results screen stays up before the room
// auto-resets to pregame and applies the pregame profile - see
// createMatchManager's tick() 'ended' handling.
const RESULTS_DELAY_MS = 10000;

const PHYSICS_ENTRIES = SCHEMA.filter(e => e.scope === 'physics');
const MATCH_ENTRIES    = SCHEMA.filter(e => e.scope === 'match');
const PLAYER_KEYS      = PHYSICS_ENTRIES.filter(e => e.playerScoped).map(e => e.key);
const TILE_KEYS        = PHYSICS_ENTRIES.filter(e => e.tileScoped).map(e => e.key);

// Purely a display grouping for the client's Group Settings panel, derived
// from each entry's `category` field - a new schema entry with a category
// automatically lands in the right bucket, no separate table to keep in
// sync.
function buildCategories(entries) {
  const categories = {};
  for (const entry of entries) {
    if (!entry.category) continue;
    (categories[entry.category] ??= []).push(entry.key);
  }
  return categories;
}

const PHYSICS_CATEGORIES = buildCategories(PHYSICS_ENTRIES);

// Client-relevant metadata only - never leaks server-only fields like
// `hooks`.
// The schema fields the client's settings UIs are built from. tileScoped/
// tileCategories drive the per-tile settings panel (which keys show for
// which tile), and nullable drives the "empty field = clear/unlimited"
// input handling - omitting them here silently broke both client-side,
// since the client sees only this meta, never settingsSchema.js itself.
function schemaMeta(entries) {
  return entries.map(({ key, type, options, category, scale, unit, nullable, tileScoped, tileCategories }) =>
    ({ key, type, options, category, scale, unit, nullable, tileScoped, tileCategories }));
}

var createMatchManager = function(gameState, gameHelpers, physicsWorld, config, emitter, physicsLookup) {

  // Snapshot of every physics value at the moment this match started, before
  // any updatePhysics() call has had a chance to mutate `config` - the only
  // way the client can show "changed from default" without duplicating
  // gameConfig.js's literals.
  const physicsDefaults = { ...config };

  function getPhysicsDefaults() {
    return physicsDefaults;
  }

  function getPhysicsCategories() {
    return PHYSICS_CATEGORIES;
  }

  function getPhysicsSchemaMeta() {
    return schemaMeta(PHYSICS_ENTRIES);
  }

  function getMatchSchemaMeta() {
    return schemaMeta(MATCH_ENTRIES);
  }

  // ---- pregame/game profiles -----------------------------------------
  //
  // Two persistent, leader-configured {physics, match, mapId} buckets -
  // the room is always "in" one or the other (see isPregamePhase/
  // isGamePhase below), and there is no separate live-vs-draft distinction:
  // editing a field just updates that bucket, and if the room is CURRENTLY
  // in the phase that bucket governs, the edit also applies live in the
  // same call. Editing "game" while the room is in pregame (or vice versa)
  // only updates the stored bucket - it takes effect the next time the room
  // actually enters that phase (tick()'s 'ended' auto-transition applies
  // the pregame bucket wholesale; startMatch() applies the game bucket
  // wholesale - see applyProfile below).
  //
  // Map loading is the one part this file can't do itself - engine/ has no
  // network access, so that half is handed off via the 'applyProfileMap'
  // event for whichever transport is running (local/hostSession.js) to
  // fetch and load, both here and in the live-apply path in setProfile.
  var profiles = {
    pregame: { physics: {}, match: {}, mapId: null },
    game:    { physics: {}, match: {}, mapId: null },
  };

  // "Pregame" covers both the literal 'pregame' state and the 'ended'
  // results screen - the user's own framing: "The pregame is before the
  // game starts and 10 seconds after the game ends."
  function isPregamePhase() {
    return gameState.state === 'pregame' || gameState.state === 'ended';
  }

  function isGamePhase() {
    return gameState.state === 'countdown' || gameState.state === 'live'
      || gameState.state === 'overtime' || gameState.state === 'paused';
  }

  // partial: { physics?, match?, mapId? } - merged into the named bucket
  // (never replaces the whole thing), then live-applied on top of that
  // immediately if the room is currently in the phase this profile governs.
  function setProfile(name, partial) {
    if (name !== 'pregame' && name !== 'game') return false;
    var profile = profiles[name];
    if (partial.physics) Object.assign(profile.physics, partial.physics);
    if (partial.match)   Object.assign(profile.match, partial.match);
    if (partial.mapId !== undefined) profile.mapId = partial.mapId;

    emitter.emit('profilesChanged', getProfiles());

    var live = (name === 'pregame' && isPregamePhase()) || (name === 'game' && isGamePhase());
    if (live) {
      if (partial.physics) updatePhysics(partial.physics);
      if (partial.match)   updateSettings(partial.match);
      if (partial.mapId)   emitter.emit('applyProfileMap', partial.mapId);
    }
    return true;
  }

  // Full buckets, not just mapId - the client needs the real values to
  // render each profile's own form (there's no local draft copy to fall
  // back on any more).
  function getProfiles() {
    return { pregame: profiles.pregame, game: profiles.game };
  }

  // Applies a bucket wholesale - called when the room actually TRANSITIONS
  // into the phase that bucket governs (tick()'s 'ended'->pregame
  // auto-reset, and startMatch()), as opposed to setProfile's live-apply
  // above, which fires off a single edited field while already in that
  // phase.
  function applyProfile(name) {
    var profile = profiles[name];
    if (profile.physics) updatePhysics(profile.physics);
    if (profile.match)   updateSettings(profile.match);
    if (profile.mapId)   emitter.emit('applyProfileMap', profile.mapId);
  }

  function elapsedMs() {
    return (gameState.stepCount - gameState.phaseStartStep) * STEP_MS;
  }

  function freezeAll(frozen) {
    for (const player of gameState.players) {
      player.matchFrozen = frozen;
    }
  }

  function respawnAll() {
    for (const player of gameState.players) {
      gameHelpers.respawnPlayer(player);
    }
  }

  // The tick loop keeps stepping physics even in the 'ended' state, so
  // without this everyone just keeps drifting/bouncing on whatever
  // momentum they had the instant the match ended.
  function stopAllMomentum() {
    for (const player of gameState.players) {
      if (!player.body) continue;
      physicsWorld.setVelocity(player.body, 0, 0);
      player.body.SetAngularVelocity(0);
      player.lx = 0;
      player.ly = 0;
    }
  }

  // Restores every tile that drifted from the freshly loaded map (taken
  // flags, used boosts/bombs, consumed powerups, toggled gates). Emitting
  // 'setTile' both rebuilds the server body and broadcasts to clients.
  function resetTiles() {
    const initial = gameState.initialMap;
    if (!initial) return;

    for (let y = 0; y < initial.length; y++) {
      for (let x = 0; x < initial[y].length; x++) {
        if (gameState.map[y]?.[x] !== initial[y][x]) {
          emitter.emit('setTile', x, y, initial[y][x]);
        }
      }
    }
  }

  // Puts every map element back to its loaded state: cancels all pending
  // tile timers (boost/bomb cooldowns, powerup respawns, gate sticky
  // timers), zeroes gate press counts, clears portal cooldowns, then
  // restores tile ids from initialMap.
  function resetElements() {
    gameHelpers.clearTileTimers();

    for (const row of gameState.dataMap) {
      for (const entry of row ?? []) {
        if (!entry) continue;

        if (entry.defaultState !== undefined) {
          entry.red           = 0;
          entry.blue          = 0;
          entry.stickyHandler = null;
          entry.currentState  = entry.defaultState;
        }

        if (entry.portalOnCooldown !== undefined) {
          entry.portalOnCooldown = false;
        }
      }
    }

    resetTiles();
  }

  // Strips every carried effect off every player: powerups and their
  // timers, pending respawns, team-tile stacks, portal re-entry memory.
  function resetPlayerEffects() {
    for (const player of gameState.players) {
      gameHelpers.clearAllPlayerTimers(player);

      player.tagpro        = false;
      player.rollingBomb   = false;
      player.jukeJuice     = false;
      player.hasEgg        = false;
      player.activeTeamTiles.clear();
      player.lastPortalX   = null;
      player.lastPortalY   = null;

      for (const name of Object.keys(player.modifiers)) {
        gameHelpers.removeModifier(player, name);
      }
    }
  }

  // Fresh field: scores zeroed, carried flags returned, player effects
  // stripped, elements and tiles restored, everyone back on spawn.
  // Pregame captures are allowed, so this is what wipes the warm-up
  // score when the real match begins.
  function resetField() {
    gameState.scores = { red: 0, blue: 0 };

    for (const player of gameState.players) {
      gameHelpers.returnFlag(player);
    }

    resetPlayerEffects();
    resetElements();
    respawnAll();

    if (config.eggballEnabled) gameHelpers.spawnEggball('red');
    else gameHelpers.despawnEggball();

    emitter.emit('score', gameState.scores);
  }

  function determineWinner() {
    const { red, blue } = gameState.scores;
    if (red === blue) return null;
    return red > blue ? 'red' : 'blue';
  }

  function startMatch() {
    if (gameState.state !== 'pregame' && gameState.state !== 'ended') return false;

    // Physics/match settings apply synchronously; a configured map load is
    // async (see applyProfile's header) and lands shortly after via
    // 'applyProfileMap' - the countdown below doesn't wait on it, same
    // trade-off as the 'ended'->pregame auto-transition in tick().
    applyProfile('game');

    resetField();
    freezeAll(true);

    gameState.state          = 'countdown';
    gameState.phaseStartStep = gameState.stepCount;
    gameState.pausedFrom     = null;

    emitter.emit('matchStateChanged');
    return true;
  }

  function endMatch(reason, winner = determineWinner()) {
    gameState.state          = 'ended';
    gameState.phaseStartStep = gameState.stepCount; // tick()'s 'ended' handling measures the results-screen delay from here
    freezeAll(true);
    stopAllMomentum();

    emitter.emit('update', gameState.players);
    emitter.emit('matchEnd', { winner, reason, scores: { ...gameState.scores } });
    emitter.emit('matchStateChanged');
  }

  function pauseMatch() {
    // An editor room never starts a match, so it sits in 'pregame' forever -
    // but freezing the sandbox is still meaningful there (it's what stops
    // everyone mid-build). Pausing from pregame is therefore allowed in an
    // editor room and only there; a game room pausing from pregame would
    // mean pausing something that hasn't begun.
    const activeStates = gameState.mode === 'editor'
      ? ['pregame', 'countdown', 'live', 'overtime']
      : ['countdown', 'live', 'overtime'];
    if (!activeStates.includes(gameState.state)) return false;

    gameState.pausedFrom = gameState.state;
    gameState.state      = 'paused';

    emitter.emit('matchStateChanged');
    return true;
  }

  function resumeMatch() {
    if (gameState.state !== 'paused' || !gameState.pausedFrom) return false;

    gameState.state      = gameState.pausedFrom;
    gameState.pausedFrom = null;

    emitter.emit('matchStateChanged');
    return true;
  }

  // Per-player overrides are the one thing a reset wipes that gameplay
  // didn't change (owner decision, DO-NEXT-010): map edits and group
  // settings persist across resets, per-player tuning does not. Routed
  // through updatePlayerPhysics key-by-key so body-stat side effects and
  // the playerPhysicsChanged broadcast happen exactly like a manual
  // "reset to default" from the leader.
  function clearAllPlayerOverrides() {
    for (const player of gameState.players) {
      const keys = Object.keys(player.overrides);
      if (!keys.length) continue;

      const cleared = {};
      for (const key of keys) cleared[key] = null;
      updatePlayerPhysics(player, cleared);
    }
  }

  function resetMatch() {
    gameState.state      = 'pregame';
    gameState.pausedFrom = null;

    // Deliberately only here, not in startMatch's resetField: tuning
    // players in pregame and then starting the match keeps the tuning;
    // the leader's explicit Reset wipes it.
    clearAllPlayerOverrides();

    resetField();
    freezeAll(false);

    // Pregame has no countdown to wait out, so pads start cycling right
    // away here - startMatch instead waits for the countdown->live
    // transition in tick() below.
    gameHelpers.scheduleAllPowerupSpawns();

    emitter.emit('matchStateChanged');
  }

  function updateSettings(partial) {
    gameState.matchSettings = validateSettings(partial, gameState.matchSettings);
    emitter.emit('matchStateChanged');
    return gameState.matchSettings;
  }

  function getPhysics() {
    const out = {};
    for (const entry of PHYSICS_ENTRIES) {
      out[entry.key] = config[entry.key];
    }
    return out;
  }

  // Room-wide side effects for physics changes, keyed by the schema `hooks`
  // tag(s) a changed key carries. Each hook checks its own trigger keys
  // against `partial`, so a plain new numeric/enum/bool setting with no
  // `hooks` entry (e.g. bombRadius, portalExploRadius) runs none of these.
  const SIDE_EFFECT_HOOKS = {
    // World gravity is only read once at PhysicsWorld construction, so a
    // config change has to be pushed onto the live Box2D world directly.
    gravity(partial) {
      if (partial.gravityX !== undefined || partial.gravityY !== undefined) {
        physicsWorld.setGravity(config.gravityX, config.gravityY);
      }
    },

    // Wall surface changes apply to every existing solid tile fixture -
    // except cells with their own per-tile override, which keep it when
    // the room-wide default changes underneath (same rule as per-player
    // overrides vs room-wide changes).
    wallSurface(partial) {
      if (partial.wallRestitution === undefined && partial.wallFriction === undefined) return;
      for (const row of gameState.dataMap) {
        for (const entry of row ?? []) {
          if (!entry?.body) continue;
          syncWallSurface(entry.x, entry.y);
        }
      }
    },

    // Fixture friction and damping are baked in at body creation - push the
    // new default onto every existing player's body. pushPlayerBodyStats
    // itself prefers a player's own override over this config value, so a
    // player with an explicit override is left untouched by a room-wide
    // change, matching "overrides persist until the leader changes them".
    playerBody(partial) {
      if (partial.playerFriction === undefined && partial.linearDamping === undefined && partial.angularDamping === undefined) return;
      for (const player of gameState.players) {
        gameHelpers.pushPlayerBodyStats(player);
      }
    },

    // accel/maxSpeed on players are read-only getters derived from
    // overrides + baseStats + modifiers. Config changes rewrite each
    // player's base; an explicit override (or an active modifier) still
    // wins on top automatically.
    playerBaseStats(partial) {
      if (partial.accel === undefined && partial.maxSpeed === undefined) return;
      for (const player of gameState.players) {
        player.baseStats.accel    = config.accel;
        player.baseStats.maxSpeed = config.maxSpeed;
      }
      emitter.emit('update', gameState.players);
    },

    // Wells were stamped with their radius/strength/falloff/mode at map load
    // (physicsHelpers/loop.js just read those baked-in fields every tick),
    // so a config change has to rewrite each existing well too, not just
    // gameConfig, or the change would silently do nothing. Routed through
    // syncWellSettings so a well with its own per-tile override keeps it
    // when the room-wide default changes underneath (same rule as
    // per-player overrides vs room-wide changes).
    gravityWells(partial) {
      const keys = ['gravityWellRadius', 'gravityWellStrength', 'gravityWellFalloff', 'gravityWellMode'];
      if (!keys.some(key => partial[key] !== undefined)) return;
      for (const well of gameState.wells) {
        syncWellSettings(well.x - 0.5, well.y - 0.5);
      }
    },

    // A pad showing a type that was just disabled needs to flip to empty
    // (and re-arm its own spawn) right away instead of waiting to be picked
    // up first.
    powerupToggle(partial) {
      const toggleKeys = PHYSICS_ENTRIES.filter(e => e.hooks?.includes('powerupToggle')).map(e => e.key);
      if (!toggleKeys.some(key => partial[key] !== undefined)) return;
      gameHelpers.enforcePowerupToggles();
    },

    // A leader flipping eggballEnabled takes effect immediately rather than
    // waiting for the next match start/reset - on: spawn one to a random
    // red player right away (same starting rule as resetField); off:
    // despawn whatever's there, carried or in flight.
    eggballToggle(partial) {
      if (partial.eggballEnabled === undefined) return;
      if (config.eggballEnabled) gameHelpers.spawnEggball('red');
      else gameHelpers.despawnEggball();
    },
  };

  // Per-player subset of the same hooks, scoped to one player instead of
  // looping over gameState.players.
  const PLAYER_SIDE_EFFECT_HOOKS = {
    playerBody(partial, player) {
      if (partial.playerFriction === undefined && partial.linearDamping === undefined && partial.angularDamping === undefined) return;
      gameHelpers.pushPlayerBodyStats(player);
    },
    playerBaseStats(partial, player) {
      if (partial.accel === undefined && partial.maxSpeed === undefined) return;
      emitter.emit('update', player);
    },
  };

  function updatePhysics(partial) {
    const next = applyPartial(partial, config, { allowKey: e => e.scope === 'physics' });
    Object.assign(config, next);

    for (const tag of new Set(PHYSICS_ENTRIES.flatMap(e => e.hooks || []))) {
      SIDE_EFFECT_HOOKS[tag]?.(partial ?? {});
    }

    emitter.emit('physicsChanged', getPhysics(), gameState.wells);
    return getPhysics();
  }

  // Sparse - only whitelisted keys the leader has explicitly overridden for
  // this player. The client already knows the room-wide defaults from
  // getPhysics()/physicsChanged, so it computes "effective = override ??
  // default" itself rather than receiving a merged snapshot here.
  function getPlayerPhysics(player) {
    return { ...player.overrides };
  }

  // Leader-only per-player override. `raw === null` for a key means "clear
  // this override, revert to whatever the room-wide config says" - the
  // wire-level counterpart of a "Reset to default" button.
  function updatePlayerPhysics(player, partial) {
    for (const [key, raw] of Object.entries(partial ?? {})) {
      const entry = SCHEMA_BY_KEY[key];
      if (!entry || !entry.playerScoped) {
        throw new Error(`unknown player setting: ${key}`);
      }
      // null always means "clear this override, revert to the room-wide
      // default" for a per-player setting - distinct from a schema entry's
      // own `nullable` flag, which describes match-setting semantics.
      if (raw === null) {
        delete player.overrides[key];
        continue;
      }
      player.overrides[key] = coerce(entry, raw);
    }

    const playerEntries = PLAYER_KEYS.map(key => SCHEMA_BY_KEY[key]);
    for (const tag of new Set(playerEntries.flatMap(e => e.hooks || []))) {
      PLAYER_SIDE_EFFECT_HOOKS[tag]?.(partial ?? {}, player);
    }

    emitter.emit('playerPhysicsChanged', player.id, getPlayerPhysics(player));
    return getPlayerPhysics(player);
  }

  // The gravity-well tileScoped keys are the one exception to "read at
  // the moment of use": the per-tick force loops (server physicsHelpers,
  // client loop.js) read the baked well objects in gameState.wells, so
  // an override has to be written through onto the matching well -
  // override if this cell has one, else the room-wide config value.
  function syncWellSettings(x, y) {
    const well = gameState.wells.find(w => w.x === x + 0.5 && w.y === y + 0.5);
    if (!well) return false;

    const overrides = gameState.tileOverrides[`${x},${y}`] ?? {};
    well.radius   = overrides.gravityWellRadius   ?? config.gravityWellRadius;
    well.strength = overrides.gravityWellStrength ?? config.gravityWellStrength;
    well.falloff  = overrides.gravityWellFalloff  ?? config.gravityWellFalloff;
    well.mode     = overrides.gravityWellMode     ?? config.gravityWellMode;
    return true;
  }

  // Wall surface values are baked into the cell body's fixtures like
  // damping is into player bodies - a change (per-tile override or
  // room-wide default) has to be pushed onto the live fixtures. No-op for
  // sensor tiles (nothing bounces off a boost).
  function syncWallSurface(x, y) {
    const entry = gameState.getTile(x, y);
    if (!entry?.body) return;

    const overrides = gameState.tileOverrides[`${x},${y}`] ?? {};
    for (let f = entry.body.GetFixtureList(); f; f = f.GetNext()) {
      if (f.IsSensor()) continue;
      f.SetRestitution(overrides.wallRestitution ?? config.wallRestitution);
      f.SetFriction(overrides.wallFriction ?? config.wallFriction);
    }
  }

  // Leader-only per-tile override (DO-NEXT-013), the tile counterpart of
  // updatePlayerPhysics: `raw === null` clears that key. The whole partial
  // is validated into a copy before anything is applied, so a bad key
  // changes nothing. Most tileScoped keys are read at the moment of use
  // (gameHelpers.tileSetting) and need no side effect; gravity-well keys
  // write through to the baked well object (syncWellSettings above).
  function updateTileSettings(x, y, partial) {
    if (!Number.isInteger(x) || !Number.isInteger(y)
        || gameState.map[y]?.[x] === undefined) {
      throw new Error('tile out of bounds');
    }

    const cellKey  = `${x},${y}`;
    const tileId   = gameState.map[y][x];
    // id 0 is an empty cell with no physicsLookup entry - it behaves like
    // floor for movement purposes (see gameInstance.js WALL_TILE_IDS/
    // floorFriction usage), so floorFriction's ['floor'] tileCategories
    // must accept it too.
    const category = tileId === 0 ? 'floor' : physicsLookup[tileId]?.category;
    const overrides = { ...(gameState.tileOverrides[cellKey] ?? {}) };

    for (const [key, raw] of Object.entries(partial ?? {})) {
      const entry = SCHEMA_BY_KEY[key];
      if (!entry || !entry.tileScoped) {
        throw new Error(`unknown tile setting: ${key}`);
      }
      if (entry.tileCategories && !entry.tileCategories.includes(category)) {
        throw new Error(`${key} does not apply to this tile`);
      }
      if (raw === null) {
        delete overrides[key];
        continue;
      }
      overrides[key] = coerce(entry, raw);
    }

    if (Object.keys(overrides).length) {
      gameState.tileOverrides[cellKey] = overrides;
    } else {
      delete gameState.tileOverrides[cellKey]; // sparse: no empty entries
    }

    emitter.emit('tileSettingsChanged', x, y, overrides);

    // Baked-in per-tile values need their write-through (cheap no-ops for
    // cells they don't apply to). The wall surface needs no extra
    // broadcast: the client's prediction walls sync themselves off the
    // tileSettingsChanged packet it already got.
    syncWallSurface(x, y);

    // Client prediction reads wells off the physicsChanged packet, so a
    // well write-through has to reach the room the same way a room-wide
    // gravity-well change does (settings unchanged, wells updated).
    if (syncWellSettings(x, y)) {
      emitter.emit('physicsChanged', getPhysics(), gameState.wells);
    }

    return overrides;
  }

  function checkCaptureWinConditions(player) {
    // No score is kept in an editor room, so score limit and mercy have
    // nothing to test and there is no match for overtime to end.
    if (gameState.mode === 'editor') return;

    const settings = gameState.matchSettings;

    if (gameState.state === 'overtime') {
      endMatch('overtime', player.team);
      return;
    }

    if (gameState.state !== 'live') return;

    if (settings.scoreLimit !== null && gameState.scores[player.team] >= settings.scoreLimit) {
      endMatch('scoreLimit', player.team);
      return;
    }

    if (settings.mercyRule !== null) {
      const diff = Math.abs(gameState.scores.red - gameState.scores.blue);
      if (diff >= settings.mercyRule) {
        endMatch('mercy', determineWinner());
      }
    }
  }

  function tick() {
    // No timer in an editor room: nothing counts down, so nothing expires
    // into overtime or a time-limit end.
    if (gameState.mode === 'editor') return;

    const settings = gameState.matchSettings;

    // Results screen auto-dismiss: RESULTS_DELAY_MS after a match ends,
    // clear every spawned player back out (unlike resetMatch(), which
    // respawns everyone in place - this is a full "everyone gets deleted"
    // reset, not a restart) and land in pregame, applying the pregame
    // profile.
    if (gameState.state === 'ended') {
      if (elapsedMs() >= RESULTS_DELAY_MS) {
        for (const player of gameState.players.slice()) gameHelpers.removePlayer(player.id);
        gameState.state          = 'pregame';
        gameState.phaseStartStep = gameState.stepCount;
        applyProfile('pregame');
        emitter.emit('matchStateChanged');
      }
      return;
    }

    if (gameState.state === 'countdown') {
      if (elapsedMs() >= settings.countdownDuration) {
        freezeAll(false);
        gameState.state          = 'live';
        gameState.phaseStartStep = gameState.stepCount;
        gameHelpers.scheduleAllPowerupSpawns(); // powerupRespawn starts counting from here, not from Start
        emitter.emit('matchStateChanged');
      }
      return;
    }

    if (gameState.state === 'live') {
      if (elapsedMs() >= settings.timeLimit) {
        const winner = determineWinner();
        if (winner === null && settings.overtimeEnabled) {
          gameState.state          = 'overtime';
          gameState.phaseStartStep = gameState.stepCount;
          emitter.emit('matchStateChanged');
        } else {
          endMatch('timeLimit', winner);
        }
      }
    }
  }

  emitter.on('capture', checkCaptureWinConditions);

  // Eggball's own scoring path - not routed through checkCaptureWinConditions
  // directly (tileHandlers.js's eggballScore has no reference to it, only to
  // the emitter - same reasoning flagCapture's separate 'capture' emit
  // already follows). Unlike a normal flag capture, a score here also
  // freezes and respawns everyone after a countdown, and hands the egg to
  // whichever team just got scored on for the next round - the whole
  // process now lives in engine/eggball.js's own scoreEggball, since it's
  // Eggball-mode behavior, not match-lifecycle machinery; this just wires
  // it up with the match-lifecycle pieces (win conditions, respawn,
  // freeze) it needs but doesn't own itself.
  emitter.on('eggballScore', function (player) {
    Eggball.scoreEggball(player, gameHelpers, gameState, emitter, {
      checkCaptureWinConditions: checkCaptureWinConditions,
      respawnAll: respawnAll,
      freezeAll: freezeAll,
    });
  });

  // ---- save states ------------------------------------------------------
  // In-memory only, keyed by leader-chosen name, scoped to this room's
  // lifetime (this Map lives in matchManager's own closure - one per
  // GameInstance, same as everything else here). Deliberately NOT
  // persisted anywhere: this exists for rapid iterate-test-iterate physics
  // tuning within a single session, not as a durable save file - see
  // local/localPresets.js and local/controlPanel.js's settings-code
  // save/load for the "durable, portable" half of that spectrum.
  //
  // Restore leaves flag-carrying alone rather than trying to reconstruct
  // it (gameHelpers.returnFlag puts every flag back home first) - flag
  // state is a small state machine of its own (carrier, dropped position,
  // home) and getting it wrong silently would be worse than not
  // attempting it. Position/velocity/dead-state/scores/map-dynamic-state
  // is the part this feature actually exists for.
  const saveStates = new Map();

  function listSaveStates() {
    return [...saveStates.keys()];
  }

  function captureSaveState(name) {
    const players = gameState.players.map(p => ({
      id: p.id, x: p.x, y: p.y, a: p.a, lx: p.lx, ly: p.ly, dead: p.dead,
    }));

    const powerupPads = [];
    for (const row of gameState.dataMap) {
      for (const entry of row ?? []) {
        if (entry?.category === 'powerup') powerupPads.push({ x: entry.x, y: entry.y, id: entry.id });
      }
    }

    saveStates.set(name, {
      players,
      scores:        { ...gameState.scores },
      physics:       getPhysics(),
      matchSettings: { ...gameState.matchSettings },
      switches:      JSON.parse(JSON.stringify(gameState.switches)),
      portals:       JSON.parse(JSON.stringify(gameState.portals)),
      tileOverrides: JSON.parse(JSON.stringify(gameState.tileOverrides)),
      wells:         JSON.parse(JSON.stringify(gameState.wells)),
      powerupPads,
    });

    emitter.emit('saveStatesChanged', listSaveStates());
    return true;
  }

  function restoreSaveState(name) {
    const saved = saveStates.get(name);
    if (!saved) return false;

    // Settings first - bodies need correct physics before repositioning,
    // same ordering movePlayers/step already relies on every tick.
    updatePhysics(saved.physics);
    gameState.matchSettings = validateSettings(saved.matchSettings, gameState.matchSettings);

    for (const player of gameState.players) gameHelpers.returnFlag(player);

    for (const savedPlayer of saved.players) {
      const player = gameState.getPlayer(savedPlayer.id);
      if (!player || !player.body) continue; // disconnected since the save - nothing to restore onto

      physicsWorld.setPosition(player.body, savedPlayer.x, savedPlayer.y);
      physicsWorld.setVelocity(player.body, savedPlayer.lx, savedPlayer.ly);
      player.body.SetAngle(savedPlayer.a);
      player.body.SetAngularVelocity(0);
      physicsWorld.setSensor(player.body, savedPlayer.dead);

      player.x = savedPlayer.x; player.y = savedPlayer.y; player.a = savedPlayer.a;
      player.lx = savedPlayer.lx; player.ly = savedPlayer.ly;
      player.dead = savedPlayer.dead;
      player.snapCount = (player.snapCount || 0) + 1;
      emitter.emit('update', player);
    }

    gameState.scores        = { ...saved.scores };
    gameState.switches      = JSON.parse(JSON.stringify(saved.switches));
    gameState.portals       = JSON.parse(JSON.stringify(saved.portals));
    gameState.tileOverrides = JSON.parse(JSON.stringify(saved.tileOverrides));
    gameState.wells         = JSON.parse(JSON.stringify(saved.wells));

    // Pad tile ids restore directly; their pending respawn timers don't -
    // not easily serializable, so anything restored to empty just gets a
    // fresh spawn armed the same way a match reset already does, instead
    // of trying to replay the exact countdown that was left mid-flight.
    for (const pad of saved.powerupPads) gameHelpers.scheduleTileChange(pad.x, pad.y, pad.id);
    gameHelpers.scheduleAllPowerupSpawns();

    emitter.emit('score', gameState.scores);
    emitter.emit('matchStateChanged');
    return true;
  }

  function deleteSaveState(name) {
    const existed = saveStates.delete(name);
    if (existed) emitter.emit('saveStatesChanged', listSaveStates());
    return existed;
  }

  return {
    startMatch,
    endMatch,
    pauseMatch,
    resumeMatch,
    resetMatch,
    updateSettings,
    updatePhysics,
    updatePlayerPhysics,
    getPhysics,
    getPhysicsDefaults,
    getPhysicsCategories,
    getPhysicsSchemaMeta,
    getMatchSchemaMeta,
    getPlayerPhysics,
    getPlayerKeys: () => PLAYER_KEYS,
    updateTileSettings,
    getTileKeys: () => TILE_KEYS,
    listSaveStates,
    captureSaveState,
    restoreSaveState,
    deleteSaveState,
    setProfile,
    getProfiles,
    tick,
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createMatchManager;
if (typeof globalThis !== 'undefined') globalThis.createMatchManager = createMatchManager;
})();
