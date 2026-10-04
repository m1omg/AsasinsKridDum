import * as THREE from 'three';
import { ENEMY_TYPES } from './enemyTypes.js';
import { clamp, lerp, damp, dampAngle, angleDiff, approach, wrapAngle, yawTo, rand } from '../core/math.js';
import { sightFilter } from '../world/collision.js';

// ---------------------------------------------------------------------------
// Demon AI. Fixed-tick logic: perception (view cone + LOS + awareness meter,
// hearing), a state machine (patrol / suspicious / search / combat / attack /
// stagger / glory / knockdown / dazed / grabbed / dead) and kinematic
// movement on the shared collision world (nav-grid flow field when chasing).
// ---------------------------------------------------------------------------

let nextId = 1;
const climbFilter = (c) => c.climbable && c.kind !== 'bounds';
const _hit = {};
const _flow = { x: 0, z: 0, d: 0 };

export class Enemy {
  constructor(game, type, x, z, opts = {}) {
    this.id = nextId++;
    this.game = game;
    this.type = type;
    this.def = ENEMY_TYPES[type];
    const d = this.def;
    this.col = game.collision;
    this.pos = new THREE.Vector3(x, 0, z);
    const g = this.col.groundAt(x, z, 0.2, opts.y !== undefined ? opts.y + 0.5 : 2);
    this.pos.y = opts.y !== undefined ? Math.max(opts.y, g.y) : g.y;
    if (d.flies) this.pos.y = Math.max(this.pos.y, d.hover + rand(-1, 1.5));
    this.prev = this.pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw ?? rand(-Math.PI, Math.PI);
    this.prevYaw = this.yaw;
    this.hp = d.hp * (opts.hpMul || 1);
    this.maxHp = this.hp;
    this.poise = d.poise;
    this.radius = d.radius;
    this.state = 'patrol';
    this.stateTime = 0;
    this.t = rand(0, 10);
    this.awareness = 0;
    this.alerted = false;
    this.lastSeen = new THREE.Vector3();
    this.lastSeenT = -99;
    this.seesPlayer = false;
    this.patrol = opts.patrol || null;
    this.patrolIdx = 0;
    this.home = new THREE.Vector3(x, this.pos.y, z);
    this.guardRadius = opts.guardRadius ?? 0;
    this.path = null;
    this.pathIdx = 0;
    this.pathT = 0;
    this.want = { x: 0, z: 0, speed: 0, face: null };
    this.cooldowns = {};
    this.attack = null;
    this.attackHit = false;
    this.token = null;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = rand(1, 3);
    this.burning = 0;
    this.slowed = 0;
    this.dazed = 0;
    this.grounded = !d.flies;
    this.groundedT = 0; // gazer pulled down by the snare
    this.gloryUsed = false;
    this.dead = false;
    this.removed = false;
    this.deathT = 0;
    this.killKind = null;
    this.hitFlash = 0;
    this.knock = new THREE.Vector3();
    this.anim = null; // { clip, t, rate } for the view
    this.flags = opts.flags || {};
    this.arena = opts.arena || null;
    this.lod = 0;
    this.climb = null;
    this.onRoof = false;
    this.unreachableT = 0;
    this.lastSound = -10;
    this.vy = 0;
    this.spawnT = opts.spawnIn ? 1.1 : 0;
    if (opts.spawnIn) this.setState('spawn');
    if (opts.alerted) {
      this.awareness = 1;
      this.alerted = true;
      if (game.player) { this.lastSeen.copy(game.player.pos); this.lastSeenT = this.t; }
      this.engage(false);
    }
    this.idleAnimT = rand(4, 12);
  }

  setState(s) {
    if (this.state === s) { this.stateTime = 0; return; }
    if (this.state === 'attack' && s !== 'attack') this.releaseToken();
    this.state = s;
    this.stateTime = 0;
  }

  savePrev() {
    this.prev.copy(this.pos);
    this.prevYaw = this.yaw;
  }

  get player() { return this.game.player; }

  playSound(name, vol = 1, minGap = 0.6) {
    if (this.t - this.lastSound < minGap) return;
    this.lastSound = this.t;
    this.game.audio?.play(name, { pos: this.pos, volume: vol, pitch: this.def.heavy ? 0.8 : 1 });
  }

  distToPlayer() {
    const p = this.player.pos;
    return Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
  }

  // ------------------------------------------------------------ main update
  update(dt) {
    this.t += dt;
    this.stateTime += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    for (const k in this.cooldowns) this.cooldowns[k] -= dt;
    if (this.dead) { this.st_dead(dt); return; }

    const dp = this.distToPlayer();
    // level of detail: far demons only patrol at a low rate
    this.lod = dp > 85 && !this.alerted ? 2 : dp > 55 && !this.alerted ? 1 : 0;
    if (this.lod === 2 && (this.id + this.game.tick) % 8 !== 0) return;
    const ldt = this.lod === 2 ? dt * 8 : dt;

    this.tickStatus(ldt);
    if (this.dead) return;
    if (this.lod === 0 && (this.id + this.game.tick) % 3 === 0) this.perceive(dt * 3);

    const fn = this['st_' + this.state];
    this.want.speed = 0;
    this.want.face = null;
    if (fn) fn.call(this, ldt, dp);
    if (this.state !== 'climb' && this.state !== 'grabbed' && this.state !== 'leapAttack') this.locomote(ldt);
  }

  tickStatus(dt) {
    if (this.burning > 0) {
      this.burning -= dt;
      this.burnTick = (this.burnTick || 0) + dt;
      if (this.burnTick > 0.5) {
        this.burnTick = 0;
        this.takeHit(4 * (this.def.heavy ? 1.5 : 1), { type: 'fire', poise: 0, silent: true, dot: true });
      }
    }
    if (this.slowed > 0) this.slowed -= dt;
    if (this.groundedT > 0) this.groundedT -= dt;
  }

  // ------------------------------------------------------------ perception
  perceive(dt) {
    const p = this.player;
    const d = this.def;
    this.seesPlayer = false;
    if (p.dead || this.state === 'spawn' || this.state === 'grabbed') return;
    const ex = this.pos.x, ey = this.pos.y + d.eyeY * (d.flies ? 0 : 1), ez = this.pos.z;
    const px = p.pos.x, py = p.pos.y + (p.sneaking ? 0.9 : 1.3), pz = p.pos.z;
    const dx = px - ex, dz = pz - ez, dy = py - ey;
    const dist = Math.hypot(dx, dz);
    const dist3 = Math.hypot(dx, dy, dz);
    const hiddenInHay = p.state === 'hidden';
    let visible = false;
    if (!hiddenInHay && dist3 < d.view * (this.alerted ? 1.4 : 1)) {
      const ang = Math.abs(angleDiff(this.yaw, Math.atan2(dx, dz)));
      const periph = dist < (p.sneaking ? 1.2 : 2.6) || (d.smell && dist < d.smell);
      const inCone = ang < d.fov / 2 || periph || this.alerted && this.state !== 'patrol';
      const elev = Math.atan2(dy, dist);
      const lookUpOk = this.alerted || d.flies || elev < 0.62 || dist < 3;
      if (inCone && lookUpOk) visible = this.col.lineClear(ex, ey, ez, px, py, pz, sightFilter);
    }
    if (visible) {
      this.seesPlayer = true;
      this.lastSeen.copy(p.pos);
      this.lastSeenT = this.t;
      if (!this.alerted) {
        let rate = dist < 4 ? 1.9 : dist < 9 ? 0.95 : lerp(0.8, 0.25, clamp((dist - 9) / Math.max(1, d.view - 9), 0, 1));
        if (p.sneaking) rate *= 0.45;
        if (p.sprinting) rate *= 1.7;
        if (p.isAttacking && p.isAttacking()) rate *= 3;
        if (p.state === 'climb') rate *= 1.3;
        if (p.pos.y - this.pos.y > 3.5 && !d.flies) rate *= 0.55;
        rate *= p.stealthMul || 1;
        rate *= this.game.difficulty?.detect ?? 1;
        this.awareness = Math.min(1, this.awareness + rate * dt);
      }
    } else if (!this.alerted) {
      this.awareness = Math.max(0, this.awareness - dt * (this.state === 'suspicious' ? 0.1 : 0.2));
    }
    // hearing (sprinting, landings, combat)
    if (!this.alerted && p.noise > 0.05 && !hiddenInHay) {
      const range = d.hearing * p.noise;
      if (dist3 < range) {
        this.awareness = Math.max(this.awareness, Math.min(0.75, 0.45 + p.noise * 0.3));
        this.lastSeen.copy(p.pos);
        this.lastSeenT = this.t;
        this.heard = true;
      }
    }
    if (!this.alerted) {
      if (this.awareness >= 1) this.alert(true);
      else if (this.awareness >= 0.35 && (this.state === 'patrol' || this.state === 'search')) {
        this.setState('suspicious');
        this.playSound('suspicious', 0.4, 2);
        this.game.events.emit('suspicious', this);
      }
    }
  }

  /** Become fully alerted (optionally screeching to rally neighbours). */
  alert(screech = true, fromAlly = false) {
    if (this.dead || this.alerted) return;
    this.alerted = true;
    this.awareness = 1;
    if (!fromAlly) {
      this.lastSeen.copy(this.player.pos);
      this.lastSeenT = this.t;
    }
    this.game.events.emit('alerted', this);
    this.engage(screech && !fromAlly);
    // rally nearby demons
    if (!fromAlly) {
      for (const e of this.game.director.enemies) {
        if (e === this || e.dead || e.alerted) continue;
        const d = Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
        if (d < 16 && (d < 8 || this.col.lineClear(this.pos.x, this.pos.y + 1.4, this.pos.z, e.pos.x, e.pos.y + 1.4, e.pos.z))) {
          e.lastSeen.copy(this.lastSeen);
          e.lastSeenT = e.t;
          e.alert(false, true);
        }
      }
    }
  }

  engage(screech) {
    if (screech && (this.def.skel === 'humanoid' || this.def.skel === 'hound') && this.state !== 'attack') {
      this.setState('screech');
      this.anim = { clip: 'screech', t: 0, rate: 1 / 0.8 };
      this.playSound(this.def.sounds.alert, 1, 0.3);
    } else if (this.state !== 'attack' && this.state !== 'spawn') this.setState('combat');
  }

  // ------------------------------------------------------------ passive states
  st_patrol(dt) {
    const d = this.def;
    this.idleAnimT -= dt;
    if (this.idleAnimT < 0) {
      this.idleAnimT = rand(8, 18);
      if (this.lod === 0 && this.distToPlayer() < 30) this.playSound(d.sounds.idle, 0.35, 4);
    }
    if (d.flies) return this.flyPatrol(dt);
    if (this.patrol && this.patrol.length) {
      const tgt = this.patrol[this.patrolIdx];
      if (this.moveTo(tgt.x, tgt.z, d.walk, dt)) {
        this.patrolIdx = (this.patrolIdx + 1) % this.patrol.length;
        this.path = null;
      }
    } else if (this.guardRadius > 0) {
      // wander around home
      if (!this.wanderTarget || this.stateTime > this.wanderUntil) {
        const a = rand(0, Math.PI * 2), r = rand(0, this.guardRadius);
        this.wanderTarget = { x: this.home.x + Math.cos(a) * r, z: this.home.z + Math.sin(a) * r };
        this.wanderUntil = this.stateTime + rand(5, 10);
        this.path = null;
        this.pauseT = rand(1, 3.5);
      }
      if (this.pauseT > 0) { this.pauseT -= dt; return; }
      if (this.moveTo(this.wanderTarget.x, this.wanderTarget.z, d.walk, dt)) this.wanderUntil = 0;
    } else {
      // stand guard, slowly look around
      this.want.face = this.yaw + Math.sin(this.t * 0.4) * 0.02;
    }
  }

  flyPatrol(dt) {
    const d = this.def;
    const a = this.t * 0.15 + this.id;
    const r = 10;
    const tx = this.home.x + Math.cos(a) * r, tz = this.home.z + Math.sin(a) * r;
    this.steer(tx, tz, d.walk);
    this.hoverAltitude(dt, d.hover);
  }

  st_suspicious(dt) {
    const d = this.def;
    const tgt = this.lastSeen;
    this.want.face = yawTo(this.pos.x, this.pos.z, tgt.x, tgt.z);
    if (this.stateTime > 1.2 && !d.flies) {
      if (this.moveTo(tgt.x, tgt.z, d.walk * 1.1, dt, 1.5)) this.want.face = this.yaw + Math.sin(this.t) * 0.05;
    } else if (d.flies) this.hoverAltitude(dt, d.hover);
    if (this.awareness <= 0.01) {
      this.setState('patrol');
      this.path = null;
      this.game.events.emit('calm', this);
    }
  }

  st_search(dt) {
    const d = this.def;
    if (d.flies) {
      this.steer(this.lastSeen.x, this.lastSeen.z, d.walk);
      this.hoverAltitude(dt, d.hover);
    } else if (this.moveTo(this.lastSeen.x, this.lastSeen.z, d.run * 0.7, dt, 1.5)) {
      this.want.face = this.yaw + Math.sin(this.t * 1.3) * 0.08;
    }
    if (this.stateTime > 9) {
      this.alerted = false;
      this.awareness = 0.25;
      this.path = null;
      this.setState('patrol');
      this.game.events.emit('lost', this);
    }
  }

  st_screech(dt) {
    this.want.face = yawTo(this.pos.x, this.pos.z, this.lastSeen.x, this.lastSeen.z);
    if (this.anim) this.anim.t = Math.min(1, this.stateTime / 0.8);
    if (this.def.flies) this.hoverAltitude(dt, this.def.hover);
    if (this.stateTime > 0.8) { this.anim = null; this.setState('combat'); }
  }

  st_spawn(dt) {
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.setState('combat');
      this.alerted = true;
      this.awareness = 1;
      this.lastSeen.copy(this.player.pos);
      this.lastSeenT = this.t;
    }
  }

  // ------------------------------------------------------------ combat
  st_combat(dt, dp) {
    const d = this.def;
    const p = this.player;
    if (p.dead) { this.want.speed = 0; return; }
    // lose track
    if (!this.seesPlayer && this.t - this.lastSeenT > (this.arena ? 999 : 7)) {
      this.setState('search');
      return;
    }
    const knows = this.seesPlayer || this.arena;
    const tx = knows ? p.pos.x : this.lastSeen.x;
    const tz = knows ? p.pos.z : this.lastSeen.z;
    const toYaw = yawTo(this.pos.x, this.pos.z, tx, tz);
    this.want.face = toYaw;
    const dy = (knows ? p.pos.y : this.lastSeen.y) - this.pos.y;

    if (d.flies) return this.flyCombat(dt, dp, dy);

    // choose an attack when possible
    if (this.seesPlayer || this.arena) {
      const atk = this.pickAttack(dp, dy);
      if (atk) { this.startAttack(atk); return; }
    }

    const reachable = Math.abs(dy) < 1.2 || (dy < 0 && this.onRoof);
    // distance to where we believe the player is (no wallhacks)
    const dT = Math.hypot(tx - this.pos.x, tz - this.pos.z);
    if (!reachable) {
      this.unreachableT += dt;
      if (d.climbs && this.tryClimbToward(knows ? p.pos : this.lastSeen)) return;
      // wait below / near the player
      const gx = tx, gz = tz;
      if (dp > 5) this.chase(gx, gz, d.run * 0.8, dt);
      if (this.unreachableT > 14 && !this.arena) { this.setState('search'); this.unreachableT = 0; }
      return;
    }
    this.unreachableT = 0;
    // ranged types keep their distance
    if (d.keepAway) {
      const [lo, hi] = d.keepAway;
      if (!knows) this.chase(tx, tz, d.run, dt);
      else if (dT < lo) this.steer(this.pos.x - (tx - this.pos.x), this.pos.z - (tz - this.pos.z), d.run * 0.8);
      else if (dT > hi) this.chase(tx, tz, d.run, dt);
      else this.strafe(tx, tz, d.walk * 1.4, dt);
      return;
    }
    const director = this.game.director;
    if (!knows && dT < 2.5) { this.setState('search'); return; }
    const meleeRange = this.meleeRange();
    if (dT > meleeRange + 2.5) this.chase(tx, tz, d.run, dt);
    else if (director.hasMeleeToken(this) || director.freeMeleeTokens() > 0) {
      if (dT > meleeRange - 0.4) this.chase(tx, tz, d.run, dt);
    } else {
      // wait our turn: circle the player at a distance
      if (dT < 3.2) this.steer(this.pos.x - (tx - this.pos.x), this.pos.z - (tz - this.pos.z), d.walk);
      else if (dT > 5) this.chase(tx, tz, d.run * 0.8, dt);
      else this.strafe(tx, tz, d.walk, dt);
    }
  }

  meleeRange() {
    if (this._meleeRange === undefined) {
      const close = this.def.attacks.filter((a) => !a.ranged && !a.charge && !a.leap && !a.summon);
      this._meleeRange = close.length ? Math.max(...close.map((a) => a.range[1])) : 2;
    }
    return this._meleeRange;
  }

  pickAttack(dp, dy) {
    const d = this.def;
    const director = this.game.director;
    let total = 0;
    const cands = [];
    for (const a of d.attacks) {
      if ((this.cooldowns[a.name] || 0) > 0) continue;
      if (dp < a.range[0] || dp > a.range[1]) continue;
      if (a.groundedOnly && this.groundedT <= 0) continue;
      if (a.phaseMin && (this.phase || 0) < a.phaseMin) continue;
      if (!a.ranged && !a.summon && Math.abs(dy) > (a.aoe ? 2.5 : 1.4)) continue;
      if (a.ranged && this.groundedT > 0) continue;
      if (a.ranged && !this.seesPlayer && !this.arena) continue;
      const w = a.weight ?? 1;
      cands.push([a, w]);
      total += w;
    }
    if (!cands.length) return null;
    let r = Math.random() * total;
    let pick = cands[0][0];
    for (const [a, w] of cands) { r -= w; if (r <= 0) { pick = a; break; } }
    if (!d.boss) {
      if (pick.ranged ? !director.takeToken(this, 'ranged') : !director.takeToken(this, 'melee')) return null;
    }
    return pick;
  }

  startAttack(a) {
    this.attack = a;
    this.attackHit = false;
    this.attackFired = 0;
    this.attackDir = this.yaw;
    this.setState('attack');
    this.anim = { clip: a.clip, t: 0, rate: 0 };
    this.telegraph = a.unblockable ? 'red' : 'yellow';
    if (a.name === 'charge' || a.name === 'slam' || a.name === 'stomp') this.playSound(this.def.sounds.alert, 0.9, 0.3);
    if (a.ranged === 'fireball') this.game.audio?.play('fireballCast', { pos: this.pos, volume: 0.6 });
    if (a.ranged === 'beam') this.game.audio?.play('beamCharge', { pos: this.pos, volume: 0.8 });
    this.game.events.emit('enemyAttack', this, a);
  }

  st_attack(dt, dp) {
    const a = this.attack;
    const p = this.player;
    const t = this.stateTime;
    const W = a.windup * (this.slowed > 0 ? 1.5 : 1), A = a.active, R = a.recover;
    // animation phase mapping
    let u;
    if (t < W) u = (t / W) * 0.5;
    else if (t < W + A) u = 0.5 + ((t - W) / A) * 0.2;
    else u = 0.7 + Math.min(1, (t - W - A) / R) * 0.3;
    if (this.anim) { this.anim.t = u; this.anim.rate = t < W ? 0.5 / W : t < W + A ? 0.2 / A : 0.3 / R; }
    this.phaseName = t < W ? 'windup' : t < W + A ? 'active' : 'recover';

    if (t < W) {
      // track the player during most of the windup
      const trackStop = a.charge || a.leap ? 0.85 : 0.7;
      if (t < W * trackStop) {
        this.want.face = yawTo(this.pos.x, this.pos.z, p.pos.x, p.pos.z);
        this.attackDir = this.want.face;
        this.lockedTarget = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      } else this.want.face = this.attackDir;
      if (a.lunge && t > W * 0.6) this.forward(a.lunge / (W * 0.4 + A) * 0.6);
    } else if (t < W + A) {
      this.want.face = a.charge ? this.attackDir : this.attackDir;
      if (a.lunge) this.forward(a.lunge / (W * 0.4 + A));
      if (a.charge) this.chargeMove(dt, a);
      else if (a.leap) this.leapMove(dt, a, t - W);
      else if (a.ranged) this.fireRanged(a, t - W);
      else if (a.summon) { if (!this.attackFired) { this.attackFired = 1; this.game.director.bossSummon(this); } }
      else if (!this.attackHit) this.meleeCheck(a);
      if (a.aoe && !this.aoeFx) {
        this.aoeFx = true;
        if (a.shockwave) this.game.director.projectiles.shockwave(this.pos.x, this.pos.y, this.pos.z, 26, 16);
        this.game.fx?.ringBurst(this.pos.x, this.pos.y + 0.2, this.pos.z, a.reach, [2.4, 0.7, 0.2], 80);
        this.game.fx?.dust(this.pos.x, this.pos.y, this.pos.z, 24, 2);
        this.game.audio?.play(this.def.boss ? 'bossStomp' : 'bruteSlam', { pos: this.pos, volume: 1 });
        this.game.camera?.addShake(clamp(1 - dp / 25, 0, 1) * 0.6);
      }
    } else {
      this.aoeFx = false;
      if (this.chargeHitWall) {
        this.chargeHitWall = false;
        this.dazed = 2.6;
        this.setState('dazed');
        this.anim = { clip: 'dazed', t: 0, loop: 1.2 };
        this.cooldowns[a.name] = a.cooldown;
        return;
      }
    }
    if (t >= W + A + R) {
      this.cooldowns[a.name] = a.cooldown * rand(0.85, 1.25);
      this.attack = null;
      this.anim = null;
      this.telegraph = null;
      this.releaseToken();
      this.setState('combat');
      // the Cardinal tires after a flurry: he kneels, open to a heart strike
      if (this.def.boss) {
        this.attackCount = (this.attackCount || 0) + 1;
        if (this.attackCount >= (this.phase >= 2 ? 5 : 4)) {
          this.attackCount = 0;
          this.daze(4.2);
          this.game.events.emit('bossKneel', this);
        }
      }
    }
    void dt;
  }

  forward(speed) {
    this.want.x = Math.sin(this.attackDir);
    this.want.z = Math.cos(this.attackDir);
    this.want.speed = speed;
    this.want.instant = true;
  }

  meleeCheck(a) {
    const p = this.player;
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz) - 0.3;
    if (dist > a.reach) return;
    const dy = p.pos.y - this.pos.y;
    if (dy > this.def.height * 0.9 || dy < -1.5) return;
    if (a.arc < 6.2) {
      const ang = Math.abs(angleDiff(this.yaw, Math.atan2(dx, dz)));
      if (ang > a.arc / 2) return;
    }
    this.attackHit = true;
    const res = p.receiveHit ? p.receiveHit(a, this) : 'hit';
    if (res === 'parried') this.onParried();
  }

  onParried() {
    this.game.events.emit('parried', this);
    this.attack = null;
    this.telegraph = null;
    this.releaseToken();
    this.stagger(this.def.heavy ? 1.0 : 1.5, true);
  }

  chargeMove(dt, a) {
    const sp = a.charge;
    this.want.x = Math.sin(this.attackDir);
    this.want.z = Math.cos(this.attackDir);
    this.want.speed = sp;
    this.want.instant = true;
    if (!this.attackHit) this.meleeCheck({ ...a, reach: a.reach + 0.6, arc: 2.4 });
    this.game.fx?.dust(this.pos.x, this.pos.y, this.pos.z, 2, 1.2);
    if (this.lastContacts && this.lastContacts > 0 && this.stateTime > a.windup + 0.15) {
      // slammed into a wall: stunned
      this.chargeHitWall = true;
      this.stateTime = a.windup + a.active;
      this.game.camera?.addShake(0.35);
      this.game.audio?.play('bruteSlam', { pos: this.pos, volume: 0.8 });
      this.game.fx?.dust(this.pos.x + this.want.x, this.pos.y + 1, this.pos.z + this.want.z, 20, 1.5);
    }
  }

  leapMove(dt, a, ta) {
    if (!this.leapState) {
      const tgt = this.lockedTarget || this.player.pos;
      const dx = tgt.x - this.pos.x, dz = tgt.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const T = a.active;
      this.leapState = { vx: (dx / T) * Math.min(1, (d - 0.6) / d), vz: (dz / T) * Math.min(1, (d - 0.6) / d), vy: 4 + 0.5 * 22 * T * 0.35, y0: this.pos.y };
      this.vy = this.leapState.vy;
      this.game.audio?.play('houndBark', { pos: this.pos, volume: 0.9 });
    }
    this.want.x = this.leapState.vx;
    this.want.z = this.leapState.vz;
    this.want.speed = 1;
    this.want.raw = true;
    if (!this.attackHit) this.meleeCheck(a);
    if (ta + dt >= a.active) this.leapState = null;
  }

  fireRanged(a, ta) {
    const d = this.game.director;
    if (a.ranged === 'fireball' && !this.attackFired) {
      this.attackFired = 1;
      const hand = this.handPos ? this.handPos() : { x: this.pos.x, y: this.pos.y + 1.6, z: this.pos.z };
      d.projectiles.fireball(hand, this.player, a.dmg, this);
    } else if (a.ranged === 'orb') {
      const n = a.count || 3;
      const shotEvery = a.active / n;
      while (this.attackFired < n && ta >= this.attackFired * shotEvery) {
        this.attackFired++;
        d.projectiles.orb({ x: this.pos.x, y: this.pos.y + 0.05, z: this.pos.z }, this.player, a.dmg, this, (this.attackFired - 2) * 0.12);
        this.game.audio?.play('orbShoot', { pos: this.pos, volume: 0.6 });
      }
    } else if (a.ranged === 'beam') {
      if (!this.attackFired) { this.attackFired = 1; d.projectiles.beam(this, a); }
    } else if (a.ranged === 'breath') {
      if (!this.attackFired) { this.attackFired = 1; d.projectiles.breath(this, a); }
    } else if (a.ranged === 'meteors') {
      if (!this.attackFired) { this.attackFired = 1; d.projectiles.meteors(this, a); }
    }
  }

  flyCombat(dt, dp, dy) {
    const d = this.def;
    const p = this.player;
    if (this.groundedT > 0) {
      // pulled down by the snare: crawl toward the player and bite
      this.hoverAltitude(dt, 1.2, 6);
      const atk = this.pickAttack(dp, dy);
      if (atk) { this.startAttack(atk); return; }
      this.chase(p.pos.x, p.pos.z, d.walk * 0.7, dt);
      return;
    }
    const alt = Math.max(d.hover, p.pos.y + 4.5);
    this.hoverAltitude(dt, alt);
    if (this.seesPlayer || this.arena) {
      const atk = this.pickAttack(Math.hypot(dp, this.pos.y - p.pos.y), dy);
      if (atk) { this.startAttack(atk); return; }
    }
    const [lo, hi] = d.keepAway;
    if (dp < lo) this.steer(this.pos.x - (p.pos.x - this.pos.x), this.pos.z - (p.pos.z - this.pos.z), d.run);
    else if (dp > hi) this.steer(p.pos.x, p.pos.z, d.run);
    else this.strafe(p.pos.x, p.pos.z, d.walk, dt);
  }

  hoverAltitude(dt, alt, rate = 2.5) {
    // stay above rooftops along the way
    const c = this.col;
    let top = 0;
    const fx = this.vel.x * 0.6, fz = this.vel.z * 0.6;
    for (const [ox, oz] of [[0, 0], [fx, fz], [fx * 2, fz * 2]]) {
      const g = c.groundAt(this.pos.x + ox, this.pos.z + oz, 0.8, 200);
      top = Math.max(top, g.y);
    }
    const target = Math.max(alt, top + 3.2);
    this.pos.y = damp(this.pos.y, target, rate * (this.pos.y < top + 1.5 ? 4 : 1), dt);
  }

  // ------------------------------------------------------------ imp climbing
  tryClimbToward(tp) {
    if (this.onRoof || this.climbCooldown > this.t) return false;
    const dx = tp.x - this.pos.x, dz = tp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 18) { this.chase(tp.x, tp.z, this.def.run, 1 / 60); return true; }
    const nx = dx / d, nz = dz / d;
    const h = this.col.raycast(this.pos.x, this.pos.y + 1.0, this.pos.z, nx, 0, nz, 1.4, climbFilter, _hit);
    if (h && h.c && Math.abs(h.ny) < 0.5) {
      this.climb = { nx: h.nx, nz: h.nz, x: h.x + h.nx * 0.4, z: h.z + h.nz * 0.4 };
      this.setState('climb');
      this.playSound('impScreech', 0.7, 1);
      return true;
    }
    // approach the building the player stands on
    this.chase(tp.x, tp.z, this.def.run, 1 / 60);
    return true;
  }

  st_climb(dt) {
    const c = this.climb;
    this.pos.x = c.x; this.pos.z = c.z;
    this.yaw = Math.atan2(-c.nx, -c.nz);
    this.pos.y += 3.8 * dt;
    const wall = this.col.raycast(this.pos.x, this.pos.y + 1.3, this.pos.z, -c.nx, 0, -c.nz, 0.9, climbFilter, _hit);
    if (!wall) {
      // reached the top: hop over the edge
      const tx = this.pos.x - c.nx * 0.9, tz = this.pos.z - c.nz * 0.9;
      const g = this.col.groundAt(tx, tz, 0.2, this.pos.y + 1.6);
      if (g.y > this.pos.y - 0.5 && this.col.isFree(tx, tz, 0.3, g.y + 0.2, g.y + 1.5)) {
        this.pos.set(tx, g.y, tz);
        this.onRoof = true;
        this.vy = 0;
      }
      this.climbCooldown = this.t + 2;
      this.setState('combat');
      return;
    }
    if (this.stateTime > 12) { this.climbCooldown = this.t + 6; this.setState('combat'); }
  }

  // ------------------------------------------------------------ reactions
  st_stagger(dt) {
    if (this.anim) this.anim.t = (this.stateTime % 1.0) / 1.0;
    if (this.def.flies) this.hoverAltitude(dt, this.groundedT > 0 ? 1.2 : this.def.hover);
    if (this.stateTime > this.staggerDur) {
      this.anim = null;
      this.parried = false;
      this.setState('combat');
    }
  }

  st_dazed(dt) {
    this.dazed -= dt;
    if (this.anim) this.anim.t = (this.stateTime % 1.2) / 1.2;
    if (this.def.flies) this.hoverAltitude(dt, 2.5);
    if (this.dazed <= 0) { this.anim = null; this.setState('combat'); }
  }

  st_glory(dt) {
    if (this.anim) this.anim.t = (this.stateTime % 1.4) / 1.4;
    if (this.def.flies) this.hoverAltitude(dt, 1.6, 4);
    if (this.stateTime > 3.2) {
      this.anim = null;
      this.poise = this.def.poise;
      this.setState('combat');
    }
  }

  st_knockdown(dt) {
    if (this.stateTime > 2.2) {
      this.anim = null;
      this.knockedDown = false;
      this.setState('combat');
    }
    void dt;
  }

  st_grabbed() {
    this.want.speed = 0;
  }

  st_hit(dt) {
    if (this.anim) this.anim.t = Math.min(1, this.stateTime / 0.35);
    if (this.def.flies) this.hoverAltitude(dt, this.groundedT > 0 ? 1.2 : this.def.hover);
    if (this.stateTime > 0.35) { this.anim = null; this.setState('combat'); }
  }

  stagger(dur, parried = false) {
    if (this.dead) return;
    this.staggerDur = dur;
    this.parried = parried;
    this.attack = null;
    this.telegraph = null;
    this.releaseToken();
    this.setState('stagger');
    this.anim = { clip: 'stagger', t: 0, loop: 1 };
    this.poise = this.def.poise;
  }

  knockdown() {
    if (this.dead || this.def.heavy || this.def.flies) return this.stagger(1.2);
    this.attack = null;
    this.telegraph = null;
    this.releaseToken();
    this.knockedDown = true;
    this.setState('knockdown');
    this.anim = { clip: 'down', t: 0 };
  }

  daze(dur) {
    if (this.dead) return;
    this.attack = null;
    this.telegraph = null;
    this.releaseToken();
    this.dazed = dur;
    this.setState('dazed');
    this.anim = { clip: this.def.boss ? 'kneel' : 'dazed', t: 0, loop: 1.2 };
  }

  enterGlory() {
    this.gloryUsed = true;
    this.attack = null;
    this.telegraph = null;
    this.releaseToken();
    this.setState('glory');
    this.anim = { clip: 'glory', t: 0, loop: 1.4 };
    this.game.events.emit('gloryReady', this);
  }

  get gloryable() {
    return !this.dead && (this.state === 'glory' || this.state === 'knockdown' || (this.state === 'stagger' && this.parried) || (this.state === 'dazed' && !this.def.boss));
  }

  /**
   * Apply damage. opts: { type, poise, dirX, dirZ, knockback, source, sneak, silent }
   * Returns the damage actually dealt.
   */
  takeHit(amount, opts = {}) {
    if (this.dead || this.state === 'spawn' || this.state === 'grabbed') return 0;
    const d = this.def;
    let mult = 1;
    let armored = false;
    if (d.armoredFront && opts.dirX !== undefined && this.burning <= 0 && !['stagger', 'glory', 'knockdown', 'dazed'].includes(this.state)) {
      // attack direction vs facing: hits from the front are reduced
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      if (-(opts.dirX * fx + opts.dirZ * fz) > 0.25) { mult *= 0.35; armored = true; }
    }
    if (this.burning > 0 && d.heavy) mult *= 1.4;
    if (this.groundedT > 0 && d.flies) mult *= 1.6;
    if (this.state === 'dazed') mult *= 1.5;
    if (opts.sneak && !this.alerted) mult *= 3;
    if (opts.type === 'fire' && this.type === 'imp') mult *= 0.6;
    const dmg = amount * mult;
    this.hp -= dmg;
    this.hitFlash = 0.12;
    if (opts.type === 'fire' && !opts.dot) this.burning = Math.max(this.burning, 4.5);
    if (!opts.silent) {
      this.game.events.emit('enemyDamaged', this, dmg, opts, armored);
      if (armored) this.game.audio?.play('hitArmor', { pos: this.pos, volume: 0.8 });
    }
    if (opts.knockback) {
      this.knock.x += (opts.dirX || 0) * opts.knockback * (d.heavy ? 0.25 : 1) / (d.mass || 1);
      this.knock.z += (opts.dirZ || 0) * opts.knockback * (d.heavy ? 0.25 : 1) / (d.mass || 1);
    }
    if (!this.alerted && opts.source === 'player') {
      this.lastSeen.copy(this.player.pos);
      this.lastSeenT = this.t;
      this.alert(false);
      this.setState('combat');
    }
    if (this.hp <= 0) {
      this.die(opts.killKind || (this.burning > 0 ? 'burn' : 'normal'));
      return dmg;
    }
    if (this.state === 'glory' && !opts.dot) {
      this.die(opts.type === 'fire' ? 'burn' : 'normal');
      return dmg;
    }
    if (!this.gloryUsed && !d.boss && this.hp <= this.maxHp * 0.22) {
      this.enterGlory();
      return dmg;
    }
    if (d.boss) { this.poise = 9999; return dmg; }
    this.poise -= opts.poise || 0;
    if (opts.knockdown) this.knockdown();
    else if (this.poise <= 0 || opts.stagger) this.stagger(opts.staggerDur || (d.heavy ? 0.9 : 1.1));
    else if (!opts.dot && !d.heavy && this.state !== 'attack' && this.state !== 'knockdown' && this.state !== 'dazed' && this.state !== 'stagger') {
      this.setState('hit');
      this.anim = { clip: 'hit', t: 0 };
    } else if (!opts.dot && this.state === 'attack' && this.phaseName === 'windup' && (opts.poise || 0) >= 14 && !d.heavy) {
      // heavy hits interrupt light enemies' windups
      this.stagger(0.7);
    }
    if (!opts.silent && !d.heavy) this.playSound(d.sounds.pain, 0.6, 0.5);
    return dmg;
  }

  die(kind = 'normal') {
    if (this.dead) return;
    this.dead = true;
    this.killKind = kind;
    this.deathT = 0;
    this.releaseToken();
    this.attack = null;
    this.telegraph = null;
    this.setState('dead');
    this.anim = { clip: 'death', t: 0 };
    this.playSound(this.def.sounds.death, this.def.heavy ? 1 : 0.7, 0);
    this.game.director.onEnemyDeath(this, kind);
  }

  st_dead(dt) {
    this.deathT += dt;
    if (this.anim) this.anim.t = Math.min(1, this.deathT / 0.7);
    if (this.def.flies && this.pos.y > 0.6) {
      this.vy -= 18 * dt;
      this.pos.y = Math.max(0.6, this.pos.y + this.vy * dt);
    }
    this.vel.x = damp(this.vel.x, 0, 5, dt);
    this.vel.z = damp(this.vel.z, 0, 5, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    if (this.deathT > 3.6) this.removed = true;
  }

  releaseToken() {
    if (this.token) this.game.director.releaseToken(this);
  }

  // ------------------------------------------------------------ movement
  /** Path-follow to a point (A* on the nav grid). Returns true on arrival. */
  moveTo(x, z, speed, dt, arrive = 0.8) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    if (Math.hypot(dx, dz) < arrive) { this.path = null; return true; }
    const nav = this.game.city.nav;
    this.pathT -= dt;
    if (!this.path || this.pathT <= 0 || (this.pathGoal && Math.hypot(this.pathGoal.x - x, this.pathGoal.z - z) > 2)) {
      this.path = nav.findPath(this.pos.x, this.pos.z, x, z, 6000);
      this.pathIdx = 0;
      this.pathT = 4 + Math.random() * 2;
      this.pathGoal = { x, z };
      if (!this.path) { this.path = [{ x, z }]; this.pathT = 1.5; }
    }
    let wp = this.path[this.pathIdx];
    while (wp && Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) < 0.7 && this.pathIdx < this.path.length - 1) {
      this.pathIdx++;
      wp = this.path[this.pathIdx];
    }
    if (!wp) return true;
    this.steer(wp.x, wp.z, speed);
    return false;
  }

  /** Chase using the shared flow field toward the player when available. */
  chase(x, z, speed, dt) {
    const director = this.game.director;
    if (!this.def.flies && !this.onRoof && director.flowValid) {
      const nav = this.game.city.nav;
      const f = nav.flowDir(this.pos.x, this.pos.z, _flow);
      if (f && f.d < 90) {
        // direct line when close and clear
        const dd = Math.hypot(x - this.pos.x, z - this.pos.z);
        if (dd < 4 && nav.lineWalkable(this.pos.x, this.pos.z, x, z)) this.steer(x, z, speed);
        else { this.want.x = f.x; this.want.z = f.z; this.want.speed = speed; }
        return;
      }
    }
    if (this.onRoof || this.def.flies) { this.steer(x, z, speed); return; }
    this.moveTo(x, z, speed, dt, 1.0);
  }

  steer(x, z, speed) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) { this.want.speed = 0; return; }
    this.want.x = dx / d;
    this.want.z = dz / d;
    this.want.speed = speed;
  }

  strafe(x, z, speed, dt) {
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafeT = rand(1.5, 3.5); this.strafeDir *= -1; }
    const dx = x - this.pos.x, dz = z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const tx = -dz / d * this.strafeDir, tz = dx / d * this.strafeDir;
    this.want.x = tx;
    this.want.z = tz;
    this.want.speed = speed;
  }

  locomote(dt) {
    const d = this.def;
    const w = this.want;
    let speed = w.speed * (this.slowed > 0 ? 0.4 : 1);
    if (w.raw) {
      this.vel.x = w.x; this.vel.z = w.z;
      w.raw = false;
    } else {
      const tx = (w.x || 0) * speed, tz = (w.z || 0) * speed;
      const acc = (w.instant ? 60 : d.heavy ? 10 : 22) * dt;
      this.vel.x = approach(this.vel.x, tx, acc);
      this.vel.z = approach(this.vel.z, tz, acc);
      w.instant = false;
    }
    // knockback impulse
    if (this.knock.x || this.knock.z) {
      this.vel.x += this.knock.x;
      this.vel.z += this.knock.z;
      this.knock.set(0, 0, 0);
    }
    // separation from other demons
    const others = this.game.director.near;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const rr = this.radius + o.radius + 0.15;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6 && Math.abs(this.pos.y - o.pos.y) < 2) {
        const dd = Math.sqrt(d2);
        const push = (rr - dd) / rr;
        this.vel.x += (dx / dd) * push * 3;
        this.vel.z += (dz / dd) * push * 3;
      }
    }
    // keep out of the player's body
    const p = this.game.player;
    if (!p.dead && p.visible && Math.abs(p.pos.y - this.pos.y) < 1.6) {
      const dx = this.pos.x - p.pos.x, dz = this.pos.z - p.pos.z;
      const rr = this.radius + 0.36;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const dd = Math.sqrt(d2);
        this.pos.x += (dx / dd) * (rr - dd);
        this.pos.z += (dz / dd) * (rr - dd);
      }
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.vel.x = damp(this.vel.x, w.speed ? this.vel.x : 0, 8, dt);
    this.vel.z = damp(this.vel.z, w.speed ? this.vel.z : 0, 8, dt);

    if (!d.flies || this.groundedT > 0 || this.dead) {
      const contacts = this._contacts || (this._contacts = []);
      contacts.length = 0;
      this.col.pushOut(this.pos, this.radius, this.pos.y + 0.45, this.pos.y + d.height, contacts);
      this.lastContacts = contacts.filter((c) => c.c.kind !== 'barrier').length;
      if (!d.flies || this.dead) {
        const g = this.col.groundAt(this.pos.x, this.pos.z, 0.25, this.pos.y + 0.55);
        if (this.pos.y - g.y > 0.6 || this.vy > 0) {
          // falling (off a roof) or leaping
          this.vy -= 22 * dt;
          this.pos.y += this.vy * dt;
          if (this.pos.y <= g.y && this.vy <= 0) { this.pos.y = g.y; this.vy = 0; }
        } else {
          this.pos.y = g.y;
          this.vy = 0;
        }
        this.onRoof = this.pos.y > 1.2 && !this.game.city.nav.walkable(this.pos.x, this.pos.z) || this.pos.y > 2.5;
      }
    } else {
      this.col.pushOut(this.pos, this.radius, this.pos.y - 0.5, this.pos.y + 0.6);
    }
    // facing
    let face = w.face;
    if (face === null || face === undefined) {
      if (Math.hypot(this.vel.x, this.vel.z) > 0.3) face = Math.atan2(this.vel.x, this.vel.z);
    }
    if (face !== null && face !== undefined) {
      const rate = this.state === 'attack' ? d.turn * 1.6 : d.turn;
      this.yaw = dampAngle(this.yaw, face, rate, dt);
    }
    this.speed2d = Math.hypot(this.vel.x, this.vel.z);
  }

  renderPos(alpha, out) { return out.lerpVectors(this.prev, this.pos, alpha); }
  renderYaw(alpha) { return this.prevYaw + angleDiff(this.prevYaw, this.yaw) * alpha; }
}

export { wrapAngle };
