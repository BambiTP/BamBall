(function () {
// packetBuilders.js - the send helper file. One function per outgoing packet
// type; each takes trusted engine data and returns the packet object.
// This is the ONLY place server->client packet shapes are defined.
// outgoing.js maps engine events to these builders and broadcasts the result.

const { DEFAULT_SETTINGS: matchSettingsDefaults } = (typeof require === 'function') ? require('./matchSettings') : globalThis.MatchSettings;

function round2(value) {
  return Math.round(value * 10000) / 10000;
}

// tileId -> category name (game/tiles/physicsData.js), for every known tile
// id. The client used to hand-maintain its own id->category-ish predicates
// (isButtonTile/isPortalTile/isGateTile/isBombTile, wall-id range checks)
// independently in several files, which could silently drift from this
// table since nothing enforced agreement. Sent once on 'joined' - a tile's
// category never changes at runtime, so it doesn't need to ride along with
// 'mapChanged' too.
function tileCategoriesOf(physicsLookup) {
  const map = {};
  for (const id in physicsLookup) map[id] = physicsLookup[id].category;
  return map;
}

function serializePlayer(player) {
  if (!player) return null;
  return {
    id:          player.id,
    team:        player.team,
    x:           player.x,
    y:           player.y,
    lx:          player.lx,
    ly:          player.ly,
    a:           player.a,
    dead:        player.dead,
    hasFlag:     !!player.hasFlag,
    tagpro:      player.tagpro,
    rollingBomb: player.rollingBomb,
    jukeJuice:   player.jukeJuice,
  };
}

const packetBuilders = {

  // The one per-client welcome packet: everything a (re)connecting client
  // needs to render the room - live state, physics + schema metadata, and
  // the full map (mapData comes from roomRegistry.getMapData, which owns
  // the map/preview extraction).
  joined(room, client, account, mapData) {
    const { gameState, matchManager } = room.instance;
    return {
      type:   'joined',
      id:     client.id,
      gameId: client.gameId,
      // 'game' or 'editor' - an editor room has no match and gives every
      // client leader powers, so the client hides the match UI entirely.
      roomKind: room.kind,
      team:   client.team,
      name:   account.display_name,
      leaderId: room.leaderId,
      // Set when this connection reclaimed an existing client (grace-period
      // reconnect) that already had a player spawned - the client should
      // treat itself as already in-game instead of waiting for 'joinedGame'.
      inGame: !!gameState.getPlayer(client.id),
      matchState:     gameState.state,
      matchSettings:  gameState.matchSettings,
      scores:         gameState.scores,
      stepCount:      gameState.stepCount,
      phaseStartStep: gameState.phaseStartStep,
      physics:           matchManager.getPhysics(),
      physicsDefaults:   matchManager.getPhysicsDefaults(),
      physicsCategories: matchManager.getPhysicsCategories(),
      settingsSchema: {
        physics: matchManager.getPhysicsSchemaMeta(),
        match:   matchManager.getMatchSchemaMeta(),
      },
      playerKeys: matchManager.getPlayerKeys(),
      tileKeys:   matchManager.getTileKeys(),
      profiles:   matchManager.getProfiles(),
      tileCategories: tileCategoriesOf(room.instance.physicsLookup),
      // Only players who actually have an override are worth sending - most
      // rooms never touch this, and a (re)connecting client needs to know
      // about every other player's overrides too, not just its own.
      playerOverrides: gameState.players.reduce(function (acc, p) {
        const overrides = matchManager.getPlayerPhysics(p);
        if (Object.keys(overrides).length) acc[p.id] = overrides;
        return acc;
      }, {}),
      matchSettingsDefaults,
      eggball: {
        carrierId: gameState.eggball.carrierId,
        x: gameState.eggball.x, y: gameState.eggball.y,
        vx: gameState.eggball.vx, vy: gameState.eggball.vy,
      },
      ...mapData,
    };
  },

  score(scores) {
    return { type: 'score', data: scores };
  },

  setTile(x, y, id) {
    return { type: 'setTile', x, y, id };
  },

  // Doesn't touch the real tile id - just tells the client what an empty
  // pad will turn into next, so it can render a translucent preview.
  // previewId: null clears the preview (e.g. every type got disabled).
  powerupPreview(x, y, previewId) {
    return { type: 'powerupPreview', x, y, previewId };
  },

  // The room's wiring, in the map JSON's own switches/portals format
  // (see gameState.js) - sent back whole after every connect-tool edit.
  connections(data) {
    return { type: 'connections', switches: data.switches, portals: data.portals };
  },

  // Editor: the whole authored spawn-point set after any edit. Small enough
  // (a handful of discs per team) that sending all of it beats diffing.
  spawnPoints(spawnPoints) {
    return { type: 'spawnPointsChanged', spawnPoints };
  },

  capture(player) {
    return { type: 'capture', data: serializePlayer(player) };
  },

  // Room-wide, not per-viewer culled like the ordinary player snapshot -
  // there's only ever one egg and every client needs to see it. carrierId
  // set means "render it at that player's own position, nothing else here
  // matters"; carrierId null + x/y/vx/vy means it's in free flight. Fired
  // on every state change (spawn/throw/catch/despawn) AND every physics
  // tick while free-flying (engine/eggballLogic.js's syncEggball), so the
  // client can extrapolate its motion the same way it already does for
  // players between updates.
  eggballChanged(egg) {
    return { type: 'eggballChanged', carrierId: egg.carrierId, x: egg.x, y: egg.y, vx: egg.vx, vy: egg.vy };
  },

  // The roster: everyone connected to the room, not just those spawned in
  // (a spectator has no gameState player at all, hence the separate inGame
  // flag rather than reusing serializePlayer here). Callers (webrtcTransport.js,
  // node-host/hostCli.js) build the player list themselves - unlike every
  // other builder above, there's no single `room.clients` shape shared
  // between the P2P host and the old server model this was ported from, so
  // this just wraps whatever list the caller already assembled.
  //
  // leader: true for the main leader (the host, always, unremovable) AND
  // any player the main leader (or another leader) has promoted - both have
  // identical admin powers (kick/mute/ban/match control), the two are only
  // distinguished by mainLeader so the UI can hide "demote" for the one
  // player nobody can demote.
  roomState(players) {
    return { type: 'roomState', players };
  },

  // wells rides along so a gravity well config change (radius/strength/
  // falloff/mode) reaches client prediction immediately instead of waiting
  // for the next map load.
  physicsChanged(settings, wells) {
    return { type: 'physicsChanged', settings, wells };
  },

  // names: every save-state slot currently held in matchManager's
  // in-memory Map, in no particular order - the client just renders the
  // list, it never needs slot contents (see local/controlPanel.js).
  saveStatesChanged(names) {
    return { type: 'saveStatesChanged', names };
  },

  // profiles: { pregame: {physics,match,mapId}, game: {physics,match,mapId} }
  // - matchManager's getProfiles(), full buckets so the Esc menu's map
  // cards/forms can show what's actually configured.
  profilesChanged(profiles) {
    return { type: 'profilesChanged', profiles };
  },

  // settings here is sparse (only PLAYER_KEYS the leader has explicitly
  // overridden for this one player) - the client already knows the
  // room-wide defaults from physicsChanged and computes the effective
  // value itself.
  playerPhysicsChanged(playerId, settings) {
    return { type: 'playerPhysicsChanged', playerId, settings };
  },

  // One cell's remaining per-tile overrides after a leader edit (or a
  // category-changing repaint) - sparse like playerPhysicsChanged: only
  // explicitly overridden keys, empty object means "back to all defaults".
  tileSettingsChanged(x, y, settings) {
    return { type: 'tileSettingsChanged', x, y, settings };
  },

  chat(data) {
    return { type: 'chat', id: data.id, name: data.name, text: data.text };
  },

  // matchStateChanged carries no payload; the builder reads the trusted
  // state machine directly, so every matchState packet is built one way.
  matchState(gameState) {
    return {
      type:           'matchState',
      state:          gameState.state,
      settings:       gameState.matchSettings,
      scores:         gameState.scores,
      stepCount:      gameState.stepCount,
      phaseStartStep: gameState.phaseStartStep,
      pausedFrom:     gameState.pausedFrom,
    };
  },

  matchEnd(data) {
    return { type: 'matchEnd', ...data };
  },

  // immediate: true for an out-of-band, event-triggered push (boost, bomb,
  // pop, teleport, ...) - see gameInstance.js's pushSnapshotsFor - so the
  // client can snap straight to it instead of easing, vs. false/omitted
  // for the routine ~250ms interval tick, which should ease smoothly.
  snapshot(delta, immediate) {
    return { type: 'snapshot', updated: delta.updated, removed: delta.removed ?? [], immediate: !!immediate };
  },

  // Sent only to the player who picked the powerup up (see outgoing.js) -
  // timerMs is the effect's duration, not a timestamp, so the client just
  // starts its own setTimeout on receipt rather than reconciling clocks.
  powerupCollected(key, timerMs) {
    return { type: 'powerupCollected', key, timerMs };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { packetBuilders, serializePlayer, tileCategoriesOf };
if (typeof globalThis !== 'undefined') {
  globalThis.packetBuilders = packetBuilders;
  globalThis.serializePlayer = serializePlayer;
  globalThis.tileCategoriesOf = tileCategoriesOf;
}
})();
