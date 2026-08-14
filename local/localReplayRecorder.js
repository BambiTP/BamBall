// localReplayRecorder.js - browser port of server/replay/replayRecorder.js.
// Same record shape (shared/replayFormat.js's RECORD_TYPE envelope, so
// client/replay/'s existing reader needs no changes to play one of these
// back), same accumulate-in-memory-then-flush-once approach - only the
// flush target changes: no filesystem here, so finish() hands back a Blob
// (gzip'd via the browser's native CompressionStream when available,
// plain NDJSON text otherwise) for the caller to offer as a download.
//
// Manual pregame recording (confirmed requirement): the real server only
// ever starts recording automatically, the instant a match goes live
// (server/packets/outgoing.js's matchStateChanged listener). This version
// exposes start()/stop() directly so a host can begin recording during
// pregame warm-up on demand, not only once a real match starts.

function createLocalReplayRecorder(gameInstance) {
  var startMs   = Date.now();
  var lastInput = new Map();
  var lines     = [];
  var ended     = false;
  var recording = false;

  var gameState     = gameInstance.gameState;
  var matchManager   = gameInstance.matchManager;
  var physicsLookup = gameInstance.physicsLookup;

  var prevStep = 0;
  var prevMs   = 0;

  function write(typeCode, payload) {
    if (!recording) return;
    var step = gameState.stepCount;
    var ms   = Date.now() - startMs;
    lines.push(JSON.stringify([typeCode, step - prevStep, ms - prevMs, payload]));
    prevStep = step;
    prevMs   = ms;
  }

  // mapData: same shape localTransport.js's mapDataFrom() already builds
  // for the 'joined' packet - passed in rather than recomputed here.
  function recordSetup(mapData) {
    write(RECORD_TYPE.SETUP, Object.assign({}, mapData, {
      physics:           matchManager.getPhysics(),
      physicsDefaults:   matchManager.getPhysicsDefaults(),
      physicsCategories: matchManager.getPhysicsCategories(),
      settingsSchema: {
        physics: matchManager.getPhysicsSchemaMeta(),
        match:   matchManager.getMatchSchemaMeta(),
      },
      tileCategories: tileCategoriesOf(physicsLookup),
      matchSettings: gameState.matchSettings,
      matchSettingsDefaults: MatchSettings.DEFAULT_SETTINGS,
      matchState: gameState.state,
      scores: gameState.scores,
      roster: gameState.players.map(function (p) { return { id: p.id, name: p.name, team: p.team }; }),
    }));
  }

  function recordBroadcast(packet) {
    write(RECORD_TYPE.BROADCAST, packet);
  }

  function recordPlayerDelta(delta) {
    if (!delta.updated.length && !delta.removed.length) return;
    write(RECORD_TYPE.PLAYERS, { u: delta.updated, r: delta.removed });
  }

  function recordInput(playerId, input) {
    var prev = lastInput.get(playerId);
    if (prev && prev.left === input.left && prev.right === input.right
        && prev.up === input.up && prev.down === input.down) return;
    lastInput.set(playerId, input);
    write(RECORD_TYPE.INPUT, [playerId, encodeInputMask(input)]);
  }

  // Starts (or resumes into) recording. mapData is required the first time
  // (it seeds the SETUP record every reader needs as its first line);
  // omit it on a resume after stop().
  function start(mapData) {
    if (recording) return;
    recording = true;
    if (!lines.length) recordSetup(mapData);
  }

  function stop() {
    recording = false;
  }

  function isRecording() {
    return recording;
  }

  // Returns a Promise<Blob> - gzip'd (.ndjson.gz, matching the server's own
  // file extension/format exactly) when CompressionStream exists, otherwise
  // plain NDJSON text so older browsers still get a working download.
  function finish(endData) {
    recording = true; // force the END record through even if stop() was called
    write(RECORD_TYPE.END, endData || { scores: gameState.scores });
    ended = true;
    recording = false;

    var text = lines.join('\n') + '\n';

    if (typeof CompressionStream === 'function') {
      var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(stream).blob().then(function (blob) {
        return { blob: blob, filename: 'replay-' + startMs + '.ndjson.gz', gzip: true };
      });
    }
    return Promise.resolve({ blob: new Blob([text], { type: 'application/x-ndjson' }), filename: 'replay-' + startMs + '.ndjson', gzip: false });
  }

  function isEnded() {
    return ended;
  }

  return {
    start: start, stop: stop, isRecording: isRecording, isEnded: isEnded,
    recordBroadcast: recordBroadcast, recordPlayerDelta: recordPlayerDelta, recordInput: recordInput,
    finish: finish, startedAt: startMs,
  };
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// Stores a finished recording permanently at api.bamball.workers.dev's
// /replays/<roomCode> (confirmed requirement: replays live on the server,
// keyed by the room's own unique code, forever). X-Replay-Gzip tells the
// Worker whether to hand it back as opaque gzip bytes or plain text - see
// worker/src/index.js's header comment for why this isn't a normal
// Content-Encoding.
// meta (optional): { mapName, mapId, winner, reason, scores } - stored as
// R2 customMetadata (worker/src/index.js handleUploadReplay) so a replay
// browsing page can list something more useful than a bare room code
// without downloading and decompressing every replay just to show a list.
function uploadReplay(workerUrl, roomCode, blob, gzip, meta) {
  var headers = { 'X-Replay-Gzip': gzip ? '1' : '0' };
  if (meta) headers['X-Replay-Meta'] = JSON.stringify(meta);
  return fetch(workerUrl + '/api/replays/' + roomCode, {
    method: 'PUT',
    headers: headers,
    body: blob,
  }).then(function (res) {
    if (!res.ok) throw new Error('replay upload failed: ' + res.status);
    return res.json();
  });
}
