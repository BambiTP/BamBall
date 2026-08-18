// hostSession.js - the authoritative multiplayer host: client registry,
// moderation, join/team, engine-event -> packet wiring, WebRTC peer
// connection management, and map switching. Used identically by all three
// hosting environments:
//   - local/localTransport.js   - one local client, never any peers.
//   - local/webrtcTransport.js  - HOST role: one local client + N peers.
//   - node-host/hostCli.js      - N peers, no local client at all.
// None of these three is the "real" host the others approximate - they're
// three different combinations of {has a local client? yes/no} x
// {RTCPeerConnection/WebSocket source: browser-native, or Node's
// @roamhq/wrtc + ws} driving the exact same session logic underneath. This
// file owns none of those environment specifics itself - every one of them
// arrives via the `deps` object passed to createHostSession, so no single
// caller is favored over the others.
//
// Isomorphic (CommonJS + plain global), same pattern as engine/* and
// shared/*: required by node-host, <script>-tagged by the browser. Unlike
// engine/shared files, this one does reach for two npm-only globals in a
// Node context (RTCPeerConnection, WebSocket) - callers supply those
// through `deps` rather than this file requiring them directly, since
// @roamhq/wrtc and ws live in node-host/node_modules, not somewhere a
// plain relative require from here could resolve.

(function () {

var Packets     = (typeof require === 'function') ? require('../engine/packetBuilders.js') : globalThis;
var packetBuilders  = Packets.packetBuilders;
var serializePlayer = Packets.serializePlayer;
var TagproAuth   = (typeof require === 'function') ? require('./tagproAuthLib.js') : globalThis.TagproAuth;

// The server/broadcast-side counterpart of every client-facing 'joined'/
// 'mapChanged' payload's map fields - identical for a fresh boot and a
// live map switch, so both call this instead of listing the same nine
// fields twice.
function mapDataFrom(gameState) {
  return {
    map: gameState.map,
    wallMap: gameState.wallMap,
    wells: gameState.wells,
    mapId: gameState.mapId,
    mapSource: gameState.mapSource,
    mapName: gameState.mapName,
    mapAuthor: gameState.mapAuthor,
    switches: gameState.switches,
    portals: gameState.portals,
    tileOverrides: gameState.tileOverrides,
    spawnPoints: gameState.spawnPoints,
  };
}

// engine event name -> packet builder - the same table every host
// environment used to keep in sync by hand.
var EVENT_MAP = {
  score:                 packetBuilders.score,
  setTile:               packetBuilders.setTile,
  connectionsChanged:    packetBuilders.connections,
  spawnPointsChanged:    packetBuilders.spawnPoints,
  capture:               packetBuilders.capture,
  eggballChanged:        packetBuilders.eggballChanged,
  physicsChanged:        packetBuilders.physicsChanged,
  playerPhysicsChanged:  packetBuilders.playerPhysicsChanged,
  tileSettingsChanged:   packetBuilders.tileSettingsChanged,
  saveStatesChanged:     packetBuilders.saveStatesChanged,
  profilesChanged:       packetBuilders.profilesChanged,
  matchEnd:              packetBuilders.matchEnd,
  powerupPreview:        packetBuilders.powerupPreview,
  chat:                  packetBuilders.chat,
};

function parseMessage(raw) {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
}

// gi: an already-`new GameInstance(...)`'d instance (map need not be
// loaded yet - switchMap/boot-time gi.loadMap both work fine after
// createHostSession runs).
//
// deps:
//   RTCPeerConnection, WebSocket   - constructors. Only needed if the
//     caller ever calls connectSignalAsHost (localTransport never does).
//   iceServers, workerUrl, signalUrl
//   recorder      - { recordInput, recordBroadcast, recordPlayerDelta,
//                      isRecording, isEnded, start, finish } or omitted.
//   localClient   - { client: {team,...}, account: {display_name,...},
//                      dispatch(packet) } if this environment has a local
//                      player, omitted (node-host) if not. The client/
//                      account objects are mutated in place (team changes,
//                      mute, etc land directly on the caller's own
//                      references) rather than cloned.
//   resolveMap(mapId) -> Promise<{ mapDoc, mapMeta }>, for a leader's
//     'changeMap' packet (always a Fortunate Maps id). Omit to reject
//     changeMap packets outright.
//   onReplayFinished(result, meta), onMatchStateApplied(state),
//   onDuplicateDevice(respond), onRosterChanged(), getDeviceId(),
//   log(msg)      - all optional UI/environment hooks; every one no-ops
//     (or, for log, prints to console) if omitted.
function createHostSession(gi, deps) {
  deps = deps || {};
  var recorder = deps.recorder || null;
  var log      = deps.log || function (msg) { console.log(msg); };

  var peers = {}; // signalPeerId -> { pc, dc, clientId, client, account, ready, lastSeenMs, dispatch }
  var localEntry = null;
  var nextClientId = 2; // 1 is reserved for a local client whether or not one exists - keeps clientIds consistent across environments

  if (deps.localClient) {
    var c = deps.localClient.client;
    c.id = 1;
    c.leader = true;
    c.mainLeader = true;
    if (c.muted === undefined) c.muted = false;
    localEntry = { clientId: 1, client: c, account: deps.localClient.account, dispatch: deps.localClient.dispatch };
  }

  var signalWs = null;
  var myPeerId = null;

  // ---- client registry ---------------------------------------------------

  function findPeerEntry(clientId) {
    for (var id in peers) {
      if (peers[id].clientId === clientId) return { peerId: id, entry: peers[id] };
    }
    return null;
  }

  function findClient(clientId) {
    if (localEntry && clientId === localEntry.clientId) return localEntry;
    var found = findPeerEntry(clientId);
    return found ? found.entry : null;
  }

  function isLeader(clientId) {
    var c = findClient(clientId);
    return !!(c && (c.client.mainLeader || c.client.leader));
  }

  function isMainLeader(clientId) {
    var c = findClient(clientId);
    return !!(c && c.client.mainLeader);
  }

  function rosterRow(entry) {
    return {
      id: entry.clientId, name: entry.account.display_name, team: entry.client.team,
      inGame: !!gi.gameState.getPlayer(entry.clientId),
      leader: !!(entry.client.leader || entry.client.mainLeader), mainLeader: !!entry.client.mainLeader,
      muted: !!entry.client.muted, authed: !!entry.account.authed,
    };
  }

  // Everyone currently connected, host included - see engine/packetBuilders.js's
  // roomState for the wire shape. This is the only place a client who's
  // still spectating (never spawned, so absent from gi.gameState.players)
  // shows up to anyone at all.
  function buildRoster() {
    var list = [];
    if (localEntry) list.push(rosterRow(localEntry));
    for (var id in peers) { if (peers[id].ready) list.push(rosterRow(peers[id])); }
    return list;
  }

  // Every connected peer regardless of readiness (mid-handshake peers
  // included), for CLI/debug status displays - buildRoster deliberately
  // excludes those, since the wire-facing roomState packet shouldn't.
  function listConnections() {
    var list = [];
    if (localEntry) {
      list.push({ clientId: 1, ready: true, name: localEntry.account.display_name, team: localEntry.client.team,
        leader: true, mainLeader: true, authed: !!localEntry.account.authed });
    }
    for (var id in peers) {
      var e = peers[id];
      list.push({ clientId: e.clientId, ready: e.ready, name: e.account.display_name, team: e.client.team,
        leader: !!e.client.leader, mainLeader: false, authed: !!e.account.authed });
    }
    return list;
  }

  function describeEntry(entry) {
    return 'clientId=' + entry.clientId + ' name="' + entry.account.display_name + '" team=' + entry.client.team
      + (entry.client.leader ? ' [leader]' : '') + (entry.account.authed ? ' [tagpro-verified]' : '');
  }

  // ---- sending -------------------------------------------------------------

  function safeSend(entry, packet) {
    if (!entry.ready || !entry.dc || entry.dc.readyState !== 'open') return;
    try { entry.dc.send(JSON.stringify(packet)); } catch (e) { /* dropped, peer removal will clean up */ }
  }

  function sendToClient(clientId, packet) {
    var c = findClient(clientId);
    if (c) c.dispatch(packet);
  }

  // Local client + every peer, plus one recorder call - never one per
  // client, this is a session-level "this packet went out" event.
  function broadcastToAll(packet) {
    if (localEntry) localEntry.dispatch(packet);
    if (recorder) recorder.recordBroadcast(packet);
    for (var id in peers) safeSend(peers[id], packet);
  }

  function broadcastRoster() {
    broadcastToAll(packetBuilders.roomState(buildRoster()));
    if (deps.onRosterChanged) deps.onRosterChanged();
  }

  // ---- moderation ----------------------------------------------------------
  //
  // Two roles above plain player:
  //   MAIN LEADER - the environment's own local client, if it has one
  //     (client.mainLeader, set above). Every permission below,
  //     permanently, and can't be kicked/banned/muted/demoted by anyone.
  //     node-host has no local client, so no one is ever the main leader
  //     there - isLeader/isMainLeader simply always say no for a clientId
  //     that doesn't exist as localEntry, which is exactly node-host's
  //     existing "no privileged connected client, only terminal access is
  //     privileged" model, arrived at generically rather than as a special
  //     case for it.
  //   LEADER - zero or more clients the main leader (or another leader)
  //     promoted. Identical powers EXCEPT demoting: only mainLeader is
  //     exempt from demote_leader.

  function kickClient(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return false;
    safeSend(found.entry, { type: 'kicked', message: 'You have been kicked from this room.' });
    // A brief delay, not an immediate close - closing right after send()
    // risks the message never actually flushing to the wire first.
    setTimeout(function () { removePeer(found.peerId); }, 300);
    return true;
  }

  function banClient(clientId) {
    var found = findPeerEntry(clientId);
    if (!found) return false;
    safeSend(found.entry, { type: 'kicked', message: 'You have been banned from this room.' });
    if (signalWs) signalWs.send(JSON.stringify({ type: 'ban', peerId: found.peerId }));
    setTimeout(function () { removePeer(found.peerId); }, 300);
    return true;
  }

  function setMuted(clientId, muted) {
    var c = findClient(clientId);
    if (!c) return false;
    c.client.muted = !!muted;
    broadcastRoster();
    return true;
  }

  function promoteToLeader(clientId) {
    var c = findClient(clientId);
    if (!c) return false;
    c.client.leader = true;
    broadcastRoster();
    return true;
  }

  function demoteFromLeader(clientId) {
    var c = findClient(clientId);
    if (!c || c.client.mainLeader) return false;
    c.client.leader = false;
    broadcastRoster();
    return true;
  }

  // ---- join / team ----------------------------------------------------------

  function setTeamFor(clientId, team) {
    var c = findClient(clientId);
    if (!c) return;
    var previousTeam = c.client.team;
    c.client.team = team;
    c.dispatch({ type: 'team', team: team });
    broadcastRoster();

    if (team === previousTeam) return;
    var player = gi.gameState.getPlayer(clientId);
    if (player) {
      gi.gameHelpers.removePlayer(clientId);
      c.dispatch({ type: 'leftGame' });
      if (team === 'red' || team === 'blue') {
        var respawned = gi.gameHelpers.spawnPlayer(clientId, team, c.account.display_name, c.account.authed);
        c.dispatch({ type: 'joinedGame', player: serializePlayer(respawned) });
      }
      broadcastRoster();
    }
  }

  function joinGameFor(clientId) {
    var c = findClient(clientId);
    if (!c) return;
    if (gi.gameState.getPlayer(clientId)) return;
    if (c.client.team !== 'red' && c.client.team !== 'blue') {
      c.dispatch({ type: 'error', message: 'select red or blue before joining the game' });
      return;
    }
    var player = gi.gameHelpers.spawnPlayer(clientId, c.client.team, c.account.display_name, c.account.authed);
    sendToClient(clientId, { type: 'joinedGame', player: serializePlayer(player) });
    broadcastRoster();
    if (gi.gameState.state === 'pregame') gi.matchManager.startMatch();
  }

  // ---- engine events -> packets ----------------------------------------------

  function wireEngineEvents() {
    Object.keys(EVENT_MAP).forEach(function (event) {
      var builder = EVENT_MAP[event];
      gi.emitter.on(event, function () {
        broadcastToAll(builder.apply(null, arguments));
      });
    });

    gi.emitter.on('matchStateChanged', function () {
      broadcastToAll(packetBuilders.matchState(gi.gameState));
      log('match state: ' + gi.gameState.state);
      if (deps.onMatchStateApplied) deps.onMatchStateApplied(gi.gameState.state);

      if (gi.gameState.state === 'countdown' && recorder && !recorder.isRecording() && !recorder.isEnded()) {
        recorder.start(mapDataFrom(gi.gameState));
      }

      // Auto-join on match start: every connected client (local included)
      // who's picked a team but hasn't spawned yet.
      if (gi.gameState.state === 'countdown') {
        if (localEntry && !gi.gameState.getPlayer(localEntry.clientId) && (localEntry.client.team === 'red' || localEntry.client.team === 'blue')) {
          joinGameFor(localEntry.clientId);
        }
        for (var id in peers) {
          var entry = peers[id];
          if (entry.ready && !gi.gameState.getPlayer(entry.clientId) && (entry.client.team === 'red' || entry.client.team === 'blue')) {
            joinGameFor(entry.clientId);
          }
        }
      }
    });

    gi.emitter.on('matchEnd', function (data) {
      if (!recorder || !recorder.isRecording()) return;
      var meta = { mapName: gi.gameState.mapName, mapId: gi.gameState.mapId, winner: data.winner, reason: data.reason, scores: data.scores };
      recorder.finish(data).then(function (result) {
        if (deps.onReplayFinished) deps.onReplayFinished(result, meta);
      });
    });

    // engine/matchManager.js's applyProfile can't fetch a map itself (no
    // network access from engine/) - it emits this with just the id, and
    // whichever environment is actually running does the fetch+load, same
    // as a leader's own 'changeMap' packet does via deps.resolveMap.
    gi.emitter.on('applyProfileMap', function (mapId) {
      if (!deps.resolveMap) return;
      deps.resolveMap(mapId).then(function (resolved) {
        switchMap(resolved.mapDoc, resolved.mapMeta);
      }).catch(function (err) { log('could not load profile map ' + mapId + ': ' + err.message); });
    });

    // Per-viewer events: sent to whichever client actually owns them, not
    // broadcast to everyone.
    gi.emitter.on('powerupCollected', function (playerId, key, timerMs) {
      sendToClient(playerId, packetBuilders.powerupCollected(key, timerMs));
    });

    gi.emitter.on('snapshot', function (deltas, immediate) {
      if (localEntry) {
        var localDelta = deltas.get(localEntry.clientId);
        if (localDelta) localEntry.dispatch(packetBuilders.snapshot(localDelta, immediate));
      }
      for (var id in peers) {
        var entry = peers[id];
        var delta = deltas.get(entry.clientId);
        if (delta) safeSend(entry, packetBuilders.snapshot(delta, immediate));
      }
    });

    gi.emitter.on('replayPlayers', function (delta) {
      if (recorder) recorder.recordPlayerDelta(delta);
    });
  }

  // ---- outgoing packet handling ----------------------------------------------
  //
  // dispatch (via the client's own .dispatch) is where THIS client's reply
  // packets go - the local packetRouter for a local client, straight back
  // over the data channel for a peer.

  function handleOutgoing(clientId, packet) {
    var c = findClient(clientId);
    if (!c) return;
    var clientRec = c.client, accountRec = c.account, dispatch = c.dispatch;

    switch (packet.type) {
      case 'join_red':       return setTeamFor(clientId, 'red');
      case 'join_blue':      return setTeamFor(clientId, 'blue');
      case 'join_spectator': return setTeamFor(clientId, 'spectator');
      case 'join_game':      return joinGameFor(clientId);
      case 'leave_game': {
        var player = gi.gameState.getPlayer(clientId);
        if (!player) { dispatch({ type: 'error', message: 'not currently in the game' }); return; }
        gi.gameHelpers.removePlayer(clientId);
        dispatch({ type: 'leftGame' });
        return;
      }
      case 'input': {
        var p = gi.gameState.getPlayer(clientId);
        if (!p) return;
        p.left = !!packet.left; p.right = !!packet.right; p.up = !!packet.up; p.down = !!packet.down;
        if (recorder) recorder.recordInput(clientId, packet);
        return;
      }
      case 'ping': return dispatch({ type: 'pong', t: packet.t });
      case 'detonateBomb': {
        var pl = gi.gameState.getPlayer(clientId);
        if (!pl || pl.dead || pl.frozen || pl.matchFrozen) return;
        var affected = gi.gameHelpers.detonateRollingBomb(pl);
        if (affected) gi.emitter.emit('update', affected);
        return;
      }
      case 'throwEgg': {
        var throwPl = gi.gameState.getPlayer(clientId);
        if (!throwPl || throwPl.dead || throwPl.frozen || throwPl.matchFrozen) return;
        gi.gameHelpers.throwEggball(throwPl, Number(packet.dirX) || 0, Number(packet.dirY) || 0);
        return;
      }
      case 'chat': {
        if (clientRec.muted) { dispatch({ type: 'error', message: 'You are muted in this room.' }); return; }
        var text = typeof packet.text === 'string' ? packet.text.trim().slice(0, 240) : '';
        if (!text) return;
        log('chat <' + accountRec.display_name + '> ' + text);
        broadcastToAll(packetBuilders.chat({ id: clientId, name: accountRec.display_name, text: text }));
        return;
      }
      // A peer's one-time self-introduction. A freely-chosen display name
      // applies immediately; a claimed TagPro identity only takes effect
      // once verifyToken confirms it.
      case 'identify': {
        if (typeof packet.name === 'string' && packet.name.trim()) {
          accountRec.display_name = packet.name.trim().slice(0, 20);
        }
        broadcastRoster();
        if (packet.tagpro && packet.tagpro.token) {
          TagproAuth.verifyToken(deps.workerUrl, packet.tagpro).then(function (valid) {
            if (!valid) return;
            accountRec.authed = true;
            accountRec.display_name = packet.tagpro.reservedName;
            var p = gi.gameState.getPlayer(clientId);
            if (p) { p.authed = true; gi.emitter.emit('update', p); }
            broadcastRoster();
          });
        }
        return;
      }

      // ---- leader-gated moderation + match control -------------------
      case 'kick_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can kick players' }); return; }
        if (isMainLeader(packet.targetId)) { dispatch({ type: 'error', message: 'cannot kick the main leader' }); return; }
        kickClient(packet.targetId);
        return;
      }
      case 'ban_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can ban players' }); return; }
        if (isMainLeader(packet.targetId)) { dispatch({ type: 'error', message: 'cannot ban the main leader' }); return; }
        banClient(packet.targetId);
        return;
      }
      case 'mute_player': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can mute players' }); return; }
        if (isMainLeader(packet.targetId)) { dispatch({ type: 'error', message: 'cannot mute the main leader' }); return; }
        setMuted(packet.targetId, !!packet.muted);
        return;
      }
      case 'promote_leader': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can promote players' }); return; }
        promoteToLeader(packet.targetId);
        return;
      }
      case 'demote_leader': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can demote players' }); return; }
        if (isMainLeader(packet.targetId)) { dispatch({ type: 'error', message: 'the main leader cannot be demoted' }); return; }
        demoteFromLeader(packet.targetId);
        return;
      }
      case 'start_match':  { if (isLeader(clientId)) gi.matchManager.startMatch();  return; }
      case 'pause_match':  { if (isLeader(clientId)) gi.matchManager.pauseMatch();  return; }
      case 'resume_match': { if (isLeader(clientId)) gi.matchManager.resumeMatch(); return; }
      case 'reset_game':   { if (isLeader(clientId)) gi.matchManager.resetMatch();  return; }
      case 'end_match':    { if (isLeader(clientId)) gi.matchManager.endMatch('leaderEnded'); return; }

      // ---- leader-gated settings edits --------------------------------
      // matchManager mutates config/gameState directly and emits its own
      // 'physicsChanged' / 'matchStateChanged' / etc - wireEngineEvents'
      // EVENT_MAP already turns those into broadcasts.
      case 'update_physics': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change physics settings' }); return; }
        gi.matchManager.updatePhysics(packet.settings);
        return;
      }
      case 'update_player_physics': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change player settings' }); return; }
        var targetPlayer = gi.gameState.getPlayer(packet.targetId);
        if (!targetPlayer) return;
        gi.matchManager.updatePlayerPhysics(targetPlayer, packet.settings);
        return;
      }
      case 'update_settings': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change match settings' }); return; }
        gi.matchManager.updateSettings(packet.settings);
        return;
      }
      case 'update_tile_settings': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change tile settings' }); return; }
        gi.matchManager.updateTileSettings(packet.x, packet.y, packet.settings);
        return;
      }
      case 'changeMap': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can change the map' }); return; }
        if (!deps.resolveMap) { dispatch({ type: 'error', message: 'map switching not supported here' }); return; }
        deps.resolveMap(packet.mapId).then(function (resolved) {
          switchMap(resolved.mapDoc, resolved.mapMeta);
        }).catch(function (err) {
          dispatch({ type: 'error', message: 'could not load map: ' + err.message });
        });
        return;
      }
      // bundle: { mapId?, physics?, match? } - same shape a settings code
      // stores. profile: 'pregame' | 'game' - see engine/matchManager.js's
      // setProfile for when an edit also applies live vs. only updates the
      // stored profile.
      case 'update_profile': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can set the pregame/game profiles' }); return; }
        if (!gi.matchManager.setProfile(packet.profile, packet.bundle)) {
          dispatch({ type: 'error', message: 'unknown profile "' + packet.profile + '"' });
        }
        return;
      }
      case 'save_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can save game states' }); return; }
        gi.matchManager.captureSaveState(packet.name);
        return;
      }
      case 'load_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can load game states' }); return; }
        if (!gi.matchManager.restoreSaveState(packet.name)) dispatch({ type: 'error', message: 'no save state named "' + packet.name + '"' });
        return;
      }
      case 'delete_state': {
        if (!isLeader(clientId)) { dispatch({ type: 'error', message: 'only a leader can delete game states' }); return; }
        gi.matchManager.deleteSaveState(packet.name);
        return;
      }

      default: return;
    }
  }

  // ---- map switching ---------------------------------------------------------

  function switchMap(mapDoc, mapMeta) {
    gi.gameState.players.slice().forEach(function (p) { gi.gameHelpers.removePlayer(p.id); });
    gi.loadMap(mapDoc, mapMeta || null);
    if (localEntry) localEntry.client.team = 'spectator';
    for (var id in peers) peers[id].client.team = 'spectator';
    broadcastToAll(Object.assign({ type: 'mapChanged' }, mapDataFrom(gi.gameState)));
  }

  // ---- WebRTC peer connections (host side) ------------------------------------

  function removePeer(peerId) {
    var entry = peers[peerId];
    if (!entry) return;
    if (entry.pc) entry.pc.close();
    if (entry.ready) {
      var player = gi.gameState.getPlayer(entry.clientId);
      if (player) gi.gameHelpers.removePlayer(entry.clientId);
      log('player left: ' + describeEntry(entry));
    }
    delete peers[peerId];
    broadcastRoster();
  }

  function sendSignal(toPeerId, data) {
    signalWs.send(JSON.stringify({ type: 'signal', to: toPeerId, data: data }));
  }

  function handleSignalMessage(fromPeerId, data) {
    var entry = peers[fromPeerId];
    if (!entry) return; // shouldn't happen - entry is created on peer-joined before any signal arrives
    if (data.candidate) entry.pc.addIceCandidate(data.candidate).catch(function () {});
    else if (data.type === 'answer') entry.pc.setRemoteDescription(data).catch(function () {});
  }

  function handlePeerJoined(peerId) {
    var clientId = nextClientId++;
    var pc = new deps.RTCPeerConnection({ iceServers: deps.iceServers });
    // lastSeenMs backs startStalePeerCheck - a WebRTC data channel has no
    // reliable prompt "the other end is gone" signal on a real network
    // drop (not a clean close), so this catches a "ghost" peer that looks
    // connected but isn't. Set at creation so a peer that never finishes
    // connecting at all still ages out via the same sweep.
    var entry = {
      pc: pc, dc: null, clientId: clientId,
      client: { id: clientId, team: 'spectator', muted: false, leader: false },
      account: { display_name: 'Player ' + clientId, authed: false },
      ready: false, lastSeenMs: Date.now(),
    };
    peers[peerId] = entry;

    pc.addEventListener('icecandidate', function (event) {
      if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
    });

    var dc = pc.createDataChannel('game', { ordered: true });
    entry.dc = dc;
    entry.dispatch = function (p) { safeSend(entry, p); };
    wireHostDataChannel(peerId, entry);

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () { sendSignal(peerId, offer); });
    }).catch(function (err) { log('offer failed for ' + peerId + ': ' + err.message); });
  }

  function wireHostDataChannel(peerId, entry) {
    entry.dc.addEventListener('open', function () {
      entry.ready = true;
      var room = { instance: gi, kind: 'game', leaderId: localEntry ? localEntry.clientId : 0 };
      var joinedPacket = packetBuilders.joined(room, entry.client, entry.account, mapDataFrom(gi.gameState));
      safeSend(entry, joinedPacket);
      log('player joined: ' + describeEntry(entry));
      broadcastRoster();
    });
    entry.dc.addEventListener('message', function (event) {
      entry.lastSeenMs = Date.now();
      handleOutgoing(entry.clientId, parseMessage(event.data));
    });
    entry.dc.addEventListener('close', function () { removePeer(peerId); });
  }

  // Every ready peer sends a 'ping' every couple of seconds regardless of
  // player input (client/net.js's own RTT probe), so "anything at all
  // heard recently" is a reliable liveness signal. STALE_TIMEOUT_MS is
  // generous versus that ~2s cadence so a slow tick or one dropped packet
  // doesn't falsely kick someone.
  var STALE_TIMEOUT_MS = 10000;
  var STALE_CHECK_INTERVAL_MS = 3000;

  function startStalePeerCheck() {
    setInterval(function () {
      var now = Date.now();
      for (var id in peers) {
        var entry = peers[id];
        if (entry.ready && now - entry.lastSeenMs > STALE_TIMEOUT_MS) {
          log('peer ' + id + ' (clientId ' + entry.clientId + ') timed out - no message in ' + STALE_TIMEOUT_MS + 'ms');
          if (entry.pc) entry.pc.close();
          removePeer(id);
        }
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  function requestRoomCode() {
    return fetch(deps.workerUrl + '/api/groups', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) { return data.code || null; });
  }

  // Notifies and disconnects every peer, then closes the signaling
  // connection - the whole-session equivalent of removePeer, for whoever
  // is shutting the host down entirely (node-host/hostCli.js's `quit`).
  function shutdown(message) {
    for (var id in peers) {
      safeSend(peers[id], { type: 'kicked', message: message || 'The host is shutting down.' });
      if (peers[id].pc) peers[id].pc.close();
    }
    if (signalWs) signalWs.close(1000);
  }

  // Resolves once 'welcome' arrives (peerId assigned) and every subsequent
  // signaling message (peer-joined/peer-left/signal) is wired to this
  // session's own handlers.
  function connectSignalAsHost(code, password, name) {
    myPeerId = 'p' + Math.random().toString(36).slice(2, 10);
    var deviceId = deps.getDeviceId ? deps.getDeviceId() : null;
    var url = deps.signalUrl + code + '?peerId=' + myPeerId + '&role=host'
      + (password ? '&password=' + encodeURIComponent(password) : '')
      + (name ? '&name=' + encodeURIComponent(name) : '')
      + (deviceId ? '&deviceId=' + encodeURIComponent(deviceId) : '');
    signalWs = new deps.WebSocket(url);

    var ready = new Promise(function (resolve, reject) {
      signalWs.addEventListener('message', function onMessage(event) {
        var msg = parseMessage(event.data);
        if (msg.type === 'duplicate-device') {
          if (deps.onDuplicateDevice) {
            deps.onDuplicateDevice(function (choice) { signalWs.send(JSON.stringify({ type: 'resolve-duplicate', choice: choice })); });
          }
          return;
        }
        if (msg.type === 'welcome') { signalWs.removeEventListener('message', onMessage); resolve(msg); }
      });
      signalWs.addEventListener('close', function (event) {
        if (event.code !== 1000) reject(new Error(event.reason || 'signaling connection closed (code ' + event.code + ')'));
      });
      signalWs.addEventListener('error', function (event) {
        reject(new Error('signaling connection failed' + (event && event.message ? ': ' + event.message : '')));
      });
    });

    return ready.then(function (welcome) {
      signalWs.addEventListener('message', function (event) {
        var msg = parseMessage(event.data);
        if (msg.type === 'signal') handleSignalMessage(msg.from, msg.data);
        else if (msg.type === 'peer-joined') handlePeerJoined(msg.peerId);
        else if (msg.type === 'peer-left') removePeer(msg.peerId);
      });
      return welcome;
    });
  }

  return {
    gi: gi,
    handleOutgoing: handleOutgoing,
    wireEngineEvents: wireEngineEvents,
    buildRoster: buildRoster,
    listConnections: listConnections,
    broadcastRoster: broadcastRoster,
    broadcastToAll: broadcastToAll,
    sendToClient: sendToClient,
    switchMap: switchMap,
    isLeader: isLeader,
    isMainLeader: isMainLeader,
    findClient: findClient,
    kickClient: kickClient,
    banClient: banClient,
    setMuted: setMuted,
    promoteToLeader: promoteToLeader,
    demoteFromLeader: demoteFromLeader,
    setTeamFor: setTeamFor,
    joinGameFor: joinGameFor,
    requestRoomCode: requestRoomCode,
    connectSignalAsHost: connectSignalAsHost,
    startStalePeerCheck: startStalePeerCheck,
    shutdown: shutdown,
    localClientId: localEntry ? localEntry.clientId : null,
    peerCount: function () { return Object.keys(peers).filter(function (id) { return peers[id].ready; }).length; },
  };
}

var HostSession = { createHostSession: createHostSession, mapDataFrom: mapDataFrom };

if (typeof module !== 'undefined' && module.exports) module.exports = HostSession;
if (typeof globalThis !== 'undefined') globalThis.HostSession = HostSession;
})();
