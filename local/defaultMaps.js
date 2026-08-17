// defaultMaps.js - curated Fortunate Maps ids for the Settings tab's Map
// section, so a leader can jump straight to a known map instead of
// hunting for an id to paste in by hand. A fixed list, not user-editable
// like local/localPresets.js - add/remove ids here directly to change
// what shows up for everyone.

// CTF maps.
var DEFAULT_MAPS = [74431, 73746, 75927, 74452, 80139, 96554, 80147, 97194, 93636, 97193];

// The map Eggball mode is actually built for (has RedGoal/BlueGoal tiles
// wired up the way this mode needs - most CTF maps don't). local/
// localPresets.js's "Eggball" preset loads this alongside turning the mode
// on, and it's also offered as its own button in the Map section.
var EGGBALL_MAP_ID = 68205;
