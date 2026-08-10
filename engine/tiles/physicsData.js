(function () {
var physicsData = [
  { id: 1,    name: 'Wall',              category: 'wall',            type: 'square',  size: 40, sensor: false },
  // The 45 slopes share the square wall's category so a wall->slope
  // repaint counts as same-category (keeps that cell's per-tile
  // wallFriction/wallRestitution overrides, leaderManager.setTiles).
  { id: 1.1,  name: '45TR',              category: 'wall', type: 'vector', vectors: [{ x: -0.5, y:  0.5 }, { x: -0.5, y: -0.5 }, { x:  0.5, y:  0.5 }] },
  { id: 1.2,  name: '45BL',              category: 'wall', type: 'vector', vectors: [{ x: -0.5, y: -0.5 }, { x:  0.5, y: -0.5 }, { x: -0.5, y:  0.5 }] },
  { id: 1.3,  name: '45TL',              category: 'wall', type: 'vector', vectors: [{ x:  0.5, y: -0.5 }, { x:  0.5, y:  0.5 }, { x: -0.5, y: -0.5 }] },
  { id: 1.4,  name: '45BR',              category: 'wall', type: 'vector', vectors: [{ x:  0.5, y:  0.5 }, { x: -0.5, y:  0.5 }, { x:  0.5, y: -0.5 }] },

  { id: 2,    name: 'Floor',             category: 'floor',           type: 'square',  size: 40, sensor: true  },

  { id: 3,    name: 'RedFlag',           category: 'redFlag',         type: 'circle',  size: 30, sensor: true  },
  { id: 3.1,  name: 'RedFlagTaken',      category: 'redFlag',         type: 'circle',  size: 30, sensor: true  },
  { id: 4,    name: 'BlueFlag',          category: 'blueFlag',        type: 'circle',  size: 30, sensor: true  },
  { id: 4.1,  name: 'BlueFlagTaken',     category: 'blueFlag',        type: 'circle',  size: 30, sensor: true  },
  { id: 16,   name: 'YellowFlag',        category: 'yellowFlag',      type: 'circle',  size: 30, sensor: true  },
  { id: 16.1, name: 'YellowFlagTaken',   category: 'yellowFlag',      type: 'circle',  size: 30, sensor: true  },

  { id: 17,   name: 'RedGoal',           category: 'redGoal',         type: 'square',  size: 40, sensor: true  },
  { id: 18,   name: 'BlueGoal',          category: 'blueGoal',        type: 'square',  size: 40, sensor: true  },

  { id: 5,    name: 'Boost',             category: 'boost',           type: 'circle',  size: 30, sensor: true  },
  { id: 5.1,  name: 'BoostTaken',        category: 'boost',           type: 'circle',  size: 30, sensor: true  },
  { id: 14,   name: 'RedBoost',          category: 'redBoost',        type: 'circle',  size: 30, sensor: true  },
  { id: 14.1, name: 'RedBoostTaken',     category: 'redBoost',        type: 'circle',  size: 30, sensor: true  },
  { id: 15,   name: 'BlueBoost',         category: 'blueBoost',       type: 'circle',  size: 30, sensor: true  },
  { id: 15.1, name: 'BlueBoostTaken',    category: 'blueBoost',       type: 'circle',  size: 30, sensor: true  },

  { id: 10,   name: 'Bomb',              category: 'bomb',            type: 'circle',  size: 30, sensor: true  },
  { id: 10.1, name: 'BombTaken',         category: 'bomb',            type: 'circle',  size: 30, sensor: true  },

  { id: 6,    name: 'PupEmpty',          category: 'powerup',         type: 'circle',  size: 30, sensor: true  },
  { id: 6.1,  name: 'PupJJ',             category: 'powerup',         type: 'circle',  size: 30, sensor: true  },
  { id: 6.2,  name: 'PupRB',             category: 'powerup',         type: 'circle',  size: 30, sensor: true  },
  { id: 6.3,  name: 'PupTP',             category: 'powerup',         type: 'circle',  size: 30, sensor: true  },
  { id: 6.4,  name: 'PupSpeed',          category: 'powerup',         type: 'circle',  size: 30, sensor: true  },

  { id: 7,    name: 'Spike',             category: 'spike',           type: 'circle',  size: 28, sensor: false },

  { id: 8,    name: 'Button',            category: 'button',          type: 'circle',  size: 16, sensor: true  },

  { id: 9,    name: 'EmptyGate',         category: 'emptyGate',       type: 'square',  size: 40, sensor: true  },
  { id: 9.1,  name: 'GreenGate',         category: 'greenGate',       type: 'square',  size: 40, sensor: true  },
  { id: 9.2,  name: 'RedGate',           category: 'redGate',         type: 'square',  size: 40, sensor: true  },
  { id: 9.3,  name: 'BlueGate',          category: 'blueGate',        type: 'square',  size: 40, sensor: true  },

  { id: 13,   name: 'Portal',            category: 'portal',          type: 'circle',  size: 30, sensor: true  },
  { id: 24,   name: 'RedPortal',         category: 'redPortal',       type: 'circle',  size: 30, sensor: true  },
  { id: 25,   name: 'BluePortal',        category: 'bluePortal',      type: 'circle',  size: 30, sensor: true  },

  { id: 11,   name: 'RedTeamTile',       category: 'redTeamTile',     type: 'square',  size: 40, sensor: true  },
  { id: 12,   name: 'BlueTeamTile',      category: 'blueTeamTile',    type: 'square',  size: 40, sensor: true  },
  { id: 23,   name: 'YellowTeamTile',    category: 'yellowTeamTile',  type: 'square',  size: 40, sensor: true  },

  { id: 19,   name: 'RedPotato',         category: 'redPotato',       type: 'circle',  size: 30, sensor: true  },
  { id: 20,   name: 'BluePotato',        category: 'bluePotato',      type: 'circle',  size: 30, sensor: true  },
  { id: 21,   name: 'YellowPotato',      category: 'yellowPotato',    type: 'circle',  size: 30, sensor: true  },

  { id: 22,   name: 'GravityWell',       category: 'gravityWell',     type: 'circle',  size: 30, sensor: true  },
  { id: 13.1, name: 'EmptyPortal',     category: 'portal',       type: 'circle', size: 30, sensor: true },
  { id: 24.1, name: 'EmptyPortal',     category: 'redPortal',    type: 'circle', size: 30, sensor: true },
  { id: 25.1, name: 'EmptyPortal',     category: 'bluePortal',   type: 'circle', size: 30, sensor: true },

  { id: 19.1, name: 'RedPotatoTaken',    category: 'redPotato',    type: 'circle', size: 30, sensor: true },
  { id: 20.1, name: 'BluePotatoTaken',   category: 'bluePotato',   type: 'circle', size: 30, sensor: true },
  { id: 21.1, name: 'YellowPotatoTaken', category: 'yellowPotato', type: 'circle', size: 30, sensor: true },
];

// Named tile ids, derived from physicsData's own `name` field so this can
// never drift out of sync with the data it's naming. A few names aren't
// unique (the three EmptyPortal variants) - last entry wins for those, so
// stick to physicsData/category lookups directly for anything ambiguous.
// This is only for the common case: callers that used to hardcode a numeric
// literal (bomb.id === 10, entry.id === 6, ...) can use TILE_ID.BOMB /
// TILE_ID.PUPEMPTY instead.
const TILE_ID = Object.fromEntries(physicsData.map(t => [t.name.toUpperCase(), t.id]));

physicsData.TILE_ID = TILE_ID;
if (typeof module !== 'undefined' && module.exports) module.exports = physicsData;
if (typeof globalThis !== 'undefined') globalThis.PhysicsData = physicsData;
})();
