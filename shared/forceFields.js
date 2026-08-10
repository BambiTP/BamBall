// forceFields.js - shared per-tick radial force math. Required by the
// server (game/physicsHelpers.js) and loaded as a <script> by the client
// (client/game/loop.js), so both sides compute gravity wells (and any future
// radial field) from the exact same formula instead of two hand-kept copies.
//
// A field is plain data: { x, y, radius, strength, falloff, mode }. Nothing
// here touches Box2D or the DOM, so it can run identically on either side.
var ForceFields = {

  // Magnitude of the pull/push at `dist` tiles from the field center,
  // ignoring direction. Zero once outside `radius`.
  falloffMagnitude: function (dist, field) {
    if (dist >= field.radius) return 0;

    switch (field.falloff) {
      case 'constant':
        return field.strength;
      case 'inverseSquare':
        var safeDist = Math.max(dist, field.minDist || 0.1);
        return field.strength / (safeDist * safeDist);
      case 'linear':
      default:
        return field.strength * (1 - dist / field.radius);
    }
  },

  // Per-tick velocity delta one field applies to a body at (x, y).
  velocityDelta: function (x, y, field) {
    var dx   = field.x - x;
    var dy   = field.y - y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6 || dist >= field.radius) return { dx: 0, dy: 0 };

    var magnitude = ForceFields.falloffMagnitude(dist, field);
    var sign      = field.mode === 'repel' ? -1 : 1;
    var scale     = (sign * magnitude) / dist;

    return { dx: dx * scale, dy: dy * scale };
  },

  // Applies every field to one body's velocity and returns the new {vx, vy}.
  // Fields stack additively - a body between two wells feels both.
  applyFields: function (x, y, vx, vy, fields) {
    var nvx = vx;
    var nvy = vy;

    for (var i = 0; i < fields.length; i++) {
      var delta = ForceFields.velocityDelta(x, y, fields[i]);
      nvx += delta.dx;
      nvy += delta.dy;
    }

    return { vx: nvx, vy: nvy };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ForceFields;
}
