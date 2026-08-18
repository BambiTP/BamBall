// physicsWorld.js - the local Box2D world: walls + balls,
// mirroring the server's game/physicsWorld.js. Requires Box2dWeb-2.1.a.3.js
// (global Box2D) loaded first. Units: 1 = one tile, same as the server.
//
// Reads settingsState for wall-surface overrides instead of reaching into a
// global `game` object directly (the old clientPhysics.js read `game.
// tileOverrides` inline) - this is the only state/ dependency this module
// has, and it never writes back into state/ itself.

// Seeded from engine/gameConfig.js (loaded before this file - see
// index.html's script order) instead of a hand-copied literal, so
// prediction's defaults can't silently drift from the server's the way a
// duplicated object would (exactly the class of bug movement.js's own
// header comment warns about). Live leader changes still land the same way
// they always did: stateWiring.js's physicsChanged handler does
// Object.assign(physConfig, settings) on top of this.
var physConfig = Object.assign({}, gameConfig);

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

class PhysicsWorld {
  constructor() {
    this.world = new b2World(new b2Vec2(physConfig.gravityX, physConfig.gravityY), true);

    this.wallLookup = {};
    for (var i = 0; i < WALL_PHYSICS_DATA.length; i++) {
      this.wallLookup[WALL_PHYSICS_DATA[i].id] = WALL_PHYSICS_DATA[i];
    }

    this.wallBodies = [];

    // Only exists for gravity-mode jump refill (mirrors the server's
    // category==='wall' reset in game/tiles/tileLogic.js) - this is NOT a
    // general tile-dispatch system like the server's; prediction has no
    // reason to know about pads/flags/etc, only "did a player touch a wall".
    var listener = new Box2D.Dynamics.b2ContactListener();
    listener.BeginContact = function (contact) {
      var dataA = contact.GetFixtureA().GetBody().GetUserData();
      var dataB = contact.GetFixtureB().GetBody().GetUserData();
      if (dataA && dataA.isPlayer && dataB && dataB.isWall) dataA.jumpsRemaining = physConfig.jumpCharges;
      if (dataB && dataB.isPlayer && dataA && dataA.isWall) dataB.jumpsRemaining = physConfig.jumpCharges;
    };
    this.world.SetContactListener(listener);
  }

  setGravity(x, y) {
    this.world.SetGravity(new b2Vec2(x, y));
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
    body.SetUserData({ isWall: true });

    var fixDef = new b2FixtureDef();
    fixDef.shape = buildShapeFromTileData(tileData, 40);

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
}

Object.assign(PhysicsWorld.prototype, Box2DBody);

var physicsWorld = new PhysicsWorld();
