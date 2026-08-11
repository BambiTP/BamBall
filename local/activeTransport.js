// activeTransport.js - thin indirection so settingsFiles.js/settingsMaker.js
// don't need to know or care whether they're talking to localTransport.js
// (solo build) or webrtcTransport.js (host/peer) - both expose the same
// shape (gameInstance/matchState/switchMap/workerUrl/getRoomCode), set
// here once local/main.js's mode-select screen decides which one boots.
var activeTransport = null;
