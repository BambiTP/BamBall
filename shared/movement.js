// movement.js - the player velocity-update formula, shared between the
// server (authoritative, game/physicsHelpers.js) and the client (local
// prediction, client/game/simulation/movement.js) so the two can never
// hand-drift apart the way they used to (the client's loop.js re-typed this
// formula by hand, with only a code comment - not the compiler - keeping it
// in sync). Pure function: callers own body/tile lookups, this only does
// the velocity math.
//
// Isomorphic module (CommonJS + plain global), same pattern as
// forceFields.js in this directory: required by the
// server, <script>-tagged by the client.
function movePlayerVelocity(vx, vy, floorFriction, accel, maxSpeed, keys) {
  var friction = 1 - floorFriction;
  var nvx = vx * friction;
  var nvy = vy * friction;

  if (keys.left  && nvx > -maxSpeed) nvx -= accel;
  if (keys.right && nvx <  maxSpeed) nvx += accel;
  if (keys.up    && nvy > -maxSpeed) nvy -= accel;
  if (keys.down  && nvy <  maxSpeed) nvy += accel;

  return { vx: nvx, vy: nvy };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { movePlayerVelocity: movePlayerVelocity };
}
