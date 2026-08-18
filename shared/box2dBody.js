// box2dBody.js - low-level Box2D body operations shared between the
// server's authoritative physics (engine/physicsWorld.js) and the client's
// prediction physics (client/physicsWorld.js), so the two wrapper surfaces
// can't hand-drift apart the way they used to (both files independently
// defined identical getPosition/setVelocity/step/etc. bodies). Same
// isomorphic pattern as movement.js/forceFields.js in this
// directory: required by the server, <script>-tagged by the client.
//
// Box2DBody is a mixin, not a class: Object.assign(PhysicsWorld.prototype,
// Box2DBody) onto a class whose instances already have `this.world` set to
// a b2World. That keeps every existing call site (physicsWorld.getPosition
// (body), etc.) working unchanged - only the two PhysicsWorld classes
// themselves change, not their callers.
//
// buildShapeFromTileData is a plain function, not part of the mixin: both
// engine/physicsWorld.js's makeBody (any tile, sensor or solid) and
// client/physicsWorld.js's makeWallBody (walls only) build a Box2D shape
// from the exact same {type, vectors, size} tile-data shape, just sourced
// from different tables (engine/tiles/physicsData.js vs. client's smaller
// wall-only WALL_PHYSICS_DATA).

var Box2D = (typeof require === 'function') ? require('./Box2dWeb-2.1.a.3') : globalThis.Box2D;

var b2Vec2         = Box2D.Common.Math.b2Vec2;
var b2BodyDef      = Box2D.Dynamics.b2BodyDef;
var b2Body         = Box2D.Dynamics.b2Body;
var b2FixtureDef   = Box2D.Dynamics.b2FixtureDef;
var b2CircleShape  = Box2D.Collision.Shapes.b2CircleShape;
var b2PolygonShape = Box2D.Collision.Shapes.b2PolygonShape;

// tileData: { type: 'vector'|'square'|'circle', vectors?, size? }.
// tileSize: pixels-per-tile (both callers pass 40, i.e. coords.js's
// TILE_SIZE) - sizes in tileData are stored in pixels, shapes are in tiles.
function buildShapeFromTileData(tileData, tileSize) {
  if (tileData.type === 'vector') {
    var shape = new b2PolygonShape();
    shape.SetAsArray(tileData.vectors.map(function (v) { return new b2Vec2(v.x, v.y); }));
    return shape;
  }
  if (tileData.type === 'square') {
    var shape = new b2PolygonShape();
    shape.SetAsBox(tileData.size / 2 / tileSize, tileData.size / 2 / tileSize);
    return shape;
  }
  if (tileData.type === 'circle') {
    return new b2CircleShape(tileData.size / 2 / tileSize);
  }
  return null;
}

var Box2DBody = {
  step: function (timeStep) {
    this.world.Step(timeStep, 8, 3);
    this.world.ClearForces();
  },

  destroyBody: function (body) {
    if (body) this.world.DestroyBody(body);
  },

  getPosition: function (body) {
    var pos = body.GetPosition();
    return { x: pos.x, y: pos.y };
  },

  getVelocity: function (body) {
    var vel = body.GetLinearVelocity();
    return { x: vel.x, y: vel.y };
  },

  setVelocity: function (body, x, y) {
    body.SetLinearVelocity(new b2Vec2(x, y));
  },

  setPosition: function (body, x, y) {
    body.SetPosition(new b2Vec2(x, y));
  },

  applyForce: function (body, x, y) {
    body.ApplyForce(new b2Vec2(x, y), body.GetWorldCenter());
  },

  getMass: function (body) {
    return body.GetMass();
  },

  getAngle: function (body) {
    return body.GetAngle();
  },

  setSensor: function (body, bool) {
    for (var f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetSensor(bool);
    }
  },

  setDamping: function (body, linear, angular) {
    body.SetLinearDamping(linear);
    body.SetAngularDamping(angular);
  },

  setFriction: function (body, value) {
    for (var f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetFriction(value);
    }
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Box2DBody: Box2DBody, buildShapeFromTileData: buildShapeFromTileData };
}
if (typeof globalThis !== 'undefined') {
  globalThis.Box2DBody = Box2DBody;
  globalThis.buildShapeFromTileData = buildShapeFromTileData;
}
