#!/usr/bin/env node
// hostCli.js - headless, terminal-controlled P2P host. Runs the exact same
// authoritative engine/ code the browser host (local/webrtcTransport.js)
// does - engine/ and shared/ are already isomorphic (every file there does
// `(typeof require === 'function') ? require(...) : globalThis....`), so
// this just requires them directly instead of loading them as <script>
// tags. No PIXI, no DOM, no rendering at all: this process's only job is
// running the authoritative simulation and relaying packets, exactly what
// a browser host already does apart from also drawing its own screen.
//
// Deliberately mirrors webrtcTransport.js's HOST role closely (same
// EVENT_MAP, same handleOutgoingFor switch, same packet shapes) rather
// than reimplementing it from scratch - the goal is behavioral parity
// with the real host, not a from-scratch redesign. Differences from the
// browser host:
//   - No local player: this process is a pure dedicated host, nobody
//     plays FROM the terminal. (Could be added later - hostSocket's shape
//     already isolates where that would plug in.)
//   - No replay recording: local/localReplayRecorder.js wasn't audited
//     for Node-compatibility (CompressionStream/Blob assumptions) - out
//     of scope for a first pass. Replays from THIS host won't get saved
//     anywhere; matches still work fully otherwise.
//   - Signaling/WebRTC use the `ws` and `@roamhq/wrtc` packages instead
//     of the browser's native WebSocket/RTCPeerConnection - same wire
//     protocol either way, so the Worker (worker/src/roomSignal.js) and
//     any browser peer can't tell the difference.

const WebSocket = require('ws');
const wrtc = require('@roamhq/wrtc');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const GameInstance = require('../engine/gameInstance.js');
const gameConfig = require('../engine/gameConfig.js');
const { packetBuilders, serializePlayer } = require('../engine/packetBuilders.js');
const TagproAuth = require('../local/tagproAuthLib.js');

const WORKER_URL = 'https://api.bamball.workers.dev';
const SIGNAL_URL = WORKER_URL.replace(/^http/, 'ws') + '/api/signal/';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const MAPS_DIR = path.join(__dirname, '..', 'assets', 'maps');

// ---- CLI args --------------------------------------------------------
// --password=<pw>  --name=<host display name>  --map=<file in assets/maps>
function parseArgs() {
  var out = { password: '', name: 'Host', map: 'default.json' };
  process.argv.slice(2).forEach(function (arg) {
    var m = arg.match(/^--(password|name|map)=(.*)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}
var args = parseArgs();

// ---- state (mirrors webrtcTransport.js's host-side state) ------------
var gi = null;
var roomCode = null;
var signalWs = null;
var myPeerId = 'p' + Math.random().toString(36).slice(2, 10);
var nextClientId = 1; // no local player reserving id 1 here, unlike the browser host
var peers = {}; // signalPeerId -> { pc, dc, clientId, client, account, ready }

function mapDataFrom(gameState) {
  return {
    map: gameState.map,
    wallMap: gameState.wallMap,
    wells: gameState.wells,
    mapId: gameState.mapId,
    mapName: gameState.mapName,
    mapAuthor: gameState.mapAuthor,
    switches: gameState.switches,
    portals: gameState.portals,
    tileOverrides: gameState.tileOverrides,
    spawnPoints: gameState.spawnPoints,
    mapOverlayStrokes: gameState.mapOverlayStrokes,
    tileOverlayStrokes: gameState.tileOverlayStrokes,
  };
}

// ws's message event .data is a Buffer by default even through
// addEventListener - JSON.parse needs a string.
function parseMessage(raw) {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
}

// ---- signaling ---------------------------------------------------------

function requestRoomCode() {
  return fetch(WORKER_URL + '/api/groups', { method: 'POST' })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      roomCode = data.code || null;
      return roomCode;
    });
}

function connectSignal(code, password, name) {
  var url = SIGNAL_URL + code + '?peerId=' + myPeerId + '&role=host'
    + (password ? '&password=' + encodeURIComponent(password) : '')
    + '&name=' + encodeURIComponent(name);
  signalWs = new WebSocket(url);

  return new Promise(function (resolve, reject) {
    signalWs.addEventListener('message', function onMessage(event) {
      var msg = parseMessage(event.data);
      if (msg.type === 'welcome') {
        signalWs.removeEventListener('message', onMessage);
        resolve(msg);
      }
    });
    signalWs.addEventListener('close', function (event) {
      if (event.code !== 1000) reject(new Error(event.reason || 'signaling connection closed (code ' + event.code + ')'));
    });
    signalWs.addEventListener('error', function (event) { reject(new Error('signaling connection failed: ' + (event.message || event))); });
  }).then(function (welcome) {
    signalWs.addEventListener('message', function (event) {
      var msg = parseMessage(event.data);
      if (msg.type === 'signal') handleSignalMessage(msg.from, msg.data);
      else if (msg.type === 'peer-joined') handlePeerJoined(msg.peerId);
      else if (msg.type === 'peer-left') handlePeerLeft(msg.peerId);
    });
    return welcome;
  });
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

function handlePeerLeft(peerId) {
  var entry = peers[peerId];
  if (!entry) return;
  if (entry.pc) entry.pc.close();
  if (entry.ready) {
    var player = gi.gameState.getPlayer(entry.clientId);
    if (player) gi.gameHelpers.removePlayer(entry.clientId);
  }
  log('player left: ' + describeEntry(entry));
  delete peers[peerId];
}

// ---- moderation --------------------------------------------------------

function findPeerEntry(clientId) {
  for (var id in peers) {
    if (peers[id].clientId === clientId) return { peerId: id, entry: peers[id] };
  }
  return null;
}

function kickClient(clientId) {
  var found = findPeerEntry(clientId);
  if (!found) return false;
  safeSend(found.entry, { type: 'kicked', message: 'You have been kicked from this room.' });
  setTimeout(function () { handlePeerLeft(found.peerId); }, 300);
  return true;
}

function banClient(clientId) {
  var found = findPeerEntry(clientId);
  if (!found) return false;
  safeSend(found.entry, { type: 'kicked', message: 'You have been banned from this room.' });
  signalWs.send(JSON.stringify({ type: 'ban', peerId: found.peerId }));
  setTimeout(function () { handlePeerLeft(found.peerId); }, 300);
  return true;
}

// ---- WebRTC peer connections --------------------------------------------

function handlePeerJoined(peerId) {
  var clientId = ++nextClientId;
  var pc = new wrtc.RTCPeerConnection({ iceServers: ICE_SERVERS });
  // lastSeenMs backs the stale-connection sweep (see startStalePeerCheck) -
  // a WebRTC data channel has no reliable prompt "the other end is gone"
  // signal on a real network drop (not a clean close), so this catches a
  // "ghost" peer that looks connected but isn't actually there anymore.
  var entry = {
    pc: pc, dc: null, clientId: clientId,
    client: { id: clientId, team: 'spectator', muted: false },
    account: { display_name: 'Player ' + clientId, authed: false },
    ready: false, lastSeenMs: Date.now(),
  };
  peers[peerId] = entry;

  pc.addEventListener('icecandidate', function (event) {
    if (event.candidate) sendSignal(peerId, { candidate: event.candidate });
  });

  var dc = pc.createDataChannel('game', { ordered: true });
  entry.dc = dc;
  wireHostDataChannel(peerId, entry);

  pc.createOffer().then(function (offer) {
    return pc.setLocalDescription(offer).then(function () { sendSignal(peerId, offer); });
  }).catch(function (err) { log('offer failed for ' + peerId + ': ' + err.message); });
}

function wireHostDataChannel(peerId, entry) {
  entry.dc.addEventListener('open', function () {
    entry.ready = true;
    var room = { instance: gi, kind: 'game', leaderId: 0 };
    var joinedPacket = packetBuilders.joined(room, entry.client, entry.account, mapDataFrom(gi.gameState));
    entry.dc.send(JSON.stringify(joinedPacket));
    log('player joined: ' + describeEntry(entry));
  });
  entry.dc.addEventListener('message', function (event) {
    entry.lastSeenMs = Date.now();
    var packet = parseMessage(event.data);
    handleOutgoingFor(entry.clientId, entry, packet);
  });
  entry.dc.addEventListener('close', function () { handlePeerLeft(peerId); });
}

// Every ready peer sends a 'ping' every couple of seconds regardless of
// player input (client/ui/hud.js's own RTT probe), so "anything at all
// heard recently" is a reliable liveness signal. STALE_TIMEOUT_MS is
// generous versus that ~2s cadence - a few missed beats, not a hair
// trigger - so a slow tick or one dropped packet doesn't falsely kick
// someone.
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
        handlePeerLeft(id);
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}

function safeSend(entry, packet) {
  if (!entry.ready || entry.dc.readyState !== 'open') return;
  try { entry.dc.send(JSON.stringify(packet)); } catch (e) { /* dropped, peer-left will clean up */ }
}

function broadcastToPeers(packet) {
  for (var id in peers) safeSend(peers[id], packet);
}

function broadcastToOne(clientId, packet) {
  for (var id in peers) {
    if (peers[id].clientId === clientId) safeSend(peers[id], packet);
  }
}

// ---- engine events -> packets (same table as webrtcTransport.js, minus
// the local-player packetRouter.dispatch/recorder calls this build has
// neither of) ------------------------------------------------------------

var EVENT_MAP = {
  score:                packetBuilders.score,
  setTile:               packetBuilders.setTile,
  connectionsChanged:    packetBuilders.connections,
  spawnPointsChanged:    packetBuilders.spawnPoints,
  capture:               packetBuilders.capture,
  physicsChanged:        packetBuilders.physicsChanged,
  playerPhysicsChanged:  packetBuilders.playerPhysicsChanged,
  tileSettingsChanged:   packetBuilders.tileSettingsChanged,
  overlayStroke:         packetBuilders.overlayStroke,
  overlayUndo:           packetBuilders.overlayUndo,
  overlayClear:          packetBuilders.overlayClear,
  matchEnd:               packetBuilders.matchEnd,
  powerupPreview:        packetBuilders.powerupPreview,
  customTileUpsert:      packetBuilders.customTileUpsert,
  customTileCatalog:     packetBuilders.customTileCatalog,
  customTileDeleted:     packetBuilders.customTileDeleted,
  chat:                   packetBuilders.chat,
};

function wireHostEngineEvents() {
  Object.keys(EVENT_MAP).forEach(function (event) {
    var builder = EVENT_MAP[event];
    gi.emitter.on(event, function () {
      broadcastToPeers(builder.apply(null, arguments));
    });
  });

  gi.emitter.on('matchStateChanged', function () {
    broadcastToPeers(packetBuilders.matchState(gi.gameState));
    log('match state: ' + gi.gameState.state);

    if (gi.gameState.state === 'countdown') {
      for (var id in peers) {
        var entry = peers[id];
        if (entry.ready && !gi.gameState.getPlayer(entry.clientId) && (entry.client.team === 'red' || entry.client.team === 'blue')) {
          joinGameFor(entry.clientId, entry.client, entry.account);
        }
      }
    }
  });

  gi.emitter.on('powerupCollected', function (playerId, key, timerMs) {
    var packet = packetBuilders.powerupCollected(key, timerMs);
    broadcastToOne(playerId, packet);
  });

  gi.emitter.on('snapshot', function (deltas, immediate) {
    for (var id in peers) {
      var entry = peers[id];
      var delta = deltas.get(entry.clientId);
      if (delta) safeSend(entry, packetBuilders.snapshot(delta, immediate));
    }
  });
  // replayPlayers ignored - no recorder in this build, see header comment.
  gi.emitter.on('replayPlayers', function () {});
}

function setTeamFor(clientId, clientRec, accountRec, team, dispatch) {
  var previousTeam = clientRec.team;
  clientRec.team = team;
  dispatch({ type: 'team', team: team });

  if (team === previousTeam) return;
  var player = gi.gameState.getPlayer(clientId);
  if (player) {
    gi.gameHelpers.removePlayer(clientId);
    dispatch({ type: 'leftGame' });
    if (team === 'red' || team === 'blue') {
      var respawned = gi.gameHelpers.spawnPlayer(clientId, team, accountRec.display_name, accountRec.authed);
      dispatch({ type: 'joinedGame', player: serializePlayer(respawned) });
    }
  }
}

function joinGameFor(clientId, clientRec, accountRec) {
  if (gi.gameState.getPlayer(clientId)) return;
  if (clientRec.team !== 'red' && clientRec.team !== 'blue') return;
  var player = gi.gameHelpers.spawnPlayer(clientId, clientRec.team, accountRec.display_name, accountRec.authed);
  broadcastToOne(clientId, { type: 'joinedGame', player: serializePlayer(player) });
  if (gi.gameState.state === 'pregame') gi.matchManager.startMatch();
}

function verifyTagproToken(tagpro) {
  return TagproAuth.verifyToken(WORKER_URL, tagpro);
}

function handleOutgoingFor(clientId, entry, packet) {
  var clientRec = entry.client;
  var accountRec = entry.account;
  var dispatch = function (p) { safeSend(entry, p); };

  switch (packet.type) {
    case 'join_red':       return setTeamFor(clientId, clientRec, accountRec, 'red', dispatch);
    case 'join_blue':      return setTeamFor(clientId, clientRec, accountRec, 'blue', dispatch);
    case 'join_spectator': return setTeamFor(clientId, clientRec, accountRec, 'spectator', dispatch);
    case 'join_game':      return joinGameFor(clientId, clientRec, accountRec);
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
    case 'chat': {
      if (clientRec.muted) { dispatch({ type: 'error', message: 'You are muted in this room.' }); return; }
      var text = typeof packet.text === 'string' ? packet.text.trim().slice(0, 240) : '';
      if (!text) return;
      log('chat <' + accountRec.display_name + '> ' + text);
      broadcastToPeers(packetBuilders.chat({ id: clientId, name: accountRec.display_name, text: text }));
      return;
    }
    case 'identify': {
      if (typeof packet.name === 'string' && packet.name.trim()) {
        accountRec.display_name = packet.name.trim().slice(0, 20);
      }
      if (packet.tagpro && packet.tagpro.token) {
        verifyTagproToken(packet.tagpro).then(function (valid) {
          if (!valid) return;
          accountRec.authed = true;
          accountRec.display_name = packet.tagpro.reservedName;
          var p = gi.gameState.getPlayer(clientId);
          if (p) { p.authed = true; gi.emitter.emit('update', p); }
        });
      }
      return;
    }
    default: return;
  }
}

// ---- boot ----------------------------------------------------------------

function loadMapDoc(mapFile) {
  var raw = fs.readFileSync(path.join(MAPS_DIR, mapFile), 'utf8');
  return JSON.parse(raw);
}

async function boot() {
  log('minting room code...');
  await requestRoomCode();
  log('room code: ' + roomCode);

  log('connecting to signaling server...');
  await connectSignal(roomCode, args.password, args.name);
  log('signaling connected. peerId=' + myPeerId);

  var mapDoc = loadMapDoc(args.map);
  gi = new GameInstance(gameConfig, 'game');
  wireHostEngineEvents();
  gi.loadMap(mapDoc);
  gi.start();
  startStalePeerCheck();

  log('');
  log('==================================================');
  log(' Room code: ' + roomCode + (args.password ? ' (password protected)' : ''));
  log(' Join link: https://bambitp.github.io/BamBall/group/' + roomCode);
  log(' Map: ' + gi.gameState.mapName);
  log('==================================================');
  log('');
  startRepl();
}

// ---- terminal control -----------------------------------------------------

function describeEntry(entry) {
  return 'clientId=' + entry.clientId + ' name="' + entry.account.display_name + '" team=' + entry.client.team
    + (entry.account.authed ? ' [tagpro-verified]' : '');
}

function log(msg) { console.log('[host] ' + msg); }

function printStatus() {
  log('room ' + roomCode + ' | map ' + (gi ? gi.gameState.mapName : '?') + ' | match state: ' + (gi ? gi.gameState.state : '?'));
  var ids = Object.keys(peers);
  if (!ids.length) { log('no players connected'); return; }
  ids.forEach(function (id) {
    var entry = peers[id];
    log('  ' + (entry.ready ? 'ready' : 'connecting') + '  ' + describeEntry(entry));
  });
}

function printHelp() {
  log('commands:');
  log('  status              room/match/player summary');
  log('  players             list connected players');
  log('  start               force-start the match now');
  log('  reset               reset the current match');
  log('  pause / resume      pause/resume the match');
  log('  map <file>          switch map (file under assets/maps/, e.g. moai2.json)');
  log('  kick <clientId>     kick a player (they can rejoin)');
  log('  ban <clientId>      kick + IP-ban a player');
  log('  mute <clientId>     toggle mute for a player');
  log('  quit                shut down the host and disconnect everyone');
}

function switchMap(mapFile) {
  var mapDoc;
  try { mapDoc = loadMapDoc(mapFile); } catch (e) { log('could not load ' + mapFile + ': ' + e.message); return; }
  gi.gameState.players.slice().forEach(function (p) { gi.gameHelpers.removePlayer(p.id); });
  gi.loadMap(mapDoc);
  for (var id in peers) peers[id].client.team = 'spectator';
  broadcastToPeers(Object.assign({ type: 'mapChanged' }, mapDataFrom(gi.gameState)));
  log('switched to ' + gi.gameState.mapName);
}

function shutdown() {
  log('shutting down...');
  for (var id in peers) {
    safeSend(peers[id], { type: 'kicked', message: 'The host is shutting down.' });
    if (peers[id].pc) peers[id].pc.close();
  }
  if (gi) gi.stop();
  if (signalWs) signalWs.close(1000);
  setTimeout(function () { process.exit(0); }, 500);
}

function startRepl() {
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  printHelp();
  rl.prompt();

  rl.on('line', function (line) {
    var parts = line.trim().split(/\s+/);
    var cmd = parts[0];
    var arg = parts[1];

    if (cmd === 'status') printStatus();
    else if (cmd === 'players') printStatus();
    else if (cmd === 'start') { gi.matchManager.startMatch(); log('match start requested'); }
    else if (cmd === 'reset') { gi.matchManager.resetMatch(); log('match reset'); }
    else if (cmd === 'pause') { gi.matchManager.pauseMatch(); log('match paused'); }
    else if (cmd === 'resume') { gi.matchManager.resumeMatch(); log('match resumed'); }
    else if (cmd === 'map' && arg) switchMap(arg.indexOf('.json') === -1 ? arg + '.json' : arg);
    else if (cmd === 'kick' && arg) log(kickClient(Number(arg)) ? 'kicked ' + arg : 'no such player');
    else if (cmd === 'ban' && arg) log(banClient(Number(arg)) ? 'banned ' + arg : 'no such player');
    else if (cmd === 'mute' && arg) {
      var found = findPeerEntry(Number(arg));
      if (found) { found.entry.client.muted = !found.entry.client.muted; log((found.entry.client.muted ? 'muted ' : 'unmuted ') + arg); }
      else log('no such player');
    }
    else if (cmd === 'quit' || cmd === 'exit') { rl.close(); shutdown(); return; }
    else if (cmd === 'help' || cmd === '') printHelp();
    else log('unknown command "' + cmd + '" - try "help"');

    rl.prompt();
  });

  rl.on('SIGINT', shutdown);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

boot().catch(function (err) {
  console.error('[host] boot failed:', err);
  process.exit(1);
});
