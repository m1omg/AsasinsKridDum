import * as THREE from 'three';
import { Enemy } from '../entities/enemy.js';
import { EnemyView } from '../entities/enemyView.js';
import { Projectiles } from '../entities/projectiles.js';
import { RiftVisual, FireBarrier } from './rifts.js';
import { makeRng, rand, clamp } from '../core/math.js';

// Spawns and coordinates the demon population: patrols, rift guards, rooftop
// watchers, hound packs, flying gazers; attack tokens so only a couple of
// demons strike at once; a shared flow field for chasing; Doom-style arena
// waves when a Rift Heart is struck; the final boss.

const WAVES = [
  [{ thrall: 4, imp: 2 }, { hound: 2, imp: 2, gazer: 1 }, { brute: 1, thrall: 2, imp: 1 }],
  [{ thrall: 3, imp: 3, hound: 1 }, { hound: 3, gazer: 1, imp: 1 }, { brute: 1, imp: 2, gazer: 1 }],
  [{ thrall: 4, imp: 2, hound: 2 }, { hound: 2, gazer: 2, imp: 2 }, { brute: 2, imp: 2 }],
];

export class Director {
  constructor(game) {
    this.game = game;
    this.enemies = [];
    this.views = new Map();
    this.projectiles = new Projectiles(game);
    this.tokens = { melee: new Set(), ranged: new Set() };
    this.maxMelee = 2;
    this.maxRanged = 2;
    this.flowValid = false;
    this.flowT = 0;
    this.near = [];
    this.arena = null;
    this.riftVisuals = [];
    this.kills = 0;
    this.boss = null;
    this.rng = makeRng(666);
    this._frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
  }

  // ----------------------------------------------------------- spawning
  spawn(type, x, z, opts = {}) {
    const e = new Enemy(this.game, type, x, z, opts);
    this.enemies.push(e);
    const v = new EnemyView(e, this.game);
    this.views.set(e, v);
    e.handPos = () => v.handPos();
    return e;
  }

  clearAll() {
    for (const e of this.enemies) this.views.get(e)?.dispose();
    this.enemies = [];
    this.views.clear();
    this.tokens.melee.clear();
    this.tokens.ranged.clear();
    this.projectiles.clear();
    if (this.arena) { this.arena.barrier.drop(); this.arena.barrier.dispose(); this.arena = null; }
    this.boss = null;
  }

  buildRifts(progress) {
    for (const v of this.riftVisuals) this.game.scene.remove(v.group);
    this.riftVisuals = [];
    for (const r of this.game.city.rifts) {
      r.closed = !!progress.rifts[r.id];
      r.active = false;
      const v = new RiftVisual(this.game, r);
      if (r.closed) v.setClosedInstant();
      this.riftVisuals.push(v);
    }
  }

  /** Initial population of the city (skips cleansed rifts). */
  populate(progress) {
    const city = this.game.city;
    const rng = this.rng;
    const sp = city.spawn;
    const farFromSpawn = (x, z, d = 38) => Math.hypot(x - sp.x, z - sp.z) > d;
    const nav = city.nav;
    const near = (x, z, r) => {
      for (let k = 0; k < 20; k++) {
        const a = rng() * Math.PI * 2, rr = rng() * r;
        const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr;
        if (nav.walkable(px, pz)) return [px, pz];
      }
      return [x, z];
    };
    // rift guards
    for (const r of city.rifts) {
      if (r.closed) continue;
      for (let i = 0; i < 3; i++) this.spawn('thrall', ...near(r.x, r.z, 11), { guardRadius: 10 });
      for (let i = 0; i < 2; i++) this.spawn('imp', ...near(r.x, r.z, 11), { guardRadius: 9 });
      this.spawn('brute', ...near(r.x, r.z + 5, 3), { guardRadius: 4 });
      this.spawn('gazer', r.x, r.z, { guardRadius: 0 });
    }
    // street patrols (groups walking block loops)
    const loops = city.patrolLoops.filter((l) => l.every((p) => farFromSpawn(p.x, p.z, 30))).sort(() => rng() - 0.5).slice(0, 13);
    for (const loop of loops) {
      const start = Math.floor(rng() * loop.length);
      const route = [...loop.slice(start), ...loop.slice(0, start)];
      const n = rng() < 0.4 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const type = i === 0 && rng() < 0.35 ? 'imp' : 'thrall';
        const p0 = route[0];
        const [x, z] = near(p0.x, p0.z, 2.5);
        this.spawn(type, x, z, { patrol: route });
      }
    }
    // hound packs
    const pts = city.streetPoints.filter((p) => farFromSpawn(p.x, p.z, 60)).sort(() => rng() - 0.5);
    for (let k = 0; k < 3 && k < pts.length; k++) {
      const p = pts[k];
      for (let i = 0; i < 2; i++) this.spawn('hound', ...near(p.x, p.z, 3), { guardRadius: 8 });
    }
    // lone thralls loitering
    for (let k = 3; k < 10 && k < pts.length; k++) this.spawn('thrall', pts[k].x, pts[k].z, { guardRadius: 3 });
    // rooftop watcher imps
    const roofs = city.rooftopPoints.filter((p) => p.y < 16 && p.b.roof === 'flat' && farFromSpawn(p.x, p.z, 40)).sort(() => rng() - 0.5).slice(0, 7);
    for (const r of roofs) this.spawn('imp', r.x, r.z, { y: r.y, guardRadius: 0, flags: { roof: true } });
    // drifting gazers
    const gz = [[-60, -70], [70, 60], [-20, 80], [80, -80]];
    for (const [x, z] of gz) if (farFromSpawn(x, z, 50)) this.spawn('gazer', x, z);
    // tutorial: two thralls in the street by the first tower
    const vp = city.viewpoints.find((v) => v.id === 'vp_south');
    if (vp && !progress.viewpoints?.vp_south) {
      this.spawn('thrall', vp.x + 6, vp.z - 9, { guardRadius: 2, yaw: Math.PI });
      this.spawn('thrall', vp.x - 9, vp.z - 7, { guardRadius: 2 });
    }
  }

  // ----------------------------------------------------------- tokens
  hasMeleeToken(e) { return this.tokens.melee.has(e); }
  freeMeleeTokens() { return this.maxMelee - this.tokens.melee.size; }
  takeToken(e, kind) {
    const set = this.tokens[kind];
    const max = kind === 'melee' ? this.maxMelee : this.maxRanged;
    if (set.has(e)) return true;
    if (set.size >= max) return false;
    set.add(e);
    e.token = kind;
    return true;
  }
  releaseToken(e) {
    this.tokens.melee.delete(e);
    this.tokens.ranged.delete(e);
    e.token = null;
  }

  // ----------------------------------------------------------- update
  update(dt) {
    const game = this.game;
    const p = game.player;
    // nearby list for separation
    this.near.length = 0;
    let anyCombat = false;
    for (const e of this.enemies) {
      if (Math.abs(e.pos.x - p.pos.x) < 45 && Math.abs(e.pos.z - p.pos.z) < 45) this.near.push(e);
      if (e.alerted && !e.dead) anyCombat = true;
    }
    // flow field toward the player when someone hunts them
    this.flowT -= dt;
    if (anyCombat && this.flowT <= 0) {
      this.flowT = 0.35;
      const g = game.collision.groundAt(p.pos.x, p.pos.z, 0.2, p.pos.y + 0.5);
      this.flowValid = game.city.nav.buildFlow(p.pos.x, p.pos.z, 75) && (p.pos.y - g.y < 0.5 || p.pos.y < 1.5);
    }
    for (const e of this.enemies) {
      e.savePrev();
      e.update(dt);
    }
    // cleanup
    if (this.enemies.some((e) => e.removed)) {
      for (const e of this.enemies) if (e.removed) { this.views.get(e)?.dispose(); this.views.delete(e); this.releaseToken(e); }
      this.enemies = this.enemies.filter((e) => !e.removed);
    }
    // stale tokens
    for (const e of [...this.tokens.melee, ...this.tokens.ranged]) if (e.dead || e.state !== 'attack') this.releaseToken(e);
    this.projectiles.update(dt);
    this.updateArena(dt);
    for (const v of this.riftVisuals) v.update(dt);
  }

  render(dt, alpha) {
    const cam = this.game.renderer.camera;
    this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._pm);
    for (const v of this.views.values()) v.update(dt, alpha, this._frustum, cam.position);
    this.projectiles.render(alpha, dt);
  }

  combatState() {
    let alerted = 0, suspicious = 0, close = 0;
    const p = this.game.player.pos;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.alerted) {
        alerted++;
        if (Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 35) close++;
      } else if (e.awareness > 0.3) suspicious++;
    }
    return { alerted, suspicious, close };
  }

  // ----------------------------------------------------------- deaths & drops
  onEnemyDeath(e, kind) {
    this.kills++;
    const game = this.game;
    const pk = game.pickups;
    const big = e.def.heavy ? 2 : 1;
    const y = e.pos.y + (e.def.flies ? 0 : 0.8);
    if (kind === 'glory') pk.spawn('health', e.pos.x, y, e.pos.z, 3 * big + 1);
    else if (kind === 'burn') { pk.spawn('armor', e.pos.x, y, e.pos.z, 3 * big); if (Math.random() < 0.5) pk.spawn('health', e.pos.x, y, e.pos.z, 1); }
    else if (kind === 'assassinate') { pk.spawn('bolt', e.pos.x, y, e.pos.z, 1); pk.spawn('health', e.pos.x, y, e.pos.z, 1); }
    else if (Math.random() < 0.45) pk.spawn('health', e.pos.x, y, e.pos.z, 1);
    if (kind !== 'assassinate' && Math.random() < 0.3) pk.spawn('bolt', e.pos.x, y, e.pos.z, 1);
    game.events.emit('enemyKilled', e, kind);
    if (e.arena && this.arena) this.arena.alive.delete(e);
    if (e.def.boss) this.onBossDeath(e);
  }

  // ----------------------------------------------------------- arenas
  startArena(rift) {
    if (this.arena || rift.closed) return;
    const game = this.game;
    const idx = Object.values(game.progress.rifts).filter(Boolean).length;
    const waves = WAVES[Math.min(idx, WAVES.length - 1)];
    const r = Math.min(rift.radius - 0.4, 14);
    rift.active = true;
    this.arena = {
      rift, waves, wave: -1, alive: new Set(), r, t: 0, nextAt: 1.5,
      barrier: new FireBarrier(game, rift.x, rift.z, r),
    };
    // existing guards in range join the fight
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.pos.x - rift.x, e.pos.z - rift.z);
      if (d < r) { e.arena = this.arena; this.arena.alive.add(e); e.alert(false, true); e.lastSeen.copy(game.player.pos); }
    }
    game.events.emit('arenaStart', rift);
    game.audio?.play('waveStart', { volume: 1 });
  }

  updateArena(dt) {
    const A = this.arena;
    if (!A) return;
    A.t += dt;
    A.barrier.update(dt);
    const game = this.game;
    if (A.done) {
      if (A.barrier.disposed) this.arena = null;
      return;
    }
    if (A.alive.size <= (A.wave < 0 ? 99 : 1) && A.nextAt === null) A.nextAt = A.t + 2.2;
    if (A.nextAt !== null && A.t >= A.nextAt && (A.alive.size === 0 || A.wave < 0 || A.alive.size <= 1)) {
      A.nextAt = null;
      A.wave++;
      if (A.wave >= A.waves.length) {
        if (A.alive.size === 0) this.finishArena();
        else A.nextAt = A.t + 0.5;
        return;
      }
      this.spawnWave(A.waves[A.wave]);
      game.events.emit('wave', A.wave + 1, A.waves.length);
    }
  }

  spawnWave(spec) {
    const A = this.arena;
    const rift = A.rift;
    const game = this.game;
    let i = 0;
    const total = Object.values(spec).reduce((a, b) => a + b, 0);
    for (const [type, n] of Object.entries(spec)) {
      for (let k = 0; k < n; k++) {
        const a = ((i++) / total) * Math.PI * 2 + rand(-0.2, 0.2);
        const rr = rand(5, A.r - 2);
        let x = rift.x + Math.cos(a) * rr, z = rift.z + Math.sin(a) * rr;
        if (!game.city.nav.walkable(x, z)) { x = rift.x + Math.cos(a) * 6; z = rift.z + Math.sin(a) * 6; }
        const e = this.spawn(type, x, z, { spawnIn: true, arena: A, yaw: Math.atan2(rift.x - x, rift.z - z) });
        e.arena = A;
        A.alive.add(e);
        game.fx.explosion(x, 0.5, z, 0.6);
        game.fx.ringBurst(x, 0.2, z, 1.5, [2.5, 0.4, 0.1], 30);
      }
    }
    game.audio?.play('riftOpen', { pos: { x: rift.x, y: 3, z: rift.z }, volume: 0.9 });
    game.camera.addShake(0.3);
  }

  finishArena() {
    const A = this.arena;
    A.done = true;
    A.barrier.drop();
    const rift = A.rift;
    rift.active = false;
    rift.closed = true;
    const vis = this.riftVisuals.find((v) => v.rift === rift);
    vis?.close();
    this.game.onRiftClosed(rift);
  }

  // ----------------------------------------------------------- boss
  startBoss() {
    if (this.boss) return;
    const game = this.game;
    const c = game.city.cathedral;
    const boss = this.spawn('boss', c.bossSpawn.x, c.bossSpawn.z + 2, { spawnIn: true, yaw: 0, alerted: false });
    boss.spawnT = 2.5;
    boss.phase = 0;
    this.boss = boss;
    this.bossBarrier = new FireBarrier(game, c.arena.x, c.arena.z, c.arena.r, 9);
    game.audio?.play('bossRoar', { volume: 1 });
    game.camera.addShake(0.8);
    game.events.emit('bossStart', boss);
    // clear out stragglers in the piazza
    for (const e of this.enemies) {
      if (e === boss || e.dead) continue;
      if (Math.hypot(e.pos.x - c.arena.x, e.pos.z - c.arena.z) < c.arena.r + 2) e.die('normal');
    }
  }

  bossSummon(boss) {
    const game = this.game;
    const c = game.city.cathedral.arena;
    const types = boss.phase >= 2 ? ['imp', 'imp', 'hound', 'thrall'] : ['thrall', 'thrall', 'imp'];
    types.forEach((t, i) => {
      const a = (i / types.length) * Math.PI * 2 + rand(0, 1);
      const x = c.x + Math.cos(a) * rand(8, c.r - 3), z = c.z + Math.sin(a) * rand(8, c.r - 3);
      const e = this.spawn(t, x, z, { spawnIn: true, alerted: true, arena: { boss: true } });
      game.fx.explosion(x, 0.5, z, 0.5);
      void e;
    });
  }

  updateBossPhase(boss) {
    const f = boss.hp / boss.maxHp;
    const ph = f < 0.33 ? 2 : f < 0.66 ? 1 : 0;
    if (ph !== boss.phase) {
      boss.phase = ph;
      this.game.events.emit('bossPhase', ph);
      this.game.audio?.play('bossRoar', { volume: 1 });
      this.game.camera.addShake(0.6);
      boss.def = { ...boss.def, turn: boss.def.turn * 1.25 };
      boss.speedMul = 1 + ph * 0.2;
    }
  }

  onBossDeath(boss) {
    this.bossBarrier?.drop();
    this.game.onBossDefeated(boss);
  }
}
