(function () {
// tileLogic.js - the logic dispatch file. Rules for this file:
//   - ifs may check tile name, player team, player flags, and match state
//   - each if body is exactly one handler call from tileHandlers.js
//   - no scheduling, no emitting, no state mutation happens here

var createTileHandlers = (typeof require === 'function') ? require('./tileHandlers') : globalThis.createTileHandlers;
var POWERUP_TYPES      = (typeof require === 'function') ? require('./powerupTypes') : globalThis.PowerupTypes;

var setupTileLogic = function setupTileLogic(instance) {
  const { gameState, gameHelpers, physicsHelpers, gravityLogic, config, emitter } = instance;

  const handlers = createTileHandlers(gameState, gameHelpers, physicsHelpers, gravityLogic, config, emitter);

  // Captures count in pregame (warm-up), live, and overtime. Pregame
  // scores are wiped by startMatch's resetField, and the win-condition
  // check in matchManager ignores anything outside live/overtime.
  function captureAllowed() {
    return gameState.state === 'pregame'
        || gameState.state === 'live'
        || gameState.state === 'overtime';
  }

  // Belt-and-suspenders for the same toggle gameHelpers.enforcePowerupToggles
  // already reacts to: a pad being disabled flips to empty on its own
  // microtask, so this only matters for a same-tick contact right as that
  // happens.
  function powerupEnabled(tileId) {
    const type = POWERUP_TYPES.find(p => p.id === tileId);
    return !type || config[type.configKey];
  }

  // Called once per contact with an arbitrary (player, other) assignment -
  // both sides must be checked for tagpro/flag since the contact doesn't
  // know which body was dataA vs dataB.
  function handlePlayerPlayerBegin(player, other) {
    if (player.dead || other.dead) return;
    if (player.team === other.team) return;

    const playerTagpro = player.tagpro;
    const otherTagpro  = other.tagpro;
    const playerFlag   = !!player.hasFlag;
    const otherFlag    = !!other.hasFlag;

    // Both shielded: the shields cancel each other out, unless one of them
    // is also carrying a flag - a flag always breaks the standoff.
    if (playerTagpro && otherTagpro) {
      if (playerFlag || otherFlag) handlers.mutualPop(player, other);
      return;
    }

    if (playerTagpro) {
      handlers.tagproPop(player, other);
      return;
    }
    if (otherTagpro) {
      handlers.tagproPop(other, player);
      return;
    }

    if (playerFlag && otherFlag) {
      handlers.mutualPop(player, other);
    } else if (otherFlag) {
      handlers.flagTagPop(player, other);
    } else if (playerFlag) {
      handlers.flagTagPop(other, player);
    }
  }

  function handlePlayerBegin(player, other) {
    if (player.dead) return;

    // Gravity-mode jump refill: touching a wall counts as "grounded" -
    // untested guess for what should grant a jump back, easy to swap for a
    // narrower check (e.g. only the bottom-facing contact normal) later.
    if (other.category === 'wall') {
      handlers.resetJump(player);
    }

    if (other.name === 'Boost') {
      handlers.boost(player, other);
    }

    if (other.name === 'RedBoost' && player.team === 'red') {
      handlers.redBoost(player, other);
    }

    if (other.name === 'BlueBoost' && player.team === 'blue') {
      handlers.blueBoost(player, other);
    }

    if (other.name === 'Bomb') {
      handlers.bomb(player, other);
    }

    if (other.name === 'Spike') {
      handlers.spike(player);
    }

    if (other.name === 'RedFlag' && player.team === 'blue' && !player.hasFlag) {
      handlers.flagPickup(player, other);
    }

    if (other.name === 'BlueFlag' && player.team === 'red' && !player.hasFlag) {
      handlers.flagPickup(player, other);
    }

    if (other.name === 'YellowFlag' && !player.hasFlag) {
      handlers.flagPickup(player, other);
    }

    if ((other.name === 'RedGoal' || other.name === 'RedFlag')
        && player.team === 'red' && player.hasFlag && captureAllowed()) {
      handlers.flagCapture(player);
    }

    if ((other.name === 'BlueGoal' || other.name === 'BlueFlag')
        && player.team === 'blue' && player.hasFlag && captureAllowed()) {
      handlers.flagCapture(player);
    }

    // Eggball: either goal counts, regardless of color - unlike the flag
    // capture rule just above (return-to-your-own-base), reaching a goal AT
    // ALL while carrying is the point. config.eggballEnabled gates this so
    // a RedGoal/BlueGoal tile placed on a map keeps its ordinary flag-
    // capture meaning (the two rules aren't mutually exclusive by tile name
    // alone - eggballEnabled is what tells them apart).
    if ((other.name === 'RedGoal' || other.name === 'BlueGoal')
        && player.hasEgg && config.eggballEnabled && captureAllowed()) {
      handlers.eggballScore(player);
    }

    if (other.name === 'PupJJ' && powerupEnabled(other.id)) {
      handlers.pupJukeJuice(player, other);
    }

    if (other.name === 'PupRB' && powerupEnabled(other.id)) {
      handlers.pupRollingBomb(player, other);
    }

    if (other.name === 'PupTP' && powerupEnabled(other.id)) {
      handlers.pupTagpro(player, other);
    }

    if (other.name === 'PupEmpty' && config.kothPowerup) {
      handlers.pupContestBegin(player, other);
    }

    if (other.name === 'RedTeamTile' && player.team === 'red' && !player.hasFlag) {
      handlers.teamTileEnter(player, other);
    }

    if (other.name === 'BlueTeamTile' && player.team === 'blue' && !player.hasFlag) {
      handlers.teamTileEnter(player, other);
    }

    if (other.name === 'YellowTeamTile' && !player.hasFlag) {
      handlers.teamTileEnter(player, other);
    }

    if (other.name === 'Portal') {
      handlers.portalEnter(player, other);
    }

    if (other.name === 'RedPortal' && player.team === 'red') {
      handlers.portalEnter(player, other);
    }

    if (other.name === 'BluePortal' && player.team === 'blue') {
      handlers.portalEnter(player, other);
    }

    if (other.name === 'Button') {
      handlers.buttonPress(player, other);
    }

    if (other.name === 'RedGate' && player.team !== 'red') {
      handlers.gate(player);
    }

    if (other.name === 'BlueGate' && player.team !== 'blue') {
      handlers.gate(player);
    }

    if (other.name === 'GreenGate') {
      handlers.gate(player);
    }
  }

  function handlePlayerEnd(player, other) {
    if (other.name === 'RedTeamTile' && player.team === 'red') {
      handlers.teamTileExit(player, other);
    }

    if (other.name === 'BlueTeamTile' && player.team === 'blue') {
      handlers.teamTileExit(player, other);
    }

    if (other.name === 'YellowTeamTile') {
      handlers.teamTileExit(player, other);
    }

    if (other.name === 'Portal') {
      handlers.portalExit(player, other);
    }

    if (other.name === 'RedPortal' && player.team === 'red') {
      handlers.portalExit(player, other);
    }

    if (other.name === 'BluePortal' && player.team === 'blue') {
      handlers.portalExit(player, other);
    }

    if (other.name === 'Button') {
      handlers.buttonRelease(player, other);
    }

    // Not gated on config.kothPowerup like the Begin side (line 126) -
    // a contest can have started while the toggle was on, and this has to
    // be free to clean it up even if the toggle flipped off mid-contest.
    // pupContestEnd is a no-op if the tile was never tracking contestants.
    if (other.name === 'PupEmpty') {
      handlers.pupContestEnd(player, other);
    }
  }

  // koth mode: schedulePowerupSpawn awards a spawning pad to the contestant
  // who's held it longest instead of waiting for a fresh contact, then fires
  // this so the pickup goes through the same handler a normal touch would.
  function handlePowerupClaim(player, tile) {
    if (player.dead) return;

    if (tile.name === 'PupJJ') {
      handlers.pupJukeJuice(player, tile);
    } else if (tile.name === 'PupRB') {
      handlers.pupRollingBomb(player, tile);
    } else if (tile.name === 'PupTP') {
      handlers.pupTagpro(player, tile);
    }
  }

  emitter.on('playerBegin', handlePlayerBegin);
  emitter.on('playerPlayerBegin', handlePlayerPlayerBegin);
  emitter.on('playerEnd', handlePlayerEnd);
  emitter.on('powerupClaim', handlePowerupClaim);
};

if (typeof module !== 'undefined' && module.exports) module.exports = setupTileLogic;
if (typeof globalThis !== 'undefined') globalThis.setupTileLogic = setupTileLogic;
})();
