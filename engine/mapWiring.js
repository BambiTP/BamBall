(function () {
const { TILE_ID }   = (typeof require === 'function') ? require('./tiles/physicsData') : globalThis.PhysicsData;
const { tileToWorld } = (typeof require === 'function') ? require('./coords') : globalThis.Coords;

// ---- connect tool (DO-NEXT-012) -----------------------------------------
// Leader-edited connections write directly into gameState.switches /
// gameState.portals - the same "x,y"-keyed structures the map JSON
// arrives in - and the derived per-tile fields applySwitchData/
// applyPortalData attach are kept in step with the same field math.
// Methods throw on invalid input; leaderManager turns that into an
// error packet. Every successful change emits 'connectionsChanged' with
// the raw structures so outgoing.js can send them back to the room.
//
// Extracted out of gameInstance.js (CODEBASE_AUDIT.md) - map load
// (loadMap/changeTiles) calls applyPortalData/applySwitchData/
// normalizePortals/severTileConnections/initPaintedPortal here; the packet
// layer (mapEditManager) calls setTileConnection/clearTileConnections
// through the thin delegating methods gameInstance.js still exposes.

// Category groupings the connect tool needs (physicsData gives each
// gate state its own category; portals share one per color).
const GATE_CATEGORIES   = ['emptyGate', 'greenGate', 'redGate', 'blueGate'];
const PORTAL_CATEGORIES = ['portal', 'redPortal', 'bluePortal'];

// A portal's id doubles as its "has a destination" flag (mapLoader bakes
// base vs base+0.1 the same way at load time).
const PORTAL_BASE_ID = { portal: 13, redPortal: 24, bluePortal: 25 };

var createMapWiring = function(gameState, gameHelpers, physicsLookup, emitter) {
  const mapWiring = {
    GATE_CATEGORIES,
    PORTAL_CATEGORIES,

    getConnectionData() {
      return {
        switches: gameState.switches,
        portals:  gameState.portals,
      };
    },

    // Dispatch by what the source tile actually is - the client never gets
    // to claim which kind of connection it's making.
    setTileConnection(sx, sy, tx, ty, action) {
      const source = gameState.getTile(sx, sy);
      if (source?.category === 'button') {
        mapWiring.setButtonConnection(sx, sy, tx, ty, action);
        return;
      }
      if (PORTAL_CATEGORIES.includes(source?.category)) {
        mapWiring.setPortalConnection(sx, sy, tx, ty, action);
        return;
      }
      throw new Error('source is not a button or portal');
    },

    setButtonConnection(sx, sy, tx, ty, action) {
      const button = gameState.getTile(sx, sy);
      const target = gameState.getTile(tx, ty);
      const isGate = GATE_CATEGORIES.includes(target?.category);
      const isBomb = target?.category === 'bomb';
      if (!isGate && !isBomb) throw new Error('target is not a gate or bomb');

      const key  = `${sx},${sy}`;
      const data = gameState.switches[key] ??= { timer: 0, toggle: [] };
      data.toggle ??= []; // map JSON entries normally have it, but don't trust that
      const wired = data.toggle.some(t => t.pos.x === tx && t.pos.y === ty);

      // A palette-painted button (DO-NEXT-011) never went through
      // applySwitchData, so its derived fields start life here.
      button.switchTimer ??= data.timer ?? 0;
      button.switchGates ??= [];
      button.switchBombs ??= [];

      if (action === 'add' && !wired) {
        data.toggle.push({ pos: { x: tx, y: ty } });
        if (isBomb) {
          button.switchBombs.push({ x: tx, y: ty });
        } else {
          button.switchGates.push({ x: tx, y: ty });
          // Same lazy init applySwitchData does - a gate only grows its
          // toggle-state fields once something actually controls it.
          if (target.defaultState === undefined) {
            target.defaultState  = target.id;
            target.currentState  = target.id;
            target.red           = 0;
            target.blue          = 0;
            target.stickyHandler = null;
            target.controllingButtons = [];
          }
          target.controllingButtons.push({ x: sx, y: sy });
        }
      } else if (action === 'remove' && wired) {
        mapWiring.removeButtonConnection(sx, sy, tx, ty);
      } else {
        return; // already wired / already unwired - nothing changed
      }

      emitter.emit('connectionsChanged', mapWiring.getConnectionData());
    },

    // destination === null is the ONLY "exit portal" (no outgoing wire)
    // state. destination === self (its own coordinates) is an ordinary
    // ACTIVE portal that happens to target itself - distinct from exit,
    // and harmless to step through (teleports to the same spot). 'add'
    // sets a real destination (self included); 'remove' clears it to the
    // true exit state. This is the only place either transition happens.
    setPortalConnection(sx, sy, tx, ty, action) {
      const source = gameState.getTile(sx, sy);
      const target = gameState.getTile(tx, ty);
      if (!PORTAL_CATEGORIES.includes(target?.category)) {
        throw new Error('target is not a portal');
      }

      const key  = `${sx},${sy}`;
      const data = gameState.portals[key] ??= { destination: null, cooldown: 0 };
      const isDest = data.destination?.x === tx && data.destination?.y === ty;

      if (action === 'add' && !isDest) {
        data.destination = { x: tx, y: ty };
      } else if (action === 'remove' && isDest) {
        data.destination = null;
      } else {
        return; // nothing changed
      }

      // Reuse the load-time appliers so the derived entry fields can never
      // disagree with what a fresh map load would produce, then flip the
      // portal's id (base <-> base+0.1) to match its new wired state.
      mapWiring.applyPortalData({ [key]: data });
      mapWiring.syncPortalId(source);

      emitter.emit('connectionsChanged', mapWiring.getConnectionData());
    },

    // Structure + entry mutation for one button->target unlink, shared by
    // setButtonConnection and the right-click clear. No validation and no
    // broadcast - callers own both.
    removeButtonConnection(bx, by, tx, ty) {
      const data = gameState.switches[`${bx},${by}`];
      if (data) {
        data.toggle = (data.toggle ?? []).filter(t => t.pos.x !== tx || t.pos.y !== ty);
      }

      const button = gameState.getTile(bx, by);
      if (button) {
        button.switchGates = (button.switchGates ?? []).filter(c => c.x !== tx || c.y !== ty);
        button.switchBombs = (button.switchBombs ?? []).filter(c => c.x !== tx || c.y !== ty);
      }

      const target = gameState.getTile(tx, ty);
      if (target?.controllingButtons) {
        target.controllingButtons = target.controllingButtons.filter(c => c.x !== bx || c.y !== by);
        // Last controller gone: put the gate back to its default state now,
        // or a press count left behind by whoever is standing on the button
        // (buttonEnd will never see this gate again) would hold the gate in
        // its pressed color until the next match reset.
        if (!target.controllingButtons.length) {
          if (target.stickyHandler) {
            gameHelpers.cancelTimeout(target.stickyHandler);
            target.stickyHandler = null;
          }
          target.red  = 0;
          target.blue = 0;
          target.currentState = target.defaultState;
          if (target.id !== target.defaultState) {
            emitter.emit('setTile', tx, ty, target.defaultState);
          }
        }
      }
    },

    // Right-click in connect mode: strip every connection involving this
    // tile, in both directions - a button's toggles, every button toggling
    // this gate/bomb, the portal's own destination, and every portal
    // leading here. This is the ONLY way connections are removed; clicking
    // in connect mode only ever adds.
    clearTileConnections(x, y) {
      const entry = gameState.getTile(x, y);
      if (!entry) throw new Error('no tile there');

      const key   = `${x},${y}`;
      let changed = false;

      // Outgoing: this button's toggles.
      const own = gameState.switches[key];
      if (own && (own.toggle ?? []).length) {
        for (const t of [...own.toggle]) {
          mapWiring.removeButtonConnection(x, y, t.pos.x, t.pos.y);
        }
        changed = true;
      }

      // Incoming: every button toggling this tile.
      for (const [bKey, bData] of Object.entries(gameState.switches)) {
        if (!(bData.toggle ?? []).some(t => t.pos.x === x && t.pos.y === y)) continue;
        const [bx, by] = bKey.split(',').map(Number);
        mapWiring.removeButtonConnection(bx, by, x, y);
        changed = true;
      }

      // Outgoing: this portal's destination - back to the self-connected
      // state (still ACTIVE, not exit - clearing a wire changes what it
      // points at, not whether it's wired at all).
      const own_pd = gameState.portals[key];
      if (own_pd?.destination && (own_pd.destination.x !== x || own_pd.destination.y !== y)) {
        own_pd.destination = { x, y };
        mapWiring.applyPortalData({ [key]: own_pd });
        mapWiring.syncPortalId(entry);
        changed = true;
      }

      // Incoming: every portal leading here becomes self-connected too
      // (active, not exit - same reasoning as the outgoing case above).
      for (const [pKey, pData] of Object.entries(gameState.portals)) {
        if (pKey === key) continue;
        if (pData.destination?.x !== x || pData.destination?.y !== y) continue;
        const [px, py] = pKey.split(',').map(Number);
        pData.destination = { x: px, y: py };
        mapWiring.applyPortalData({ [pKey]: pData });
        const pEntry = gameState.getTile(px, py);
        if (pEntry) mapWiring.syncPortalId(pEntry);
        changed = true;
      }

      if (changed) {
        emitter.emit('connectionsChanged', mapWiring.getConnectionData());
      }
    },

    syncPortalId(entry) {
      const base = PORTAL_BASE_ID[entry.category];
      // The ONLY source of truth for exit-vs-active: the raw stored
      // destination in gameState.portals. entry.destinationTileX/Y are NOT
      // usable here - applyPortalData always resolves them to a self
      // fallback (even for a true exit portal, so a step-in has somewhere
      // harmless to teleport to), so they can never distinguish "really
      // has no destination" from "was explicitly wired to itself".
      const data    = gameState.portals[`${entry.x},${entry.y}`];
      const isExit  = !data || data.destination == null;
      const desired = isExit ? base + 0.1 : base;
      if (gameState.map[entry.y][entry.x] !== desired) {
        emitter.emit('setTile', entry.x, entry.y, desired);
      }
      // initialMap too, or a match reset would flip the portal back to the
      // wired/unwired art (and behavior - tileLogic dispatches on the name)
      // it had at map load.
      gameState.initialMap[entry.y][entry.x] = desired;
    },

    // Map edit mode painting over a wired tile severs its connections, on
    // both sides, and strips the derived fields off the old entry so
    // setTile's PERSISTENT_TILE_KEYS copy can't resurrect them onto the new
    // tile (the ghost-reconnect problem in DO-NEXT-012). Called by
    // gameInstance.changeTiles before the repaint; returns true if the
    // switches/portals structures changed so one 'connections' broadcast
    // can cover a whole stroke. Portals pointing AT a removed portal keep
    // their destination - it's a position, not a tile reference, exactly
    // like the map JSON.
    severTileConnections(x, y, newId) {
      const entry = gameState.getTile(x, y);
      if (!entry) return false;

      const key     = `${x},${y}`;
      const newCat  = physicsLookup[newId]?.category ?? 'none';
      let   changed = false;

      // Button replaced: drop its switch entry and detach from its gates.
      if (entry.category === 'button' && newCat !== 'button') {
        if (gameState.switches[key]) {
          delete gameState.switches[key];
          changed = true;
        }
        for (const { x: gx, y: gy } of entry.switchGates ?? []) {
          const gate = gameState.getTile(gx, gy);
          if (gate?.controllingButtons) {
            gate.controllingButtons = gate.controllingButtons.filter(c => c.x !== x || c.y !== y);
          }
        }
        delete entry.switchTimer;
        delete entry.switchGates;
        delete entry.switchBombs;
      }

      const wasGate   = GATE_CATEGORIES.includes(entry.category);
      const staysGate = GATE_CATEGORIES.includes(newCat);
      const wasBomb   = entry.category === 'bomb';

      // Gate repainted as another gate keeps its wiring but adopts the new
      // id as its resting state - otherwise the sticky timer would restore
      // the pre-repaint color.
      if (wasGate && staysGate && entry.defaultState !== undefined) {
        entry.defaultState = newId;
        entry.currentState = newId;
      }

      // Gate or bomb replaced by something else: remove it from every
      // button that toggles it, or buttonBegin would keep poking the new
      // tile at this coordinate.
      if ((wasGate && !staysGate) || (wasBomb && newCat !== 'bomb')) {
        for (const [bKey, data] of Object.entries(gameState.switches)) {
          const before = (data.toggle ?? []).length;
          data.toggle = (data.toggle ?? []).filter(t => t.pos.x !== x || t.pos.y !== y);
          if (data.toggle.length === before) continue;
          changed = true;

          const [bx, by] = bKey.split(',').map(Number);
          const btn = gameState.getTile(bx, by);
          if (btn) {
            btn.switchGates = (btn.switchGates ?? []).filter(c => c.x !== x || c.y !== y);
            btn.switchBombs = (btn.switchBombs ?? []).filter(c => c.x !== x || c.y !== y);
          }
        }
        if (wasGate) {
          if (entry.stickyHandler) gameHelpers.cancelTimeout(entry.stickyHandler);
          delete entry.defaultState;
          delete entry.currentState;
          delete entry.red;
          delete entry.blue;
          delete entry.stickyHandler;
          delete entry.controllingButtons;
        }
      }

      // Portal replaced by a non-portal: drop its own destination entry.
      if (PORTAL_CATEGORIES.includes(entry.category)
          && !PORTAL_CATEGORIES.includes(newCat)) {
        if (gameState.portals[key]) {
          delete gameState.portals[key];
          changed = true;
        }
        delete entry.destinationX;
        delete entry.destinationY;
        delete entry.destinationTileX;
        delete entry.destinationTileY;
        delete entry.portalCooldown;
        delete entry.portalOnCooldown;
      }

      return changed;
    },

    // A palette-painted portal (gameInstance.changeTiles) starts life
    // unwired - the true exit-portal state - since nothing has connected
    // it yet. Painting over an existing portal deliberately resets its
    // outgoing wire the same way. It only becomes active by an explicit
    // wire (drag, connect-mode click, or the Exit Portal checkbox).
    initPaintedPortal(x, y) {
      const entry = gameState.getTile(x, y);
      if (!entry || !PORTAL_CATEGORIES.includes(entry.category)) return;

      const key  = `${x},${y}`;
      const data = gameState.portals[key] ??= { destination: null, cooldown: 0 };
      data.destination = null;
      mapWiring.applyPortalData({ [key]: data });
      mapWiring.syncPortalId(entry);
    },

    applyPortalData(portals) {
      for (const [key, portalData] of Object.entries(portals)) {
        const [x, y] = key.split(',').map(Number);
        const entry  = gameState.getTile(x, y);
        if (!entry) continue;

        // destination: null (true exit, no wire) is kept as null in the
        // stored structure - see syncPortalId, which is the only place
        // that decides exit-vs-active. Stepping onto an exit portal still
        // needs SOME world position to hand physicsHelpers.teleportPlayer,
        // so resolve a self-fallback for the derived teleport fields only;
        // this fallback must never be written back into portalData.destination,
        // or an exit portal would look indistinguishable from a real
        // self-targeting active one.
        const dest = portalData.destination ?? { x, y };

        const pos              = tileToWorld(dest.x, dest.y);
        entry.destinationX     = pos.x;
        entry.destinationY     = pos.y;
        entry.destinationTileX = dest.x;
        entry.destinationTileY = dest.y;
        entry.portalCooldown   = portalData.cooldown ?? 0;
        entry.portalOnCooldown = false;
      }
    },

    // Ensures every portal tile has a gameState.portals entry (destination:
    // null - exit - when nothing wired it) and an id matching its wired
    // state. Map JSON only lists portals its editor wired, so exit-only
    // portals would otherwise be invisible to the client's wiring UI.
    normalizePortals() {
      for (const row of gameState.dataMap) {
        for (const entry of row ?? []) {
          if (!entry || !PORTAL_CATEGORIES.includes(entry.category)) continue;

          const key  = `${entry.x},${entry.y}`;
          const data = gameState.portals[key] ??= { destination: null, cooldown: 0 };
          if (!data.destination || entry.destinationTileX == null) {
            mapWiring.applyPortalData({ [key]: data });
          }
          mapWiring.syncPortalId(entry);
        }
      }
    },

    applySwitchData(switches) {
      for (const [key, switchJson] of Object.entries(switches)) {
        const [buttonX, buttonY] = key.split(',').map(Number);
        const button = gameState.getTile(buttonX, buttonY);
        if (!button) continue;

        button.switchTimer = switchJson.timer ?? 0;
        button.switchGates = [];
        button.switchBombs = [];

        for (const { pos: { x: tx, y: ty } } of switchJson.toggle ?? []) {
          const target = gameState.getTile(tx, ty);
          if (!target) continue;

          if (target.id === TILE_ID.BOMB || target.id === TILE_ID.BOMBTAKEN) {
            button.switchBombs.push({ x: tx, y: ty });
          } else {
            button.switchGates.push({ x: tx, y: ty });
            if (target.defaultState === undefined) {
              target.defaultState  = target.id;
              target.currentState  = target.id;
              target.red           = 0;
              target.blue          = 0;
              target.stickyHandler = null;
              target.controllingButtons = [];
            }
            target.controllingButtons.push({ x: buttonX, y: buttonY });
          }
        }
      }
    },
  };

  return mapWiring;
};

if (typeof module !== 'undefined' && module.exports) module.exports = createMapWiring;
if (typeof globalThis !== 'undefined') globalThis.createMapWiring = createMapWiring;

})();
