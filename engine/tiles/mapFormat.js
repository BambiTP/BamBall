(function () {
// mapFormat.js - the canonical stored-map document, and how it becomes the
// runtime structures the engine actually reads.
//
// A stored map is plain JSON: a grid of tile ids plus the wiring/metadata
// that can't be derived from the grid. Everything that CAN be derived -
// the wall map, gravity well positions, the expanded spawn pool - is built
// by toRuntime() at load time and never stored, so a map document stays
// small and, more importantly, stays correct when the rules for deriving
// those change.
//
// Why a tile-id grid rather than TagPro's colour-coded PNG: a colour map
// can only express tiles that have been assigned a hex colour, which makes
// player-authored custom tiles (arbitrary database row ids, added at
// runtime) unrepresentable. Ids have no such ceiling - a new tile type
// needs no format change at all, which is the whole point of storing maps
// here instead of leaning on Fortunate Maps.
//
// Fortunate Maps stays a supported SOURCE: tiles/mapLoader.js decodes a
// PNG+JSON pair into one of these documents on import, after which the map
// is ours and the origin is just provenance (doc.source).

const { tileToWorld } = (typeof require === 'function') ? require('../coords') : globalThis.Coords;

const FORMAT_VERSION = 1;

// Wall ids: the full square plus the four 45-degree corner wedges. These
// feed wallMap, which physicsWorld.buildWalls consumes - a tile is a wall
// for collision purposes exactly when it's in here.
const WALL_IDS = [1, 1.1, 1.2, 1.3, 1.4];

const FLOOR_ID         = 2;
const GRAVITY_WELL_ID  = 22;
const RED_FLAG_ID      = 3;
const BLUE_FLAG_ID     = 4;

// Guard rails, not gameplay limits: a map far outside these is a bug or an
// attempt to make the server allocate an enormous grid.
const MAX_DIMENSION = 500;

function isWallId(id) {
  return WALL_IDS.indexOf(id) !== -1;
}

function createEmptyDocument({ width = 40, height = 40, name = 'Untitled', author = null } = {}) {
  const w = clampDimension(width);
  const h = clampDimension(height);
  const tiles = [];
  for (let row = 0; row < h; row++) {
    tiles[row] = new Array(w).fill(0);
  }
  return {
    formatVersion: FORMAT_VERSION,
    name, author,
    width: w, height: h,
    tiles,
    portals:     {},
    switches:    {},
    fields:      {},
    spawnPoints: {},
    source:      null,
  };
}

function clampDimension(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_DIMENSION);
}

// Throws on anything structurally wrong, and returns a document that is
// safe to store and to hand to toRuntime(). Deliberately does NOT check
// tile ids against a known-tiles list: an id the server doesn't recognize
// today may be a custom tile it recognizes tomorrow, and rejecting it here
// would make the format the very bottleneck it exists to remove.
function normalizeDocument(input) {
  if (!input || typeof input !== 'object') throw new Error('map must be an object');

  const tiles = input.tiles;
  if (!Array.isArray(tiles) || !tiles.length) throw new Error('map.tiles must be a non-empty array');
  if (tiles.length > MAX_DIMENSION) throw new Error(`map height exceeds ${MAX_DIMENSION}`);

  const width = Array.isArray(tiles[0]) ? tiles[0].length : 0;
  if (!width) throw new Error('map.tiles rows must be non-empty arrays');
  if (width > MAX_DIMENSION) throw new Error(`map width exceeds ${MAX_DIMENSION}`);

  const grid = [];
  for (let row = 0; row < tiles.length; row++) {
    if (!Array.isArray(tiles[row]) || tiles[row].length !== width) {
      throw new Error('map.tiles must be rectangular');
    }
    grid[row] = [];
    for (let col = 0; col < width; col++) {
      const id = Number(tiles[row][col]);
      if (!Number.isFinite(id) || id < 0) throw new Error(`invalid tile id at ${col},${row}`);
      grid[row][col] = id;
    }
  }

  return {
    formatVersion: FORMAT_VERSION,
    name:   typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : 'Untitled',
    author: typeof input.author === 'string' && input.author.trim() ? input.author.trim().slice(0, 80) : null,
    width,
    height: grid.length,
    tiles:  grid,
    portals:     normalizeCellMap(input.portals),
    switches:    normalizeCellMap(input.switches),
    fields:      normalizeCellMap(input.fields),
    spawnPoints: normalizeSpawnPoints(input.spawnPoints),
    source:      input.source ?? null,
  };
}

// The per-cell settings maps - portals (destinations), switches (what a
// button drives), fields (gate default states and the like). Keyed "x,y",
// values passed through to clients verbatim (see game/gameState.js), so
// this only enforces the key shape and that values are objects, never
// their contents: those differ per structure and are meant to grow as new
// tile types arrive.
function normalizeCellMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^\d+,\d+$/.test(key)) continue;
    if (!entry || typeof entry !== 'object') continue;
    out[key] = entry;
  }
  return out;
}

function normalizeSpawnPoints(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const team of ['red', 'blue']) {
    const points = value[team];
    if (!Array.isArray(points)) continue;
    out[team] = points
      .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map((p) => ({
        x:      Number(p.x),
        y:      Number(p.y),
        radius: Math.max(0, Math.floor(Number(p.radius)) || 0),
        weight: Math.max(1, Math.floor(Number(p.weight)) || 1),
      }));
  }
  return out;
}

// The stored document -> what game/gameInstance.js loadMap expects. Every
// derived structure is rebuilt here rather than trusted from storage.
function toRuntime(doc) {
  const map     = doc.tiles.map((row) => row.slice());
  const wallMap = doc.tiles.map((row) => row.map((id) => (isWallId(id) ? id : 0)));

  return {
    map,
    wallMap,
    spawnPool: buildSpawnPool(doc.spawnPoints || {}, map),
    portals:   doc.portals  || {},
    switches:  doc.switches || {},
    wells:     buildWells(map),
    name:      doc.name,
    author:    doc.author,
  };
}

// Bare positions only - gameInstance.loadMap attaches the tunable
// radius/strength/falloff/mode from config, same split as spawnPool (map
// scan here) vs. portal/switch config (attached in gameInstance).
function buildWells(map) {
  const wells = [];
  for (let row = 0; row < map.length; row++) {
    for (let col = 0; col < map[row].length; col++) {
      if (map[row][col] === GRAVITY_WELL_ID) wells.push(tileToWorld(col, row));
    }
  }
  return wells;
}

// Authored spawn points are a few weighted discs; the pool is every floor
// tile they cover, repeated `weight` times so a random pick honours the
// weighting. A map with no authored points falls back to the floor around
// each team's flag, which is what most Fortunate Maps maps rely on.
function buildSpawnPool(spawnPoints, map) {
  const pool = {};

  for (const team of ['red', 'blue']) {
    const points = spawnPoints[team];

    if (points?.length) {
      pool[team] = [];
      for (const spawnPoint of points) {
        for (let deltaY = -spawnPoint.radius; deltaY <= spawnPoint.radius; deltaY++) {
          for (let deltaX = -spawnPoint.radius; deltaX <= spawnPoint.radius; deltaX++) {
            if (Math.sqrt(deltaX * deltaX + deltaY * deltaY) > spawnPoint.radius) continue;
            const tileX = Math.floor(spawnPoint.x) + deltaX;
            const tileY = Math.floor(spawnPoint.y) + deltaY;
            if (map[tileY]?.[tileX] !== FLOOR_ID) continue;
            const pos = tileToWorld(tileX, tileY);
            for (let i = 0; i < spawnPoint.weight; i++) {
              pool[team].push(pos);
            }
          }
        }
      }
    } else {
      pool[team] = spawnPoolAroundFlag(map, team === 'red' ? RED_FLAG_ID : BLUE_FLAG_ID);
    }

    // Only when the team has no flag AT ALL. A flag with no open floor
    // around it deliberately yields an empty pool instead of a fallback
    // position: game/playerLifecycle.js already refuses to spawn on an
    // empty pool and logs it, which beats dropping everyone at tile 0,0,
    // which on most maps is solid wall.
    pool[team] ??= [tileToWorld(0, 0)];
  }

  return pool;
}

// Returns null (not []) when the team has no flag on the map - the caller
// distinguishes "no flag" from "flag with nowhere to stand".
function spawnPoolAroundFlag(map, flagId) {
  for (let flagRow = 0; flagRow < map.length; flagRow++) {
    for (let flagCol = 0; flagCol < map[flagRow].length; flagCol++) {
      if (map[flagRow][flagCol] !== flagId) continue;

      const pool = [];
      for (let deltaY = -5; deltaY <= 5; deltaY++) {
        for (let deltaX = -5; deltaX <= 5; deltaX++) {
          if (Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 5) continue;
          const tileX = flagCol + deltaX;
          const tileY = flagRow + deltaY;
          if (map[tileY]?.[tileX] !== FLOOR_ID) continue;
          pool.push(tileToWorld(tileX, tileY));
        }
      }
      return pool;
    }
  }
  return null;
}

var MapFormat = {
  FORMAT_VERSION,
  WALL_IDS,
  MAX_DIMENSION,
  isWallId,
  createEmptyDocument,
  normalizeDocument,
  toRuntime,
};
if (typeof module !== 'undefined' && module.exports) module.exports = MapFormat;
if (typeof globalThis !== 'undefined') globalThis.MapFormat = MapFormat;

})();
