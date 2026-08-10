(function () {
const { tileToWorld } = (typeof require === 'function') ? require('./coords') : globalThis.Coords;
const { TILE_ID }     = (typeof require === 'function') ? require('./tiles/physicsData') : globalThis.PhysicsData;

// Button-triggered bombs, and the button-press -> gate red/blue count ->
// gate color evaluation loop. Split out of gameHelpers.js
// (CODEBASE_AUDIT.md) - tileSetting/scheduleTimeout/scheduleTileChange/
// cancelTimeout are shared primitives on gameHelpers.js itself, reached
// here via `this.` since the merged gameHelpers object is what every call
// site actually calls through.
var createGateLogic = function(gameState, physicsHelpers, config, emitter) {
  return {
    triggerBomb(x, y) {
      const pos      = tileToWorld(x, y);
      const affected = physicsHelpers.applyExplosion(pos.x, pos.y,
        this.tileSetting(x, y, 'bombRadius'), this.tileSetting(x, y, 'bombStrength'));
      this.scheduleTileChange(x, y, 10.1);
      this.scheduleTimeout(() => this.scheduleTileChange(x, y, 10), this.tileSetting(x, y, 'bombCooldown'));
      return affected;
    },

    evaluateGate(gate) {
      if (gate.red > gate.blue) {
        gate.currentState = 9.2;
        this.scheduleTileChange(gate.x, gate.y, 9.2);
      } else if (gate.blue > gate.red) {
        gate.currentState = 9.3;
        this.scheduleTileChange(gate.x, gate.y, 9.3);
      }
    },

    // switchGates/switchBombs are ?? [] guarded: a palette-painted button
    // (map edit mode) has no wiring fields until the connect tool sets
    // them, and an unguarded for-of here would throw inside the tick loop
    // and crash the whole room the moment someone stepped on it.
    buttonBegin(player, button) {
      for (const { x, y } of button.switchGates ?? []) {
        const gate = gameState.getTile(x, y);
        if (!gate) continue;
        if (gate.stickyHandler) {
          this.cancelTimeout(gate.stickyHandler);
          gate.stickyHandler = null;
        }
        gate[player.team]++;
        this.evaluateGate(gate);
      }
      for (const { x, y } of button.switchBombs ?? []) {
        const bomb = gameState.getTile(x, y);
        if (!bomb || bomb.id !== TILE_ID.BOMB) continue;
        this.triggerBomb(x, y);
      }
    },

    buttonEnd(player, button) {
      for (const { x, y } of button.switchGates ?? []) {
        const gate = gameState.getTile(x, y);
        if (!gate) continue;
        gate[player.team] = Math.max(0, gate[player.team] - 1);
        this.evaluateGate(gate);
        if (gate.red === 0 && gate.blue === 0 && !gate.stickyHandler) {
          gate.stickyHandler = this.scheduleTimeout(() => {
            gate.currentState = gate.defaultState;
            gate.stickyHandler = null;
            emitter.emit('setTile', gate.x, gate.y, gate.defaultState);
          }, button.switchTimer);
        }
      }
    },
  };
};

if (typeof module !== 'undefined' && module.exports) module.exports = createGateLogic;
if (typeof globalThis !== 'undefined') globalThis.createGateLogic = createGateLogic;

})();
