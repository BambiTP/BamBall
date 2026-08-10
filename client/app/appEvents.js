// appEvents.js - a small cross-cutting event bus for signals that don't
// belong to one specific state module (menu toggling, chat focus requests,
// debug-log lines, edit-mode player-selection toggles). input/ and render/
// emit on this; ui/ subscribes. Keeps input/render from importing ui/
// directly just to flip a DOM panel open.

var appEvents = createEventBus();
