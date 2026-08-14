# node-host

A headless, terminal-controlled P2P host for BambiPro. Runs the exact same
authoritative simulation the browser host (`local/webrtcTransport.js`) does
- `engine/` and `shared/` are already written to run under plain
  `require()` in Node (no bundler, no adaptation) - this just drives them
  from a terminal instead of a browser tab, using
  [`@roamhq/wrtc`](https://github.com/roamhq/node-webrtc) for WebRTC and
  [`ws`](https://github.com/websockets/ws) for the signaling WebSocket.

No rendering, no DOM, no local player - this process's only job is running
the match and relaying packets between peers, connecting to the same
production Worker (`api.bambipro.workers.dev`) any browser host would.

## Setup

```
cd node-host
npm install
```

## Run

```
node hostCli.js [--password=<pw>] [--name=<host display name>] [--map=<file.json>]
```

`--map` is a filename under `assets/maps/` (default `default.json`). On
boot it mints a room code from the Worker (same as clicking "Create Group"
in the browser) and prints a join link. Players connect from the normal
browser client - they can't tell this host apart from a browser one.

## Terminal commands

```
status              room/match/player summary
players             list connected players
start               force-start the match now
reset               reset the current match
pause / resume      pause/resume the match
map <file>          switch map (file under assets/maps/, e.g. moai2.json)
kick <clientId>     kick a player (they can rejoin)
ban <clientId>      kick + IP-ban a player
mute <clientId>     toggle mute for a player
quit                shut down the host and disconnect everyone
```

## Known gaps vs. the browser host

- **No replay recording.** `local/localReplayRecorder.js` wasn't audited
  for Node-compatibility - matches run fully, they just don't get a saved
  replay from this host.
- **No local player.** This is a pure dedicated host; nobody plays from
  the terminal itself.
