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

// One physicsLookup entry for a leader-authored custom tile (game/
// gameInstance.js registerCustomTile) -> the shape sent to clients. Shared
// by the 'joined' snapshot (customTilesOf, below) and the live
// customTileUpsert/customTileCatalog broadcasts, so a (re)joining client
// always sees exactly what everyone else already has.
function wireCustomTile(entry) {
  return {
    id: entry.id, dbId: entry.dbId, name: entry.name,
    hitboxes: entry.hitboxes, sensor: entry.sensor, actions: entry.actions,
    spriteUrl: entry.spriteUrl ?? null,
  };
}

// Every custom tile already registered into this room's physicsLookup - a
// fresh room has none until the leader opens the Tile Creator
// (mapEditManager.listCustomTiles).
function customTilesOf(physicsLookup) {
  const tiles = [];
  for (const id in physicsLookup) {
    if (physicsLookup[id].category === 'custom') tiles.push(wireCustomTile(physicsLookup[id]));
  }
  return tiles;
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
      tileCategories: tileCategoriesOf(room.instance.physicsLookup),
      // Empty until the leader opens the Tile Creator (mapEditManager.
      // listCustomTiles) - a fresh room never eagerly loads a leader's
      // saved custom tiles, so a (re)joining client just sees none until
      // then, same as everyone else already in the room.
      customTiles: customTilesOf(room.instance.physicsLookup),
      // Only players who actually have an override are worth sending - most
      // rooms never touch this, and a (re)connecting client needs to know
      // about every other player's overrides too, not just its own.
      playerOverrides: gameState.players.reduce(function (acc, p) {
        const overrides = matchManager.getPlayerPhysics(p);
        if (Object.keys(overrides).length) acc[p.id] = overrides;
        return acc;
      }, {}),
      matchSettingsDefaults,
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

  // The roster: everyone connected to the room, not just those spawned in
  // (gameState.getPlayer only knows about spawned players, hence the
  // separate inGame flag rather than reusing serializePlayer here).
  roomState(room) {
    const players = [];
    for (const client of room.clients.values()) {
      players.push({
        id:     client.id,
        name:   client.name,
        team:   client.team,
        inGame: !!room.instance.gameState.getPlayer(client.id),
        leader: client.id === room.leaderId,
      });
    }
    return { type: 'roomState', players };
  },

  // wells rides along so a gravity well config change (radius/strength/
  // falloff/mode) reaches client prediction immediately instead of waiting
  // for the next map load.
  physicsChanged(settings, wells) {
    return { type: 'physicsChanged', settings, wells };
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

  // Paint mode (DO-NEXT-014). target is 'map' or { x, y } (a per-tile
  // overlay). seq is the sender's opaque token, echoed so it can
  // recognize its own already-drawn stroke; null for everyone-else
  // semantics is fine, they just draw it.
  overlayStroke(target, stroke, seq) {
    return { type: 'overlayStroke', target, stroke, seq };
  },

  overlayUndo(target) {
    return { type: 'overlayUndo', target };
  },

  overlayClear(target) {
    return { type: 'overlayClear', target };
  },


  // One created/edited/re-uploaded custom tile (the "tile creator").
  customTileUpsert(entry) {
    return { type: 'customTileUpsert', tile: wireCustomTile(entry) };
  },

  // The leader's whole saved catalog, sent once when they open the Tile
  // Creator (mapEditManager.listCustomTiles) rather than one packet per tile.
  customTileCatalog(entries) {
    return { type: 'customTileCatalog', tiles: entries.map(wireCustomTile) };
  },

  customTileDeleted(id) {
    return { type: 'customTileDeleted', id };
  },

  // A custom tile's 'message' action (game/tiles/customTileActions.js) -
  // same wire shape as a player chat line (id: null marks it as not from a
  // real player), so the existing chat log needs no new client code.
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

  snapshot(delta) {
    return { type: 'snapshot', updated: delta.updated, removed: delta.removed ?? [] };
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