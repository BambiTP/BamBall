(function () {
const { TILE_SIZE } = (typeof require === 'function') ? require('./coords') : globalThis.Coords;

// Edit mode drops the distance check entirely - the leader can pan/zoom
// anywhere and needs everyone's position, not just what's near their own
// ball, so there's no camera position to track at all.
function isVisible(viewer, target, viewportWidth, viewportHeight) {
  if (viewer.seesAll) return true;
  const halfWidth  = viewportWidth  / 2 / TILE_SIZE;
  const halfHeight = viewportHeight / 2 / TILE_SIZE;
  return Math.abs(target.x - viewer.x) <= halfWidth
      && Math.abs(target.y - viewer.y) <= halfHeight;
}

// 4 decimals. Velocity especially needs this: accel is 0.025/tick, so a
// 2-decimal quantum (0.01) was 40% of one tick's acceleration - big enough
// to perturb prediction and to hide small velocity changes from the diff.
function round2(value) {
  return Math.round(value * 10000) / 10000;
}

function teamCode(team) {
  return team === 'blue' ? 2 : 1;
}

// Condensed wire format, short keys only:
//   id = id
//   n  = display name
//   t  = team (1 = red, 2 = blue)
//   x, y, a = position/angle, rounded to 4 decimals
//   lx, ly  = linear velocity, rounded to 4 decimals
//   ac, ms  = current accel / max speed (base + modifiers, server-derived)
//   s  = snap counter - server increments it on teleport/respawn; when a
//        viewer sees it change they snap to position instead of lerping
//   d  = dead        (only present when 1)
//   f  = hasFlag      (only present when 1)
//   tp = tagpro       (only present when 1)
//   rb = rollingBomb  (only present when 1)
//   jj = jukeJuice    (only present when 1)
//   kl = kothLeader   (only present when 1) - currently leading a koth pup contest
//   au = authed       (only present when 1) - host-verified TagPro login (see local/webrtcTransport.js)
//   fl = flairIndex   (always present, null when no flair) - see local/flairPicker.js
function serializeEntity(player) {
  const entity = {
    id: player.id,
    n:  player.name,
    t:  teamCode(player.team),
    x:  round2(player.x),
    y:  round2(player.y),
    a:  round2(player.a),
    lx: round2(player.lx),
    ly: round2(player.ly),
    ac: round2(player.accel),
    ms: round2(player.maxSpeed),
    s:  player.snapCount || 0,
    f:  (player.hasFlag && player.hasFlag.flagId) || 0,
    fl: (player.flairIndex ?? null),
  };

  if (player.dead)        entity.d  = 1;
  if (player.tagpro)      entity.tp = 1;
  if (player.rollingBomb) entity.rb = 1;
  if (player.jukeJuice)   entity.jj = 1;
  if (player.kothLeader)  entity.kl = 1;
  if (player.matchFrozen) entity.mf = 1;
  if (player.authed)      entity.au = 1;

  return entity;
}

const NUMERIC_KEYS = ['x', 'y', 'a', 'lx', 'ly', 'ac', 'ms', 't', 's', 'n', 'f', 'fl'];
const FLAG_KEYS    = ['d', 'tp', 'rb', 'jj', 'kl', 'mf'];
function diffFields(previous, current) {
  if (!previous) return current;

  const diff    = { id: current.id };
  let   changed = false;

  for (const key of NUMERIC_KEYS) {
    if (previous[key] !== current[key]) {
      diff[key] = current[key];
      changed   = true;
    }
  }

  for (const key of FLAG_KEYS) {
    const prevVal = previous[key] || 0;
    const currVal = current[key] || 0;
    if (prevVal !== currVal) {
      diff[key] = currVal;
      changed   = true;
    }
  }

  return changed ? diff : null;
}

function createSnapshotFactory(gameState, config) {
  const viewerState = new Map(); // playerId -> Map<otherPlayerId, lastSentEntity>

  // Un-culled, globally-deduplicated diff path for replay recording: one
  // canonical record of what actually changed, independent of who could see
  // it. Separate cache from viewerState/getKnown on purpose - those are
  // per-viewer and visibility-gated, this one tracks "last recorded value"
  // regardless of any viewer's camera.
  const replayKnown = new Map(); // playerId -> last-recorded serialized entity

  function buildReplayDelta() {
    const updated = [];
    const removed = [];
    const seenIds = new Set();

    for (const player of gameState.players) {
      seenIds.add(player.id);
      const previous = replayKnown.get(player.id);
      const current  = serializeEntity(player);
      const diff     = diffFields(previous, current);
      if (diff) {
        updated.push(diff);
        replayKnown.set(player.id, current);
      }
    }

    for (const knownId of replayKnown.keys()) {
      if (!seenIds.has(knownId)) {
        replayKnown.delete(knownId);
        removed.push(knownId);
      }
    }

    return { updated, removed };
  }

  function getKnown(playerId) {
    let known = viewerState.get(playerId);
    if (!known) {
      known = new Map();
      viewerState.set(playerId, known);
    }
    return known;
  }

  function buildDelta(viewer) {
    const known   = getKnown(viewer.id);
    const updated = [];
    const removed = [];
    const seenIds = new Set();

    const zoom            = viewer.zoom || 1;
    const viewportWidth   = config.viewportWidth  / zoom;
    const viewportHeight  = config.viewportHeight / zoom;

    for (const other of gameState.players) {
      const isSelf = other.id === viewer.id;
      if (!isSelf && !isVisible(viewer, other, viewportWidth, viewportHeight)) continue;

      seenIds.add(other.id);
      const previous = known.get(other.id);
      const current  = serializeEntity(other);
      const diff     = diffFields(previous, current);

      if (diff) {
        updated.push(diff);
        known.set(other.id, current);
      }
    }

    // Players this viewer knew about but can no longer see (despawned or
    // out of viewport) get reported so the client can clean them up.
    for (const knownId of known.keys()) {
      if (!seenIds.has(knownId)) {
        known.delete(knownId);
        removed.push(knownId);
      }
    }

    return { updated, removed };
  }

  function buildDeltasForPlayers(changedPlayers) {
    const deltas = new Map();

    for (const changed of changedPlayers) {
      for (const viewer of gameState.players) {
        const isSelf = viewer.id === changed.id;

        if (!isSelf) {
          const zoom           = viewer.zoom || 1;
          const viewportWidth  = config.viewportWidth  / zoom;
          const viewportHeight = config.viewportHeight / zoom;

          if (!isVisible(viewer, changed, viewportWidth, viewportHeight)) continue;
        }

        const known    = getKnown(viewer.id);
        const previous = known.get(changed.id);
        const current  = serializeEntity(changed);
        const diff     = diffFields(previous, current);

        if (!diff) continue;

        known.set(changed.id, current);

        if (!deltas.has(viewer.id)) {
          deltas.set(viewer.id, { updated: [], removed: [] });
        }
        deltas.get(viewer.id).updated.push(diff);
      }
    }

    return deltas;
  }

  function getViewerIds(player) {
    const viewerIds = [];

    for (const viewer of gameState.players) {
      if (viewer.id === player.id) continue;

      const zoom           = viewer.zoom || 1;
      const viewportWidth  = config.viewportWidth  / zoom;
      const viewportHeight = config.viewportHeight / zoom;

      if (isVisible(viewer, player, viewportWidth, viewportHeight)) {
        viewerIds.push(viewer.id);
      }
    }

    return viewerIds;
  }

  function removeViewer(playerId) {
    viewerState.delete(playerId);
  }

  // Called when a new replay recording starts (server/packets/outgoing.js's
  // matchStateChanged listener) - replayKnown persists for the room's whole
  // lifetime (this factory is built once per gameInstance, not per match),
  // so without this a player whose position/flags already match what an
  // earlier tick cached (spawn assignment raced ahead of the recorder being
  // created, or simply a leftover from a previous match) gets NO record of
  // their current state at all until some field changes - and when it
  // finally does, buildReplayDelta only reports what changed, not a full
  // entity, so client/game/state/gameState.js's createPlayer receives a
  // partial diff missing x/y and spawns the player at (undefined, undefined).
  // Clearing here guarantees the very next tick's diff is against no
  // previous value, so the recording always opens with everyone's full
  // state, the same guarantee a live viewer gets for free from their own
  // brand-new per-viewer cache in getKnown().
  function resetReplayKnown() {
    replayKnown.clear();
  }

  function buildAllDeltas() {
    const deltas = new Map();

    for (const viewer of gameState.players) {
      const delta = buildDelta(viewer);
      if (delta.updated.length || delta.removed.length) {
        deltas.set(viewer.id, delta);
      }
    }

    return deltas;
  }

  // Spectators have no player object of their own (they never went through
  // spawnPlayer), so they can't be a "viewer" in buildDelta/getViewerIds at
  // all - this is the unculled equivalent for them: everyone's full current
  // state, always, no distance check and no diffing against a per-viewer
  // known-state cache (spectators are assumed few enough that resending
  // everyone in full is simpler than tracking their own diff cache).
  function buildSpectatorSnapshot() {
    return { updated: gameState.players.map(serializeEntity), removed: [] };
  }

  return { buildDelta, buildAllDeltas, buildDeltasForPlayers, getViewerIds, removeViewer, buildSpectatorSnapshot, buildReplayDelta, resetReplayKnown };
}

if (typeof module !== 'undefined' && module.exports) module.exports = createSnapshotFactory;
if (typeof globalThis !== 'undefined') globalThis.createSnapshotFactory = createSnapshotFactory;
})();
