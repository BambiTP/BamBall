#!/usr/bin/env node
// hostCli.js - headless, terminal-controlled P2P host. Runs the exact same
// authoritative engine/ code the browser host (local/webrtcTransport.js)
// does, and drives it through the exact same local/hostSession.js every
// browser host uses - the only real differences from a browser host are
// this file's own concerns: no local player (nobody plays FROM the
// terminal), no replay recording (local/localReplayRecorder.js wasn't
// audited for Node-compatibility), Node's `ws`/`@roamhq/wrtc` in place of
// the browser's native WebSocket/RTCPeerConnection (same wire protocol
// either way - the Worker and any browser peer can't tell the difference),
// and terminal I/O instead of a rendered page.

const WebSocket = require('ws');
const wrtc = require('@roamhq/wrtc');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const GameInstance = require('../engine/gameInstance.js');
const gameConfig = require('../engine/gameConfig.js');
const HostSession = require('../local/hostSession.js');
const { importFortunateMap } = require('./fortunateMapsImport.js');

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

var gi = null;
var session = null;
var roomCode = null;

function log(msg) { console.log('[host] ' + msg); }

function loadMapDoc(mapFile) {
  var raw = fs.readFileSync(path.join(MAPS_DIR, mapFile), 'utf8');
  return JSON.parse(raw);
}

// mapArg is either a bundled file under assets/maps/ (the REPL's own
// `map <file>` command and --map= boot flag - local admin convenience,
// unrelated to what a leader can do) or a bare Fortunate Maps id (what a
// connected browser leader's Settings tab always sends - see
// local/controlPanel.js / local/fortunateMapsImport.js, and hostSession.js's
// 'changeMap' case below via resolveMap).
async function resolveMapArg(mapArg) {
  var isFortunateId = /^\d+$/.test(mapArg);
  var mapDoc = isFortunateId ? await importFortunateMap(WORKER_URL, mapArg) : loadMapDoc(mapArg);
  return { mapDoc: mapDoc, mapMeta: isFortunateId ? { type: 'fortunatemaps', id: mapArg } : null };
}

// A packet-driven changeMap's mapId is always a bare Fortunate Maps id
// (numeric) - never a bundled filename, which only the terminal itself can
// reach.
function resolveMap(mapId) {
  return importFortunateMap(WORKER_URL, mapId).then(function (mapDoc) {
    return { mapDoc: mapDoc, mapMeta: { type: 'fortunatemaps', id: String(mapId) } };
  });
}

async function switchMap(mapArg) {
  try {
    var resolved = await resolveMapArg(mapArg);
  } catch (e) {
    log('could not load ' + mapArg + ': ' + e.message);
    return;
  }
  session.switchMap(resolved.mapDoc, resolved.mapMeta);
  log('switched to ' + gi.gameState.mapName);
}

// ---- boot ----------------------------------------------------------------

async function boot() {
  gi = new GameInstance(gameConfig, 'game');
  session = HostSession.createHostSession(gi, {
    RTCPeerConnection: wrtc.RTCPeerConnection,
    WebSocket: WebSocket,
    iceServers: ICE_SERVERS,
    workerUrl: WORKER_URL,
    signalUrl: SIGNAL_URL,
    log: log,
    resolveMap: resolveMap,
    // No local client, no recorder, no onDuplicateDevice/onMatchStateApplied/
    // onReplayFinished - this process has no local player, no replay
    // recording, and no UI to notify.
  });
  session.wireEngineEvents();

  log('minting room code...');
  roomCode = await session.requestRoomCode();
  log('room code: ' + roomCode);

  log('connecting to signaling server...');
  await session.connectSignalAsHost(roomCode, args.password, args.name);
  log('signaling connected.');

  var mapDoc = loadMapDoc(args.map);
  gi.loadMap(mapDoc);
  gi.start();
  session.startStalePeerCheck();

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

function printStatus() {
  log('room ' + roomCode + ' | map ' + (gi ? gi.gameState.mapName : '?') + ' | match state: ' + (gi ? gi.gameState.state : '?'));
  var list = session.listConnections();
  if (!list.length) { log('no players connected'); return; }
  list.forEach(function (c) {
    log('  ' + (c.ready ? 'ready' : 'connecting') + '  clientId=' + c.clientId + ' name="' + c.name + '" team=' + c.team
      + (c.leader ? ' [leader]' : '') + (c.authed ? ' [tagpro-verified]' : ''));
  });
}

function printHelp() {
  log('commands:');
  log('  status              room/match/player summary');
  log('  players             list connected players');
  log('  start               force-start the match now');
  log('  reset               reset the current match');
  log('  pause / resume      pause/resume the match');
  log('  map <file|id>       switch map (a file under assets/maps/, e.g. moai2.json, or a bare Fortunate Maps id, e.g. 98939)');
  log('  kick <clientId>     kick a player (they can rejoin)');
  log('  ban <clientId>      kick + IP-ban a player');
  log('  mute <clientId>     toggle mute for a player');
  log('  promote <clientId>  grant leader (kick/mute/ban/match control) to a player');
  log('  demote <clientId>   revoke leader from a player');
  log('  quit                shut down the host and disconnect everyone');
}

function shutdown() {
  log('shutting down...');
  if (session) session.shutdown('The host is shutting down.');
  if (gi) gi.stop();
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
    else if (cmd === 'map' && arg) switchMap(/^\d+$/.test(arg) || arg.indexOf('.json') !== -1 ? arg : arg + '.json');
    else if (cmd === 'kick' && arg) log(session.kickClient(Number(arg)) ? 'kicked ' + arg : 'no such player');
    else if (cmd === 'ban' && arg) log(session.banClient(Number(arg)) ? 'banned ' + arg : 'no such player');
    else if (cmd === 'mute' && arg) {
      var c = session.findClient(Number(arg));
      if (c) log(session.setMuted(Number(arg), !c.client.muted) ? ((c.client.muted ? 'muted ' : 'unmuted ') + arg) : 'no such player');
      else log('no such player');
    }
    else if (cmd === 'promote' && arg) log(session.promoteToLeader(Number(arg)) ? 'promoted ' + arg + ' to leader' : 'no such player');
    else if (cmd === 'demote' && arg) log(session.demoteFromLeader(Number(arg)) ? 'demoted ' + arg : 'no such player');
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
