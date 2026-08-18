(function () {
const { playerSetting } = (typeof require === 'function') ? require('./settingsResolver') : globalThis.SettingsResolver;

// Final value of a stat: a leader's per-player override if one exists,
// otherwise the player's own base, then modifiers layered on top. accel
// stacks additively above base - real TagPro sums percentage bonuses, so
// Juke Juice + Team Tile together give a higher accel than either alone
// (1.24x + 1.48x - 1 = 1.72x base, not just the stronger of the two).
// Every other stat (maxSpeed) still takes the strongest active modifier,
// since nothing stacks maxSpeed bonuses today.
function derivedStat(player, stat) {
  const base = player.overrides[stat] ?? player.baseStats[stat];

  if (stat === 'accel') {
    let value = base;
    for (const mod of Object.values(player.modifiers)) {
      if (mod.stats.accel !== undefined) value += mod.stats.accel - base;
    }
    return value;
  }

  let value = base;
  for (const mod of Object.values(player.modifiers)) {
    if (mod.stats[stat] !== undefined) value = Math.max(value, mod.stats[stat]);
  }
  return value;
}

// Named per-player effect timer (respawn, tagpro, rollingBomb, jukeJuice),
// tracked on the player itself in player.timers instead of as one ad-hoc
// property per effect - setting a new one under the same key always clears
// whatever was running there first, and removePlayer can clear every
// effect generically instead of one clearTimeout per named property. Also
// used outside this module (powerupSpawner.js's applyJukeJuice/applyTagpro/
// applyRollingBomb) - exported standalone since they need no `this`.
function setPlayerTimer(player, key, fn, delay) {
  clearTimeout(player.timers.get(key));
  player.timers.set(key, setTimeout(fn, delay));
}

function clearPlayerTimer(player, key) {
  clearTimeout(player.timers.get(key));
  player.timers.delete(key);
}

function clearAllPlayerTimers(player) {
  for (const handle of player.timers.values()) clearTimeout(handle);
  player.timers.clear();
}

// Player spawn/respawn/pop lifecycle, the stat-modifier system backing
// derivedStat, and the friction/damping push for values Box2D bakes into
// the body at creation. Split out of gameHelpers.js (CODEBASE_AUDIT.md) -
// its methods are merged into the single gameHelpers object alongside the
// other domain modules, so `this.returnFlag(...)` etc still resolve
// against the full merged object at call time.
function makePlayerLifecycle(gameState, physicsHelpers, physicsWorld, config, emitter) {
  return {
    setPlayerTimer,
    clearPlayerTimer,
    // Exposed so callers outside this file (matchManager.resetPlayerEffects)
    // can clear a player's effect timers without keeping their own copy of
    // which named properties that used to mean.
    clearAllPlayerTimers,

    // Friction/damping are baked into the Box2D body at creation, so unlike
    // accel/maxSpeed (read live via derivedStat every tick) a change has to
    // be pushed onto the body explicitly - both a room-wide config change
    // and a per-player override change end up calling this for the
    // affected player(s), so it's the one place that computes "this
    // player's override, or the room default" for baked-in stats.
    pushPlayerBodyStats(player) {
      if (!player.body) return;
      const friction = playerSetting(player, config, 'playerFriction');
      const linear   = playerSetting(player, config, 'linearDamping');
      const angular  = playerSetting(player, config, 'angularDamping');
      physicsWorld.setFriction(player.body, friction);
      physicsWorld.setDamping(player.body, linear, angular);
    },

    // The only way stats change: add/remove named modifiers. Getters on the
    // player derive accel/maxSpeed live, so nothing is ever stale.
    addModifier(player, name, stats, duration) {
      const existing = player.modifiers[name];
      if (existing?.timer) clearTimeout(existing.timer);

      const mod = { stats };
      if (duration) {
        mod.timer = setTimeout(() => this.removeModifier(player, name), duration);
      }

      player.modifiers[name] = mod;
      emitter.emit('update', player);
    },

    removeModifier(player, name) {
      const existing = player.modifiers[name];
      if (!existing) return;
      if (existing.timer) clearTimeout(existing.timer);
      delete player.modifiers[name];
      emitter.emit('update', player);
    },

    spawnPlayer(id, team, name, authed, flairIndex) {
      const teamStr = (team === 2 || team === 'blue') ? 'blue' : 'red';
      const spawns  = gameState.spawnPool[teamStr];
      if (!spawns?.length) { console.error(`spawnPool not ready for "${teamStr}"`); return null; }

      const point  = spawns[Math.floor(Math.random() * spawns.length)];
      // categoryBits: physicsWorld.js's eggball fixture masks this out so
      // a thrown egg never physically bumps whoever's about to catch it.
      const body   = physicsWorld.createDynamicBody(point.x, point.y, {
        friction: config.playerFriction,
        categoryBits: physicsWorld.CATEGORY_PLAYER,
      });

      const player = {
        id,
        name: name ?? `Player ${id}`,
        authed: !!authed,
        // A freely-chosen index into the shared flair spritesheet (assets/
        // sprites/flair.png) - see local/flairPicker.js. Purely cosmetic,
        // never tied to TagPro account verification (unlike `authed`
        // above), so any player can pick any icon. null = no flair.
        flairIndex: (typeof flairIndex === 'number') ? flairIndex : null,
        team: teamStr,
        body,
        isPlayer: true,

        x: point.x, y: point.y,
        lx: 0, ly: 0,
        a: 0,

        left: false, right: false, up: false, down: false,
        wasUp: false, // edge-detects a fresh up-press for jump, vs. holding it
        jumpsRemaining: config.jumpCharges,

        // Per-player defaults. The room config seeds them, but each player
        // owns their copy so individuals can differ.
        baseStats: {
          accel:    config.accel,
          maxSpeed: config.maxSpeed,
        },

        // name -> { stats: { accel?, maxSpeed? }, timer? }
        modifiers: {},

        // Named effect timers (respawn, tagpro, rollingBomb, jukeJuice) -
        // see setPlayerTimer/clearPlayerTimer/clearAllPlayerTimers above.
        timers: new Map(),

        // Leader-set per-player overrides (PLAYER_KEYS subset only). Sparse -
        // a key is only present once a leader has explicitly set it for this
        // player, and only disappears via an explicit reset, not room-wide
        // physics changes or match resets.
        overrides: {},

        // Derived, never written. Highest active value wins.
        get accel()    { return derivedStat(this, 'accel'); },
        get maxSpeed() { return derivedStat(this, 'maxSpeed'); },

        frozen:        false,
        matchFrozen:   false,
        dead:          false,
        hasFlag:       false,
        hasEgg:        false,
        tagpro:        false,
        rollingBomb:   false,
        jukeJuice:     false,
        activeTeamTiles: new Map(), // "x,y" -> {accel, maxSpeed} - see game/teamTiles.js
        lastFireStep:  -Infinity,

        zoom: 1,

        // Leader edit mode: drops the normal distance-based visibility
        // check entirely (see snapshotFactory.isVisible), so a leader
        // panning/zooming anywhere on the map still gets every player's
        // position, not just what's near their own ball.
        seesAll: false,

        snapCount: 0,

        knownEntities: new Set(),
        knownPlayers:  new Set(),
      };

      body.SetUserData(player);
      gameState.addPlayer(player);
      return player;
    },

    removePlayer(id) {
      const player = gameState.removePlayer(id);
      if (!player) return;
      clearAllPlayerTimers(player);
      // Unlike a flag (several of them, one per team, a capture-based reset
      // already the norm), there's only ever one egg - a disconnect must
      // drop it free instead of leaving it permanently stuck on a player
      // object nothing can reach anymore.
      this.dropEggball(player);
      if (player.body) physicsWorld.destroyBody(player.body);
    },

    respawnPlayer(player) {
      const pool = gameState.spawnPool[player.team];
      if (!pool?.length) { console.error(`spawnPool not ready for "${player.team}"`); return; }
      const point = pool[Math.floor(Math.random() * pool.length)];

      physicsWorld.setBodyType(player.body, 'dynamic');
      physicsHelpers.unfreezePlayer(player);
      physicsWorld.setPosition(player.body, point.x, point.y);

      // A respawn is a dead stop: no carried momentum, no spin. Also zero
      // the cached lx/ly - the 'update' emit below snapshots them before
      // the next tick's syncPlayers would refresh them, so leaving stale
      // velocity here would tell every client to keep drifting.
      physicsWorld.setVelocity(player.body, 0, 0);
      player.body.SetAngularVelocity(0);
      player.lx = 0;
      player.ly = 0;

      player.x    = point.x;
      player.y    = point.y;
      player.dead = false;
      player.wasUp = false;
      player.jumpsRemaining = config.jumpCharges;
      player.snapCount = (player.snapCount || 0) + 1;
      emitter.emit('update', player);
    },

    // A rolling-bomb carrier is immune to every death cause: instead of
    // dying, the bomb detonates at full radius/strength and the powerup is
    // consumed. Returns whatever changed so the caller can emit 'update' for
    // it - either the single popped player, or the list of players caught
    // in the rolling-bomb blast.
    popPlayer(player) {
      if (!player) return null;

      // Already dead: nothing to pop. This became reachable when
      // player-vs-player pops started being deferred to after the physics
      // step (game/tiles/tileHandlers.js afterStep) - the victim now stays
      // solid and alive for the rest of the step, so two taggers touching
      // it in the same step, or a mutual pop where both sides connect, each
      // queue their own pop. Without this the second one would return the
      // flag twice, fire a second death explosion, and start a second
      // respawn timer against a player already waiting on one.
      if (player.dead) return null;

      if (player.flagGrabInvulnUntil && Date.now() < player.flagGrabInvulnUntil) {
        return null;
      }

      if (player.rollingBomb) {
        player.rollingBomb = false;
        clearPlayerTimer(player, 'rollingBomb');
        const affected = physicsHelpers.applyExplosion(
          player.x, player.y, config.bombRadius, config.bombStrength, player);
        affected.push(player);
        return affected;
      }

      player.dead = true;
      // A dead player can't stay a koth leader - clear it immediately rather
      // than waiting for the frozen body's tile contact to eventually end
      // (which only happens on respawn, well after the dot should be gone).
      player.kothLeader = false;
      this.returnFlag(player);
      this.dropEggball(player);

      // Everyone the blast shoved is returned alongside the victim, the
      // same way the rollingBomb branch above does it. Callers emit this
      // through 'update', which pushes an immediate snapshot for each
      // player in it - and the death explosion's result used to be thrown
      // away, so the balls it launched got no snapshot until the next
      // regular broadcast (gameConfig.snapshotInterval, 250ms). For a
      // quarter of a second their clients kept predicting motion the server
      // had already overruled, then jumped to catch up: the glitch around a
      // death explosion. The victim is skipped by applyExplosion itself
      // (player.dead is already true above), so it can't appear twice.
      const shoved = physicsHelpers.applyExplosion(
        player.x, player.y, config.deathExploRadius, config.deathExploStrength);

      physicsHelpers.freezePlayer(player);
      const respawnMs = playerSetting(player, config, 'playerRespawn');
      setPlayerTimer(player, 'respawn', () => this.respawnPlayer(player), respawnMs);
      return [player].concat(shoved);
    },
  };
};

var createPlayerLifecycle = makePlayerLifecycle;
// Standalone, no `this` needed - used directly by powerupSpawner.js.
createPlayerLifecycle.setPlayerTimer = setPlayerTimer;
createPlayerLifecycle.clearPlayerTimer = clearPlayerTimer;
if (typeof module !== 'undefined' && module.exports) module.exports = createPlayerLifecycle;
if (typeof globalThis !== 'undefined') globalThis.createPlayerLifecycle = createPlayerLifecycle;

})();
