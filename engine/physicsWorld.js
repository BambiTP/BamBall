(function () {
var Box2D = (typeof require === 'function') ? require('../shared/Box2dWeb-2.1.a.3') : globalThis.Box2D;
const { tileToWorld, TILE_SIZE } = (typeof require === 'function') ? require('./coords') : globalThis.Coords;
const { Box2DBody, buildShapeFromTileData } = (typeof require === 'function') ? require('../shared/box2dBody') : globalThis;

const {
  b2Vec2,
  b2World,
  b2BodyDef,
  b2Body,
  b2FixtureDef,
  b2CircleShape,
  b2ContactListener,
} = {
  b2Vec2:            Box2D.Common.Math.b2Vec2,
  b2World:           Box2D.Dynamics.b2World,
  b2BodyDef:         Box2D.Dynamics.b2BodyDef,
  b2Body:            Box2D.Dynamics.b2Body,
  b2FixtureDef:      Box2D.Dynamics.b2FixtureDef,
  b2CircleShape:     Box2D.Collision.Shapes.b2CircleShape,
  b2ContactListener: Box2D.Dynamics.b2ContactListener,
};

class PhysicsWorld {
  constructor(config, emitter) {
    this.config  = config;
    this.emitter = emitter;
    this.world   = new b2World(new b2Vec2(config.gravityX, config.gravityY), true);

    // Box2D collision-filter category, given to every player body
    // (playerLifecycle.js's spawnPlayer) - engine/eggball.js's egg
    // uses it to mask its solid fixture away from players specifically
    // (still bounces off walls/spikes for real, just never physically
    // bumps whoever's about to catch it - catching that fixture would
    // otherwise be indistinguishable from two balls colliding). Every
    // other body (walls, tiles) stays on Box2D's own default category
    // (0x0001), so this doesn't touch anything else's collisions.
    this.CATEGORY_PLAYER = 0x0002;

    const listener = new b2ContactListener();

    listener.BeginContact = (contact) => {
      const dataA = contact.GetFixtureA().GetBody().GetUserData();
      const dataB = contact.GetFixtureB().GetBody().GetUserData();
      if (!dataA || !dataB) return;

      // The egg's body carries two fixtures (engine/eggball.js's
      // makeEggballBody) - a solid one for wall/spike bounces and a
      // sensor, masked to players only, for catching - so either kind of
      // contact lands here the same way. Which one it was is passed
      // along; engine/gameInstance.js's listener (deferred - see its own
      // comment) sorts that into a catch or a bounce-timestamp.
      if (dataA.isEggball || dataB.isEggball) {
        const egg   = dataA.isEggball ? dataA : dataB;
        const other = dataA.isEggball ? dataB : dataA;
        this.emitter.emit('eggballContact', egg, other);
        return;
      }

      if (dataA.isPlayer && !dataB.isPlayer) {
        this.emitter.emit('playerBegin', dataA, dataB);
      } else if (dataB.isPlayer && !dataA.isPlayer) {
        this.emitter.emit('playerBegin', dataB, dataA);
      } else if (dataA.isPlayer && dataB.isPlayer) {
        this.emitter.emit('playerPlayerBegin', dataA, dataB);
      }
    };

    listener.EndContact = (contact) => {
      const dataA = contact.GetFixtureA().GetBody().GetUserData();
      const dataB = contact.GetFixtureB().GetBody().GetUserData();
      if (!dataA || !dataB) return;

      if (dataA.isPlayer && !dataB.isPlayer) {
        this.emitter.emit('playerEnd', dataA, dataB);
      } else if (dataB.isPlayer && !dataA.isPlayer) {
        this.emitter.emit('playerEnd', dataB, dataA);
      }
    };

    listener.PreSolve = (contact) => {
      const dataA = contact.GetFixtureA().GetBody().GetUserData();
      const dataB = contact.GetFixtureB().GetBody().GetUserData();
      if (dataA?.isPlayer) this.emitter.emit('playerCollision', dataA, dataB, contact);
      if (dataB?.isPlayer) this.emitter.emit('playerCollision', dataB, dataA, contact);
    };

    this.world.SetContactListener(listener);
  }

  setGravity(x, y) {
    this.world.SetGravity(new b2Vec2(x, y));
  }

  createDynamicBody(x, y, options = {}) {
    const bodyDef          = new b2BodyDef();
    bodyDef.type           = b2Body.b2_dynamicBody;
    bodyDef.position.Set(x, y);
    bodyDef.linearDamping  = options.linearDamping  ?? this.config.linearDamping;
    bodyDef.angularDamping = options.angularDamping ?? this.config.angularDamping;
    bodyDef.allowSleep     = false;
    // Without CCD, a fast ball can tunnel partway into a small solid fixture
    // (e.g. a spike) within a single 60Hz step before Box2D sees the overlap,
    // then the position-correction solver ejects it hard to resolve the deep
    // penetration - a sharp "launch" instead of a gentle restitution bounce.
    // Bullet mode makes Box2D sweep the motion so contact is caught early.
    bodyDef.bullet         = true;
    const body = this.world.CreateBody(bodyDef);

    const fixDef       = new b2FixtureDef();
    fixDef.shape       = new b2CircleShape(options.radius      ?? this.config.radius);
    fixDef.density     = options.density     ?? this.config.density;
    fixDef.friction    = options.friction    ?? this.config.friction;
    fixDef.restitution = options.restitution ?? this.config.restitution;
    // Defaults (categoryBits 0x0001, maskBits 0xFFFF - collide with
    // everything) match every existing caller's prior behavior exactly;
    // only engine/eggball.js's egg passes its own maskBits.
    if (options.categoryBits !== undefined) fixDef.filter.categoryBits = options.categoryBits;
    if (options.maskBits     !== undefined) fixDef.filter.maskBits     = options.maskBits;
    body.CreateFixture(fixDef);

    return body;
  }

  // A second, sensor-only fixture on an existing body - no collision
  // response (no bump, no bounce), just BeginContact/EndContact overlap
  // events. engine/eggball.js's egg uses this for player-catch
  // detection alongside its own solid wall-bounce fixture from
  // createDynamicBody above; maskBits narrows which categories it even
  // bothers overlap-testing against (defaults to everything).
  addSensorFixture(body, radius, maskBits) {
    const fixDef    = new b2FixtureDef();
    fixDef.shape    = new b2CircleShape(radius);
    fixDef.isSensor = true;
    if (maskBits !== undefined) fixDef.filter.maskBits = maskBits;
    body.CreateFixture(fixDef);
  }


makeBody(id, x, y, physicsLookup) {
  const tileData = physicsLookup[id];
  if (!tileData || tileData.type === 'none') return null;

  const bodyDef = new b2BodyDef();
  bodyDef.type  = b2Body.b2_staticBody;
  const pos     = tileToWorld(x, y);
  bodyDef.position.Set(pos.x, pos.y);
  const body = this.world.CreateBody(bodyDef);

  const fixDef    = new b2FixtureDef();
  fixDef.isSensor = tileData.sensor ?? false;

  // Solid fixtures (walls, spikes) get the room's wall surface values at
  // creation instead of Box2D's own defaults - before this, a wall body
  // built after a leader changed wallFriction/wallRestitution (map edit
  // paint, map change) silently kept the stock 0.2/0 until the next
  // wallSurface hook run. Per-tile overrides are layered on top by
  // gameInstance.setTile / matchManager.syncWallSurface.
  if (!fixDef.isSensor) {
    fixDef.friction    = this.config.wallFriction;
    fixDef.restitution = this.config.wallRestitution;
  }

  fixDef.shape = buildShapeFromTileData(tileData, TILE_SIZE);

  body.CreateFixture(fixDef);

  return body;
}

  applyImpulse(body, x, y) {
    body.ApplyImpulse(new b2Vec2(x, y), body.GetWorldCenter());
  }

  setBodyType(body, type) {
    const types = {
      dynamic: b2Body.b2_dynamicBody,
      static:  b2Body.b2_staticBody,
      kinematic: b2Body.b2_kinematicBody,
    };
    body.SetType(types[type]);
  }
}

Object.assign(PhysicsWorld.prototype, Box2DBody);

if (typeof module !== 'undefined' && module.exports) module.exports = PhysicsWorld;
if (typeof globalThis !== 'undefined') globalThis.PhysicsWorld = PhysicsWorld;
})();
