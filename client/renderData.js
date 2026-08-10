const WALL_SOLIDS = {
  '1'  : 0xff,
  '1.1': 0xb4,
  '1.2': 0xd2,
  '1.3': 0x4b,
  '1.4': 0x2d,
};

const renderData = [
{ id: 1,    name: 'wall',             image: 'tiles',       x: null, y: null, size: 40, layer: 'background', hasBackground: false },
{ id: 1.1,  name: '45BL',             image: 'tiles',       x: null, y: null, size: 40, layer: 'background', hasBackground: false },
{ id: 1.2,  name: '45TL',             image: 'tiles',       x: null, y: null, size: 40, layer: 'background', hasBackground: false },
{ id: 1.3,  name: '45TR',             image: 'tiles',       x: null, y: null, size: 40, layer: 'background', hasBackground: false },
{ id: 1.4,  name: '45BR',             image: 'tiles',       x: null, y: null, size: 40, layer: 'background', hasBackground: false },

{ id: 2,    name: 'floor',            image: 'tiles',       x: 13,   y: 4,    size: 40, layer: 'background', hasBackground: false },
{ id: 7,    name: 'spike',            image: 'tiles',       x: 12,   y: 0,    size: 40, layer: 'background', hasBackground: true  },
{ id: 8,    name: 'button',           image: 'tiles',       x: 13,   y: 6,    size: 40, layer: 'background', hasBackground: true  },
{ id: 11,   name: 'redTeamTile',      image: 'tiles',       x: 14,   y: 4,    size: 40, layer: 'background', hasBackground: false },
{ id: 12,   name: 'blueTeamTile',     image: 'tiles',       x: 15,   y: 4,    size: 40, layer: 'background', hasBackground: false },
{ id: 23,   name: 'yellowTeamTile',   image: 'tiles',       x: 13,   y: 5,    size: 40, layer: 'background', hasBackground: false },

{ id: 16,   name: 'yellowFlag',       image: 'tiles',       x: 13,   y: 1,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 16.1, name: 'yellowFlagTaken',  image: 'tiles',       x: 13,   y: 2,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 3,    name: 'redFlag',          image: 'tiles',       x: 14,   y: 1,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 3.1,  name: 'redFlagTaken',     image: 'tiles',       x: 14,   y: 2,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 4,    name: 'blueFlag',         image: 'tiles',       x: 15,   y: 1,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 4.1,  name: 'blueFlagTaken',    image: 'tiles',       x: 15,   y: 2,    size: 40, layer: 'dynamic',    hasBackground: true  },

{ id: 5,    name: 'yellowBoost',      image: 'speedpad',    x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 5.1,  name: 'yellowBoostTaken', image: 'speedpad',    x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 14,   name: 'redBoost',         image: 'speedpadRed', x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 14.1, name: 'redBoostTaken',    image: 'speedpadRed', x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 15,   name: 'blueBoost',        image: 'speedpadBlue',x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 15.1, name: 'blueBoostTaken',   image: 'speedpadBlue',x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },

{ id: 6,    name: 'emptyPup',         image: 'tiles',       x: 12,   y: 8,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 6.1,  name: 'jukeJuice',        image: 'tiles',       x: 12,   y: 4,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 6.2,  name: 'rollingBomb',      image: 'tiles',       x: 12,   y: 5,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 6.3,  name: 'tagpro',           image: 'tiles',       x: 12,   y: 6,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 6.4,  name: 'speed',            image: 'tiles',       x: 12,   y: 7,    size: 40, layer: 'dynamic',    hasBackground: true  },

{ id: 17,   name: 'redGoal',          image: 'tiles',       x: 14,   y: 5,    size: 40, layer: 'background',    hasBackground: false },
{ id: 18,   name: 'blueGoal',         image: 'tiles',       x: 15,   y: 5,    size: 40, layer: 'background',    hasBackground: false },

{ id: 9,    name: 'emptyGate',        image: 'tiles',       x: 12,   y: 3,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 9.1,  name: 'greenGate',        image: 'tiles',       x: 13,   y: 3,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 9.2,  name: 'redGate',          image: 'tiles',       x: 14,   y: 3,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 9.3,  name: 'blueGate',         image: 'tiles',       x: 15,   y: 3,    size: 40, layer: 'dynamic',    hasBackground: true },

{ id: 10,   name: 'bomb',             image: 'tiles',       x: 12,   y: 1,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 10.1, name: 'emptyBomb',        image: 'tiles',       x: 12,   y: 2,    size: 40, layer: 'dynamic',    hasBackground: true  },

{ id: 21,   name: 'yellowPotato',     image: 'tiles',       x: 14,   y: 6,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 21.1, name: 'yellowPotatoTaken',image: 'tiles',       x: 15,   y: 6,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 19,   name: 'redPotato',        image: 'tiles',       x: 14,   y: 7,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 19.1, name: 'redPotatoTaken',   image: 'tiles',       x: 15,   y: 7,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 20,   name: 'bluePotato',       image: 'tiles',       x: 14,   y: 8,    size: 40, layer: 'dynamic',    hasBackground: true  },
{ id: 20.1, name: 'bluePotatoTaken',  image: 'tiles',       x: 15,   y: 8,    size: 40, layer: 'dynamic',    hasBackground: true  },

{ id: 22,   name: 'gravityWell',      image: 'gravitywell', x: 0,    y: 0,    size: 40, layer: 'static',    hasBackground: true  },

{ id: 'redball',  name: 'redBall',    image: 'tiles',       x: 14,   y: 0,    size: 40, layer: 'dynamic',    hasBackground: false },
{ id: 'blueball', name: 'blueBall',   image: 'tiles',       x: 15,   y: 0,    size: 40, layer: 'dynamic',    hasBackground: false },

{ id: 'marsball', name: 'marsBall',   image: 'tiles',       x: 12,   y: 9,    size: 80, layer: 'dynamic',    hasBackground: false },

{ id: 13,   name: 'portal',          image: 'portal',      x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 24,   name: 'redPortal',       image: 'portalRed',   x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 25,   name: 'bluePortal',      image: 'portalBlue',  x: 0,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
// Exit portals share one look regardless of which color portal they came
// from (owner direction 2026-07-11) - all three ids point at the same
// frame in the base (uncolored) portal sheet.
{ id: 13.1, name: 'emptyPortal',     image: 'portal',      x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 24.1, name: 'emptyPortal',     image: 'portal',      x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
{ id: 25.1, name: 'emptyPortal',     image: 'portal',      x: 4,    y: 0,    size: 40, layer: 'dynamic',    hasBackground: true },
]

// Groups of tile ids that are really just runtime states of the SAME
// placed cell (e.g. a flag flips between its ground id and its "taken"
// id as it's picked up/returned - gameInstance.setTile mutates the map's
// stored id in place, see WALL_SOLIDS comment above for the wall-corner
// equivalent). The Cell Texture panel (ui.js buildTileTextureSection)
// shows one picker per id in a tile's family instead of just whichever
// state happens to be live when the leader right-clicks, so "Flag Taken"
// or "Bomb Taken" can be customized without catching the tile mid-state.
// Carried-flag ids (3.2/4.2/16.2, server/db.js CARRIED_FLAG_TILE_NAMES)
// ride along in the flag's own family since they're the same visual
// concept (this flag, a different state) even though they're never
// actually placed on the map.
const TILE_STATE_FAMILIES = [
  [3, 3.1, 3.2],      // red flag / taken / carried
  [4, 4.1, 4.2],      // blue flag / taken / carried
  [16, 16.1, 16.2],   // yellow flag / taken / carried
  [5, 5.1],           // yellow boost / taken
  [14, 14.1],         // red boost / taken
  [15, 15.1],         // blue boost / taken
  [6, 6.1, 6.2, 6.3, 6.4], // pup pad: empty / juke juice / rolling bomb / tagpro / speed
  [9, 9.1, 9.2, 9.3], // gate: empty / green / red / blue
  [10, 10.1],         // bomb / taken (empty)
  [21, 21.1],         // yellow potato / taken
  [19, 19.1],         // red potato / taken
  [20, 20.1],         // blue potato / taken
  [13, 13.1],         // portal / empty
  [24, 24.1],         // red portal / empty
  [25, 25.1],         // blue portal / empty
];

const TILE_STATE_FAMILY_BY_ID = {};
for (const family of TILE_STATE_FAMILIES) {
  for (const id of family) TILE_STATE_FAMILY_BY_ID[id] = family;
}

// Every id in the same family as `id`, in family order - just [id] for a
// tile with no states of its own (floor, wall, spike, goals, ...).
function tileStateFamily(id) {
  return TILE_STATE_FAMILY_BY_ID[id] ?? [id];
}

// Carried-flag ids (server/db.js CARRIED_FLAG_TILE_NAMES) are synthetic -
// never placed on the map, so they have no renderData entry to read a
// name from - labeled here instead.
const TILE_STATE_LABEL_OVERRIDES = {
  3.2:  'Red Flag Carried',
  4.2:  'Blue Flag Carried',
  16.2: 'Yellow Flag Carried',
  walls: 'Walls', // sentinel state id (server/db.js WALLS_TILE_ID), no renderData entry
};

// "redFlagTaken" -> "Red Flag Taken" - camelCase renderData name, spaced
// and capitalized. Falls back to the override map above for synthetic ids.
function tileStateLabel(id) {
  if (TILE_STATE_LABEL_OVERRIDES[id]) return TILE_STATE_LABEL_OVERRIDES[id];
  var entry = renderData.find(function (e) { return e.id === id; });
  if (!entry) return String(id);
  var spaced = entry.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}