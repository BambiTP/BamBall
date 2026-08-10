const { createDefaultSettings } = (typeof require === 'function') ? require('./matchSettings') : globalThis.MatchSettings;

class GameState {
  constructor(mode = 'game') {
    // 'game' or 'editor'. An editor room is a sandbox: no timer, no score,
    // no mercy rule, no start/end - just a map you can roll around on while
    // building it. Pause/resume/reset still work, and captures still
    // happen, they just don't count.
    this.mode       = mode;
    this.players    = [];
    this.map        = [];
    this.dataMap    = [];
    this.wallMap    = [];
    this.wells      = [];
    this.mapId      = null;
    // Where mapId refers to: 'fortunatemaps' or 'stored' (a map saved on
    // this server). Set together with mapId by loadMap.
    this.mapSource  = null;
    this.mapName    = null;
    this.mapAuthor  = null;
    this.spawnPool  = {};
    this.scores     = { red: 0, blue: 0 };
    this.state      = 'pregame';
    this.phaseStartStep = 0;
    this.stepCount  = 0;
    this.matchSettings = createDefaultSettings();
    this.pausedFrom = null;

    // Wiring, in the map JSON's own format (fortunatemaps switches/portals,
    // keyed "x,y") - loadMap stashes the fetched structures here and the
    // leader's connect tool (DO-NEXT-012) mutates them directly. This is
    // the canonical store: the whole structures are sent to clients (joined
    // payload + 'connections' broadcast), and the derived per-tile fields
    // (switchGates/destinationX/...) are kept in step by gameInstance.
    this.switches = {}; // "x,y" -> { timer, toggle: [{ pos: { x, y } }] }
    this.portals  = {}; // "x,y" -> { destination: { x, y } | null, cooldown }

    // The other two halves of the authored map document (see
    // game/tiles/mapFormat.js), kept verbatim so an editor room can save
    // the map back out. spawnPool above is DERIVED from spawnPoints and is
    // what spawning actually reads; spawnPoints is what the author drew and
    // the only one of the two that round-trips to storage.
    this.spawnPoints = {}; // { red: [{x,y,radius,weight}], blue: [...] }
    this.fields      = {}; // "x,y" -> per-tile config (gate defaultState, ...)

    // Per-tile setting overrides (DO-NEXT-013), sparse: "x,y" -> partial
    // settings object holding only tileScoped schema keys the leader has
    // overridden for that cell. Map state like switches/portals: survives
    // match resets (resetTiles never touches it), cleared by loadMap, and
    // cleared per-cell when a repaint changes the cell's tile category
    // (leaderManager.setTiles). gameHelpers.tileSetting is the read path.
    this.tileOverrides = {}; // "x,y" -> { boostCooldown: 5000, ... }

    // Paint mode (DO-NEXT-014): the full-map drawing overlay's stroke
    // log. Purely visual - never touches physics or behavior. Each
    // stroke is { points: [[px,py],...], color: '#rrggbb', size } in
    // overlay-pixel coordinates (shared/overlayCoords.js owns the
    // resolution rule). Map state like tileOverrides: survives match
    // resets, cleared by loadMap, capped by leaderManager.
    this.mapOverlayStrokes = [];

    // Per-tile drawing overlays (stage 2), sparse: "x,y" -> stroke list
    // in that cell's own 40x40 pixel space (OverlayCoords.TILE_PIXELS).
    // Cell decoration, not tile decoration - deliberately NOT cleared
    // when the cell is repainted (unlike tileOverrides), and drawn on
    // top of whatever tile sprite is there, so a future texture-pack
    // system underneath stays compatible.
    this.tileOverlayStrokes = {};
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id) ?? null;
  }

  addPlayer(player) {
    this.players.push(player);
  }

  removePlayer(id) {
    const index = this.players.findIndex(p => p.id === id);
    if (index === -1) return null;
    const player = this.players[index];
    this.players.splice(index, 1);
    return player;
  }

  getTile(x, y) {
    return this.dataMap[y]?.[x] ?? null;
  }

  setMapTile(x, y, id) {
    if (this.map[y]) this.map[y][x] = id || 0;
  }

  setDataTile(x, y, entry) {
    if (this.dataMap[y]) this.dataMap[y][x] = entry;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = GameState;
if (typeof globalThis !== 'undefined') globalThis.GameState = GameState;