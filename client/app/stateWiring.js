// stateWiring.js - binds state changes to their simulation and render
// consequences: a player appearing needs a physics body and a sprite, a
// physics setting changing needs pushing onto every live body, and so on.
//
// Shared by the game page and the map editor. Both run the same engine and
// the same renderer, so both need exactly this wiring; it used to live in
// client/game/app/bootstrap.js, which the editor can't load (that file also
// owns the game page's own boot sequence and globals).

// ---- state -> simulation/render event wiring -------------------------------

function wireGameStateEvents() {
  gameEvents.on('player:created', function (player, entity) {
    player.body = physicsWorld.createBall(entity.x, entity.y);
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
  });

  gameEvents.on('player:flagChanged', function (player) {
    if (player.hasFlag) renderer.attachFlag(player.id, player.flagId);
    else renderer.detachFlag(player.id);
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
  localSettingsEvents.on('localSettings:changed', function () {
    rebuildKeyLookup();
    if (renderer.layers) renderer.setOverlayVisible(localSettings.showDrawings);
  });
}
