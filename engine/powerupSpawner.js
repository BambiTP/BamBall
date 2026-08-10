(function () {
var POWERUP_TYPES = (typeof require === 'function') ? require('./tiles/powerupTypes') : globalThis.PowerupTypes;
const { TILE_ID }   = (typeof require === 'function') ? require('./tiles/physicsData') : globalThis.PhysicsData;
const { playerSetting } = (typeof require === 'function') ? require('./settingsResolver') : globalThis.SettingsResolver;
const { setPlayerTimer, clearPlayerTimer } = (typeof require === 'function') ? require('./playerLifecycle') : globalThis.createPlayerLifecycle;

// Powerup pad spawn/respawn cycle, koth contest tracking, and the powerup
// pickup effects (jukeJuice/tagpro/rollingBomb). Split out of
// gameHelpers.js (CODEBASE_AUDIT.md) - scheduleTimeout/scheduleTileChange/
// tileSetting are shared primitives on gameHelpers.js itself, reached here
// via `this.` since the merged gameHelpers object is what every call site
// actually calls through.
var createPowerupSpawner = function(gameState, physicsHelpers, config, emitter) {
  return {
    // Random currently-enabled powerup type, or null if every type is off.
    pickPowerupType() {
      const enabled = POWERUP_TYPES.filter(p => config[p.configKey]);
      if (!enabled.length) return null;
      return enabled[Math.floor(Math.random() * enabled.length)];
    },

    // An empty pad becomes a random *enabled* powerup after
    // config.powerupRespawn. The type is picked immediately (not at fire
    // time) and stashed on the tile as entry.previewId, broadcast via
    // 'powerupPreview' so the client can show a translucent preview of
    // what's coming - enforcePowerupToggles keeps that pick live if a
    // leader disables it before it actually spawns. If nothing is enabled
    // yet, it keeps retrying every interval instead of going permanently
    // empty and un-armed.
    //
    // holdoverId: the id of the player who just consumed the previous pickup
    // and may still be standing on the pad, right into this new empty cycle.
    // Since powerup pads reuse the same Box2D body across state changes
    // (gameInstance's REUSABLE_CATEGORIES), that player's contact never
    // re-fires BeginContact, so entry.contestants has to be seeded with them
    // by hand or koth mode would never see them as a contestant.
    schedulePowerupSpawn(x, y, holdoverId) {
      const entry = gameState.getTile(x, y);
      if (!entry) return;

      entry.contestants = holdoverId != null ? [holdoverId] : [];
      this.updateKothLeader(entry);

      const type = this.pickPowerupType();
      entry.previewId = type ? type.id : null;
      emitter.emit('powerupPreview', x, y, entry.previewId);

      this.scheduleTimeout(() => {
        if (entry.previewId == null) {
          this.schedulePowerupSpawn(x, y);
          return;
        }
        const id = entry.previewId;
        entry.previewId = null;
        this.scheduleTileChange(x, y, id).then(() => {
          if (!config.kothPowerup) return;
          const winner = (entry.contestants ?? [])
            .map(pid => gameState.getPlayer(pid))
            .find(p => p && !p.dead);
          if (winner) emitter.emit('powerupClaim', winner, entry);
        });
      }, this.tileSetting(x, y, 'powerupRespawn'));
    },

    // koth mode: called on begin/end contact with an empty (not-yet-spawned)
    // powerup pad to track who's been waiting on it, in arrival order, so
    // schedulePowerupSpawn can award the pad to whoever's held it longest
    // instead of requiring a fresh touch after it spawns.
    pupContestBegin(player, tile) {
      if (!tile.contestants) tile.contestants = [];
      if (!tile.contestants.includes(player.id)) tile.contestants.push(player.id);
      this.updateKothLeader(tile);
    },

    pupContestEnd(player, tile) {
      if (!tile.contestants) return;
      tile.contestants = tile.contestants.filter(id => id !== player.id);
      this.updateKothLeader(tile);
    },

    // Whoever's first (in arrival order) among a pad's live contestants is
    // the one schedulePowerupSpawn will award it to - that's who the client
    // shows a "currently winning" indicator for. Only fires an 'update' for
    // the players whose leader status actually flipped.
    updateKothLeader(tile) {
      const leader = (tile.contestants ?? [])
        .map(pid => gameState.getPlayer(pid))
        .find(p => p && !p.dead) || null;
      const leaderId = leader ? leader.id : null;
      if (tile.kothLeaderId === leaderId) return;

      const changed = [];
      if (tile.kothLeaderId != null) {
        const prev = gameState.getPlayer(tile.kothLeaderId);
        if (prev) {
          prev.kothLeader = false;
          changed.push(prev);
        }
      }
      if (leader) {
        leader.kothLeader = true;
        changed.push(leader);
      }

      tile.kothLeaderId = leaderId;
      if (changed.length) emitter.emit('update', changed);
    },

    // Reacts to a group-setting toggle:
    //  - an active pad whose type just got disabled is replaced right away
    //    with a different enabled type (or emptied + re-armed if none are
    //    enabled) instead of waiting out a full respawn cycle.
    //  - an empty pad already previewing a type that just got disabled gets
    //    a fresh pick so the preview (and the pad it eventually becomes)
    //    stays truthful.
    enforcePowerupToggles() {
      for (const row of gameState.dataMap) {
        for (const entry of row ?? []) {
          if (!entry || entry.category !== 'powerup') continue;

          if (entry.id !== TILE_ID.PUPEMPTY) {
            const type = POWERUP_TYPES.find(p => p.id === entry.id);
            if (!type || config[type.configKey]) continue;

            const replacement = this.pickPowerupType();
            if (replacement) {
              this.scheduleTileChange(entry.x, entry.y, replacement.id);
            } else {
              const x = entry.x, y = entry.y;
              this.scheduleTileChange(x, y, TILE_ID.PUPEMPTY).then(() => this.schedulePowerupSpawn(x, y));
            }
            continue;
          }

          if (entry.previewId == null) continue;
          const previewType = POWERUP_TYPES.find(p => p.id === entry.previewId);
          if (previewType && !config[previewType.configKey]) {
            const replacement = this.pickPowerupType();
            entry.previewId = replacement ? replacement.id : null;
            emitter.emit('powerupPreview', entry.x, entry.y, entry.previewId);
          }
        }
      }
    },

    // Arms the first spawn for every currently-empty powerup pad on the map.
    // Needed after map load (pregame has no pickups yet to trigger the
    // cycle) and after resetElements() restores every pad to empty and
    // wipes the old timers - without this, pads would stay empty forever
    // once a match starts or resets.
    scheduleAllPowerupSpawns() {
      for (const row of gameState.dataMap) {
        for (const entry of row ?? []) {
          if (entry?.category === 'powerup' && entry.id === TILE_ID.PUPEMPTY) {
            this.schedulePowerupSpawn(entry.x, entry.y);
          }
        }
      }
    },

    applyJukeJuice(player) {
      const timerMs = playerSetting(player, config, 'jukeJuiceTimer');
      player.jukeJuice = true;
      setPlayerTimer(player, 'jukeJuiceFlag', () => { player.jukeJuice = false; }, timerMs);
      this.addModifier(player, 'jukeJuice', {
        accel:    config.jukeJuiceAccel,
        maxSpeed: config.jukeJuiceMaxSpeed,
      }, timerMs);
      emitter.emit('powerupCollected', player.id, 'jj', timerMs);
    },

    applyTagpro(player) {
      const timerMs = playerSetting(player, config, 'tagproTimer');
      player.tagpro = true;
      setPlayerTimer(player, 'tagpro', () => { player.tagpro = false; }, timerMs);
      emitter.emit('powerupCollected', player.id, 'tp', timerMs);
    },

    // Voluntary detonation (spacebar): unlike popPlayer's rollingBomb branch,
    // the carrier chose this and doesn't die or get shoved by their own
    // blast - only everyone else in radius does, hence the exclude arg and
    // the weaker rollingBombRadius/Strength tuning instead of the lethal
    // bombRadius/Strength used when a carrier dies.
    detonateRollingBomb(player) {
      if (!player || !player.rollingBomb) return null;
      player.rollingBomb = false;
      clearPlayerTimer(player, 'rollingBomb');
      return physicsHelpers.applyExplosion(
        player.x, player.y, config.rollingBombRadius, config.rollingBombStrength, player);
    },

    applyRollingBomb(player) {
      const timerMs = playerSetting(player, config, 'rollingBombTimer');
      player.rollingBomb = true;
      setPlayerTimer(player, 'rollingBomb', () => { player.rollingBomb = false; }, timerMs);
      emitter.emit('powerupCollected', player.id, 'rb', timerMs);
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createPowerupSpawner;
if (typeof globalThis !== 'undefined') globalThis.createPowerupSpawner = createPowerupSpawner;

})();
