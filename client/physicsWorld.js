// physicsWorld.js - the local Box2D world: walls + balls,
// mirroring the server's game/physicsWorld.js. Requires Box2dWeb-2.1.a.3.js
// (global Box2D) loaded first. Units: 1 = one tile, same as the server.
//
// Reads settingsState for wall-surface overrides instead of reaching into a
// global `game` object directly (the old clientPhysics.js read `game.
// tileOverrides` inline) - this is the only state/ dependency this module
// has, and it never writes back into state/ itself.

var physConfig = {
  gravityX: 0,
  gravityY: 0,

  radius:         0.475,
  density:        1,      // TagPro server fixture: { density: 1 }
  friction:       0.5,
  restitution:    0.2,
  linearDamping:  0.5,
  angularDamping: 0.5,
  playerFriction: 0.5,

  accel:    0.0625,
  maxSpeed: 6.25,

  wallRestitution: 0,
  wallFriction:    0.2,

  floorFriction: 0,

  cameraZoom:     1,
  allowWheelZoom: false,
};

var WALL_PHYSICS_DATA = [
  { id: 1,   name: 'Wall', type: 'square', size: 40 },
  { id: 1.1, name: '45TR', type: 'vector', vectors: [{ x: -0.5, y:  0.5 }, { x: -0.5, y: -0.5 }, { x:  0.5, y:  0.5 }] },
  { id: 1.2, name: '45BL', type: 'vector', vectors: [{ x: -0.5, y: -0.5 }, { x:  0.5, y: -0.5 }, { x: -0.5, y:  0.5 }] },
  { id: 1.3, name: '45TL', type: 'vector', vectors: [{ x:  0.5, y: -0.5 }, { x:  0.5, y:  0.5 }, { x: -0.5, y: -0.5 }] },
  { id: 1.4, name: '45BR', type: 'vector', vectors: [{ x:  0.5, y:  0.5 }, { x: -0.5, y:  0.5 }, { x:  0.5, y: -0.5 }] },
];

var b2Vec2         = Box2D.Common.Math.b2Vec2;
var b2World        = Box2D.Dynamics.b2World;
var b2BodyDef      = Box2D.Dynamics.b2BodyDef;
var b2Body         = Box2D.Dynamics.b2Body;
var b2FixtureDef   = Box2D.Dynamics.b2FixtureDef;
var b2CircleShape  = Box2D.Collision.Shapes.b2CircleShape;
var b2PolygonShape = Box2D.Collision.Shapes.b2PolygonShape;

class PhysicsWorld {
  constructor() {
    this.world = new b2World(new b2Vec2(physConfig.gravityX, physConfig.gravityY), true);

    this.wallLookup = {};
    for (var i = 0; i < WALL_PHYSICS_DATA.length; i++) {
      this.wallLookup[WALL_PHYSICS_DATA[i].id] = WALL_PHYSICS_DATA[i];
    }

    this.wallBodies = [];
  }

  setGravity(x, y) {
    this.world.SetGravity(new b2Vec2(x, y));
  }

  step(timeStep) {
    this.world.Step(timeStep, 8, 3);
    this.world.ClearForces();
  }

  // The cell's effective wall surface: settingsState's per-tile override
  // when the leader set one, else the room-wide physConfig value - mirrors
  // the server's matchManager.syncWallSurface fallback so prediction
  // bounces like the real wall does.
  wallSurfaceAt(x, y) {
    var friction    = settingsState.getTileOverride(x, y, 'wallFriction');
    var restitution = settingsState.getTileOverride(x, y, 'wallRestitution');
    return {
      friction:    friction    !== undefined ? friction    : physConfig.wallFriction,
      restitution: restitution !== undefined ? restitution : physConfig.wallRestitution,
    };
  }

  makeWallBody(id, x, y) {
    var tileData = this.wallLookup[id];
    if (!tileData) return null;

    var bodyDef = new b2BodyDef();
    bodyDef.type = b2Body.b2_staticBody;
    bodyDef.position.Set(x + 0.5, y + 0.5);
    var body = this.world.CreateBody(bodyDef);

    var fixDef = new b2FixtureDef();

    if (tileData.type === 'vector') {
      var shape = new b2PolygonShape();
      shape.SetAsArray(tileData.vectors.map(function (v) { return new b2Vec2(v.x, v.y); }));
      fixDef.shape = shape;
    } else {
      var boxShape = new b2PolygonShape();
      boxShape.SetAsBox(tileData.size / 2 / 40, tileData.size / 2 / 40);
      fixDef.shape = boxShape;
    }

    var surface = this.wallSurfaceAt(x, y);
    fixDef.restitution = surface.restitution;
    fixDef.friction    = surface.friction;

    body.CreateFixture(fixDef);
    return body;
  }

  // Live-updates every existing wall/spike fixture (per-cell override
  // aware) so prediction keeps bouncing the way the server does. Called on
  // room-wide wall setting changes and per-tile setting changes.
  applyWallSettings() {
    for (var i = 0; i < this.wallBodies.length; i++) {
      var wall    = this.wallBodies[i];
      var surface = this.wallSurfaceAt(wall.x, wall.y);
      for (var f = wall.body.GetFixtureList(); f; f = f.GetNext()) {
        f.SetRestitution(surface.restitution);
        f.SetFriction(surface.friction);
      }
    }
  }

  setDamping(body, linear, angular) {
    body.SetLinearDamping(linear);
    body.SetAngularDamping(angular);
  }

  setFriction(body, value) {
    for (var f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetFriction(value);
    }
  }

  buildWalls(wallMap) {
    this.clearWalls();
    for (var y = 0; y < wallMap.length; y++) {
      for (var x = 0; x < wallMap[y].length; x++) {
        var id = wallMap[y][x];
        if (!id) continue;
        var body = this.makeWallBody(id, x, y);
        if (body) this.wallBodies.push({ body: body, x: x, y: y });
      }
    }
  }

  clearWalls() {
    for (var i = 0; i < this.wallBodies.length; i++) {
      this.world.DestroyBody(this.wallBodies[i].body);
    }
    this.wallBodies = [];
  }

  // Spike (id 7) is solid server-side but isn't a wall tile, so it never
  // appears in wallMap - without a matching local body, prediction lets the
  // ball glide through unopposed while the server stops/bounces it. Built
  // from the full tile map and kept in wallBodies so it rides along with
  // clearWalls/applyWallSettings like every other solid tile.
  buildSpikes(map) {
    this._buildSpikesInto(map);
  }

  _buildSpikesInto(map) {
    for (var y = 0; y < map.length; y++) {
      for (var x = 0; x < map[y].length; x++) {
        if (map[y][x] !== 7) continue;

        var bodyDef = new b2BodyDef();
        bodyDef.type = b2Body.b2_staticBody;
        bodyDef.position.Set(x + 0.5, y + 0.5);
        var body = this.world.CreateBody(bodyDef);

        var surface = this.wallSurfaceAt(x, y);
        var fixDef  = new b2FixtureDef();
        fixDef.shape       = new b2CircleShape(28 / 2 / 40);
        fixDef.restitution = surface.restitution;
        fixDef.friction    = surface.friction;
        body.CreateFixture(fixDef);

        this.wallBodies.push({ body: body, x: x, y: y });
      }
    }
  }

  createBall(x, y) {
    var bodyDef = new b2BodyDef();
    bodyDef.type = b2Body.b2_dynamicBody;
    bodyDef.position.Set(x, y);
    bodyDef.linearDamping  = physConfig.linearDamping;
    bodyDef.angularDamping = physConfig.angularDamping;
    bodyDef.allowSleep     = false;
    var body = this.world.CreateBody(bodyDef);

    var fixDef = new b2FixtureDef();
    fixDef.shape       = new b2CircleShape(physConfig.radius);
    fixDef.density     = physConfig.density;
    fixDef.friction    = physConfig.playerFriction;
    fixDef.restitution = physConfig.restitution;
    body.CreateFixture(fixDef);

    return body;
  }

  destroyBody(body) {
    if (body) this.world.DestroyBody(body);
  }

  getPosition(body) {
    var pos = body.GetPosition();
    return { x: pos.x, y: pos.y };
  }

  getVelocity(body) {
    var vel = body.GetLinearVelocity();
    return { x: vel.x, y: vel.y };
  }

  setVelocity(body, x, y) {
    body.SetLinearVelocity(new b2Vec2(x, y));
  }

  setPosition(body, x, y) {
    body.SetPosition(new b2Vec2(x, y));
  }

  getAngle(body) {
    return body.GetAngle();
  }

  // Mirrors the server's physicsWorld.setSensor - a dead player's ball must
  // stop colliding locally too, or remote clients look pushable while dead.
  setSensor(body, bool) {
    for (var f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetSensor(bool);
    }
  }
}

var physicsWorld = new PhysicsWorld();
