// particles.js - small config-driven particle system. Configs are shaped
// like pixi-particles/@pixi/particle-emitter emitter configs (alpha/scale/
// color ramps over lifetime, a speed ramp, spawnCircle, frequency,
// maxParticles) so effects read as tunable data rather than draw code, but
// this is a from-scratch ~100-line engine, not that library - PixiJS v8 has
// no official build of it, and this repo has no bundler to pull in the
// unofficial ESM-only v8 forks.
//
// Load order: after the PIXI CDN script, before renderer.js (renderer.js's
// spawnBurst/setPupAura wrap particleSystem.createEmitter).

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(lerp(ar, br, t));
  const g = Math.round(lerp(ag, bg, t));
  const b2 = Math.round(lerp(ab, bb, t));
  return (r << 16) | (g << 8) | b2;
}

function hexToInt(value) {
  return typeof value === 'number' ? value : new PIXI.Color(value).toNumber();
}

class ParticleEmitter {
  constructor(container, config) {
    this.container = container;
    this.config    = config;
    this.particles = [];
    this.spawnTimer = 0;
    this.age = 0;
    this.stopped = false;

    this.startColor = hexToInt(config.color?.start ?? 0xffffff);
    this.endColor   = hexToInt(config.color?.end   ?? this.startColor);
  }

  // An emitter is done - and safe to drop from particleSystem - once it's
  // been told to stop (or outlived emitterLifetime) and every particle it
  // already spawned has finished fading out.
  get finished() {
    const lifetimeOver = this.config.emitterLifetime >= 0 && this.age >= this.config.emitterLifetime;
    return (this.stopped || lifetimeOver) && this.particles.length === 0;
  }

  // Stops spawning new particles; whatever's already out keeps animating
  // to a natural end instead of popping off instantly.
  stop() {
    this.stopped = true;
  }

  // Hard removal - used when the owning player is despawning entirely, so
  // there's nothing left to animate out gracefully.
  destroy() {
    for (const p of this.particles) p.gfx.destroy();
    this.particles.length = 0;
    this.stopped = true;
  }

  spawnParticle() {
    const cfg = this.config;
    const pos = cfg.pos || { x: 0, y: 0 };

    let x = pos.x;
    let y = pos.y;
    if (cfg.spawnType === 'circle' && cfg.spawnCircle) {
      const angle = Math.random() * Math.PI * 2;
      const r     = cfg.spawnCircle.r * Math.sqrt(Math.random());
      x = pos.x + cfg.spawnCircle.x + Math.cos(angle) * r;
      y = pos.y + cfg.spawnCircle.y + Math.sin(angle) * r;
    }

    const rotMin      = cfg.startRotation?.min ?? 0;
    const rotMax      = cfg.startRotation?.max ?? 0;
    const rotSpeedMin = cfg.rotationSpeed?.min ?? 0;
    const rotSpeedMax = cfg.rotationSpeed?.max ?? 0;

    const lifeMin = cfg.lifetime?.min ?? 1;
    const lifeMax = cfg.lifetime?.max ?? lifeMin;

    const gfx = new PIXI.Graphics();
    gfx.x = x;
    gfx.y = y;
    this.container.addChild(gfx);

    this.particles.push({
      gfx,
      age:      0,
      lifetime: lifeMin + Math.random() * (lifeMax - lifeMin),
      dirAngle: Math.random() * Math.PI * 2,
      rotation:      (rotMin + Math.random() * (rotMax - rotMin)) * Math.PI / 180,
      rotationSpeed: (rotSpeedMin + Math.random() * (rotSpeedMax - rotSpeedMin)) * Math.PI / 180,
    });
  }

  // dt in seconds.
  update(dt) {
    const cfg = this.config;

    if (!this.stopped) {
      this.age += dt;
      const withinLifetime = cfg.emitterLifetime < 0 || this.age <= cfg.emitterLifetime;
      const maxParticles   = cfg.maxParticles ?? Infinity;

      if (withinLifetime) {
        this.spawnTimer -= dt;
        while (this.spawnTimer <= 0 && this.particles.length < maxParticles) {
          this.spawnParticle();
          this.spawnTimer += cfg.frequency ?? 0.1;
        }
      }
    }

    const baseRadius   = cfg.particleSize ?? 4;
    const accelX       = cfg.acceleration?.x ?? 0;
    const accelY       = cfg.acceleration?.y ?? 0;
    const scaleFloor   = cfg.scale?.minimumScaleMultiplier ?? 1;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;

      if (p.age >= p.lifetime) {
        p.gfx.destroy();
        this.particles.splice(i, 1);
        continue;
      }

      const t = p.age / p.lifetime;

      const speed = lerp(cfg.speed?.start ?? 0, cfg.speed?.end ?? cfg.speed?.start ?? 0, t);
      const vx = Math.cos(p.dirAngle) * speed + accelX * p.age;
      const vy = Math.sin(p.dirAngle) * speed + accelY * p.age;

      p.gfx.x += vx * dt;
      p.gfx.y += vy * dt;

      p.rotation += p.rotationSpeed * dt;
      p.gfx.rotation = p.rotation;

      const alpha = lerp(cfg.alpha?.start ?? 1, cfg.alpha?.end ?? cfg.alpha?.start ?? 1, t);
      const scale = lerp(cfg.scale?.start ?? 1, cfg.scale?.end ?? cfg.scale?.start ?? 1, t) * scaleFloor;
      const color = lerpColor(this.startColor, this.endColor, t);

      p.gfx.clear();
      p.gfx.beginFill(color);
      p.gfx.drawCircle(0, 0, baseRadius * scale);
      p.gfx.endFill();
      p.gfx.alpha = alpha;
    }
  }
}

const particleSystem = {
  emitters: [],

  createEmitter(container, config) {
    const emitter = new ParticleEmitter(container, config);
    // Particles disabled in user settings: hand back an already-stopped
    // emitter (spawns nothing, finishes immediately) so callers can keep
    // holding/stop()ing/destroy()ing it without knowing about the toggle.
    if (!localSettings.particles) {
      emitter.stopped = true;
      return emitter;
    }
    this.emitters.push(emitter);
    return emitter;
  },

  update(dt) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const emitter = this.emitters[i];
      emitter.update(dt);
      if (emitter.finished) this.emitters.splice(i, 1);
    }
  },
};

// One config per effect, in the same shape as a pixi-particles emitter
// config - copy a real one in here (start/end ramps, spawnCircle, frequency,
// maxParticles) and it'll just work.
const particleConfigs = {
  // Death is a one-shot burst rather than a standing effect - very short
  // emitterLifetime + near-zero frequency means "spawn everything at once".
  death(color) {
    return {
      alpha: { start: 1, end: 0 },
      scale: { start: 1, end: 0.3 },
      color: { start: color, end: color },
      speed: { start: 90, end: 20 },
      acceleration: { x: 0, y: 0 },
      lifetime: { min: 0.35, max: 0.55 },
      frequency: 0.001,
      emitterLifetime: 0.02,
      maxParticles: 18,
      pos: { x: 0, y: 0 },
      spawnType: 'circle',
      spawnCircle: { x: 0, y: 0, r: 2 },
    };
  },

  // Rolling bomb - a smoke puff that grows and darkens as it drifts, same
  // shape/values as TagPro's own rollingBomb emitter config.
  rollingBomb: {
    alpha: { start: 0.45, end: 0 },
    scale: { start: 0.1, end: 1.5, minimumScaleMultiplier: 1 },
    color: { start: '#85888d', end: '#100f0c' },
    speed: { start: 1, end: 50 },
    acceleration: { x: 0, y: 0 },
    startRotation: { min: 0, max: 360 },
    rotationSpeed: { min: 0, max: 0 },
    lifetime: { min: 0.5, max: 2 },
    frequency: 0.001,
    emitterLifetime: -1,
    maxParticles: 10,
    pos: { x: 0, y: 0 },
    spawnType: 'circle',
    spawnCircle: { x: 0, y: 0, r: 16 },
  },

  // Juke juice - quick cyan sparks flicking outward, reads as speed. Kept
  // off tagpro's green so the two don't read as the same effect at a glance.
  jukeJuice: {
    alpha: { start: 0.9, end: 0 },
    scale: { start: 0.6, end: 1.1 },
    color: { start: '#7ad9ff', end: '#0077aa' },
    speed: { start: 45, end: 5 },
    lifetime: { min: 0.2, max: 0.35 },
    frequency: 0.025,
    emitterLifetime: -1,
    maxParticles: 12,
    pos: { x: 0, y: 0 },
    spawnType: 'circle',
    spawnCircle: { x: 0, y: 0, r: 12 },
  },

  // Tagpro - bright green sparks flicking off a single point (the ball's
  // center), shrinking as they fade rather than growing.
  tagpro: {
    alpha: { start: 0.75, end: 0 },
    scale: { start: 0, end: 0.25, minimumScaleMultiplier: 1 },
    color: { start: '#83ff7a', end: '#00bb00' },
    speed: { start: 30, end: 30 },
    lifetime: { min: 0.1, max: 0.9 },
    frequency: 0.01,
    emitterLifetime: -1,
    maxParticles: 50,
    pos: { x: 0, y: 0 },
    spawnType: 'point',
  },
};
