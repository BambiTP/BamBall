(function () {
var Box2D = (typeof require === 'function') ? require('../shared/Box2dWeb-2.1.a.3') : globalThis.Box2D;
const { tileToWorld, TILE_SIZE } = (typeof require === 'function') ? require('./coords') : globalThis.Coords;

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

    const listener = new b2ContactListener();

    listener.BeginContact = (contact) => {
      const dataA = contact.GetFixtureA().GetBody().GetUserData();
      const dataB = contact.GetFixtureB().GetBody().GetUserData();
      if (!dataA || !dataB) return;

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

  step(timeStep) {
    this.world.Step(timeStep, 8, 3);
    this.world.ClearForces();
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
    body.CreateFixture(fixDef);

    return body;
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

  if (tileData.type === 'vector') {
    const shape = new Box2D.Collision.Shapes.b2PolygonShape();
    shape.SetAsArray(tileData.vectors.map(v => new b2Vec2(v.x, v.y)));
    fixDef.shape = shape;
  } else if (tileData.type === 'square') {
    const shape = new Box2D.Collision.Shapes.b2PolygonShape();
    shape.SetAsBox(tileData.size / 2 / TILE_SIZE, tileData.size / 2 / TILE_SIZE);
    fixDef.shape = shape;
  } else if (tileData.type === 'circle') {
    fixDef.shape = new b2CircleShape(tileData.size / 2 / TILE_SIZE);
  }

  body.CreateFixture(fixDef);

  return body;
}

  destroyBody(body) {
    if (body) this.world.DestroyBody(body);
  }

  getPosition(body) {
    const pos = body.GetPosition();
    return { x: pos.x, y: pos.y };
  }

  getVelocity(body) {
    const vel = body.GetLinearVelocity();
    return { x: vel.x, y: vel.y };
  }

  setVelocity(body, x, y) {
    body.SetLinearVelocity(new b2Vec2(x, y));
  }

  setPosition(body, x, y) {
    body.SetPosition(new b2Vec2(x, y));
  }

  applyImpulse(body, x, y) {
    body.ApplyImpulse(new b2Vec2(x, y), body.GetWorldCenter());
  }

  applyForce(body, x, y) {
    body.ApplyForce(new b2Vec2(x, y), body.GetWorldCenter());
  }

  getMass(body) {
    return body.GetMass();
  }

  getAngle(body) {
    return body.GetAngle();
  }

  setBodyType(body, type) {
    const types = {
      dynamic: b2Body.b2_dynamicBody,
      static:  b2Body.b2_staticBody,
      kinematic: b2Body.b2_kinematicBody,
    };
    body.SetType(types[type]);
  }

  setSensor(body, bool) {
    for (let f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetSensor(bool);
    }
  }

  setDamping(body, linear, angular) {
    body.SetLinearDamping(linear);
    body.SetAngularDamping(angular);
  }

  setFriction(body, value) {
    for (let f = body.GetFixtureList(); f; f = f.GetNext()) {
      f.SetFriction(value);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = PhysicsWorld;
if (typeof globalThis !== 'undefined') globalThis.PhysicsWorld = PhysicsWorld;
})();
