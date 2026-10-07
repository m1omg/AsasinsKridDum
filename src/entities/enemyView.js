import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BUILDERS } from './demonModels.js';
import { ENEMY_CLIPS } from './enemyTypes.js';
import { idlePose, gaitPose, climbPose, airPose } from './humanoid.js';
import { sampleClip, overlayPose } from './rig.js';
import { clamp, damp, dampFactor, smoothstep } from '../core/math.js';
import { LAYER_XRAY } from '../render/renderer.js';
import { addRim } from '../render/materials.js';

// Visual side of a demon: instanced model, per-instance materials for glow
// effects (telegraph, burning, glory stagger, dissolve) and procedural anims.

const templates = {};
const TMPV = new THREE.Vector3();
const C_YELLOW = new THREE.Color(1.0, 0.75, 0.15);
const C_RED = new THREE.Color(1.0, 0.08, 0.02);
const C_BLUE = new THREE.Color(0.2, 0.55, 1.0);
const C_ORANGE = new THREE.Color(1.0, 0.45, 0.05);
const C_WHITE = new THREE.Color(1, 1, 1);
const C_PURPLE = new THREE.Color(0.6, 0.2, 1.0);
const C_FIRE = new THREE.Color(1.0, 0.35, 0.05);

function getTemplate(type, materials) {
  if (!templates[type]) templates[type] = BUILDERS[type](materials);
  return templates[type];
}

export class EnemyView {
  constructor(enemy, game) {
    this.enemy = enemy;
    this.game = game;
    const tpl = getTemplate(enemy.type, game.materials);
    this.mesh = cloneSkinned(tpl.mesh);
    // per-instance materials so glow effects don't leak between demons
    const src = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    // (glow maps are a custom property, so carry them over to the copies)
    this.mats = src.map((m) => { const c = m.clone(); c.glowMap = m.glowMap; c.glowStrength = m.glowStrength; return c; });
    this.mesh.material = this.mats.length === 1 ? this.mats[0] : this.mats;
    this.litMats = this.mats.filter((m) => m.isMeshStandardMaterial);
    // cloned materials lose shader hooks: give every demon a hot rim light
    for (const m of this.litMats) addRim(m, enemy.def.boss ? 0xff7a2a : 0xff4a14, enemy.def.boss ? 0.5 : 0.36, 2.6);
    this.baseScale = enemy.def.modelScale || 1;
    this.mesh.scale.setScalar(this.baseScale);
    this.glowMat = this.mats.find((m) => m.isMeshBasicMaterial) || null;
    this.bones = {};
    this.mesh.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    this.rest = {};
    for (const n in this.bones) this.rest[n] = this.bones[n].position.clone();
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.layers.enable(LAYER_XRAY);
    game.scene.add(this.mesh);
    this.cur = {};
    this.pose = {};
    this.phase = Math.random() * 10;
    this.time = Math.random() * 10;
    this.actionW = 0;
    this.lastClip = null;
    this.bob = 0;
    this.fall = 0;
    this.sink = 0;
    this.scale = 1;
    this.bound = new THREE.Sphere(new THREE.Vector3(), enemy.def.height);
    this.visibleFrames = 0;
    this.emberAcc = 0;
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    for (const m of this.mats) m.dispose();
    this.mesh.skeleton?.dispose?.();
  }

  headPos(out = TMPV) {
    const e = this.enemy;
    out.copy(this.mesh.position);
    out.y += e.def.flies ? 1.0 : e.def.height + 0.25;
    return out;
  }

  handPos() {
    const b = this.bones.handR || this.bones.jaw || this.bones.body;
    return b.getWorldPosition(new THREE.Vector3());
  }

  update(dt, alpha, frustum, camPos) {
    const e = this.enemy;
    const m = this.mesh;
    e.renderPos(alpha, m.position);
    m.rotation.y = e.renderYaw(alpha);
    // culling + LOD for animation work
    this.bound.center.copy(m.position);
    this.bound.center.y += e.def.height * 0.5;
    const dCam = m.position.distanceTo(camPos);
    const inView = frustum.intersectsSphere(this.bound) && dCam < 120;
    m.visible = inView && !e.removed;
    // shadows only near the camera (the shadow map covers ~50 m anyway)
    m.castShadow = dCam < 38 || e.def.boss;
    if (!m.visible) return;
    this.time += dt;
    if (dCam > 70 && (this.visibleFrames++ % 3) !== 0) return; // far: animate at 1/3 rate
    this.animate(dt, alpha);
    this.effects(dt);
  }

  animate(dt, alpha) {
    const e = this.enemy;
    const skel = e.def.skel;
    const T = this._target || (this._target = {});
    for (const k in T) delete T[k];
    const sp = e.speed2d || 0;
    let rootRx = 0, rootRz = 0, rootY = 0;
    let rate = 12;
    if (skel === 'humanoid') {
      const run = e.def.heavy ? clamp(sp / 3, 0, 1) * 0.7 : sp < 1.6 ? sp / 1.6 * 0.3 : 0.3 + clamp((sp - 1.6) / 3.5, 0, 1) * 1.0;
      const stride = (e.def.heavy ? 1.9 : 1.2) * (e.def.height / 1.75) * (run > 0.5 ? 1.6 : 1);
      this.phase += (sp * dt / stride) * Math.PI * 2;
      if (e.state === 'climb') climbPose(T, this.phase += dt * 9, 0, 0);
      else if (e.vy !== 0 && e.state !== 'attack') airPose(T, e.vy, this.time);
      else if (sp < 0.25) idlePose(T, this.time, 1.4);
      else gaitPose(T, this.phase, run);
      this.styleHumanoid(T, sp);
    } else if (skel === 'hound') {
      this.houndPose(T, sp, dt);
    } else if (skel === 'gazer') {
      this.gazerPose(T, dt);
    }
    // damped base
    const k = dampFactor(rate, dt);
    for (const n in T) {
      if (n[0] === '_') continue;
      const t = T[n];
      const c = this.cur[n] || (this.cur[n] = [t[0], t[1], t[2]]);
      c[0] += (t[0] - c[0]) * k; c[1] += (t[1] - c[1]) * k; c[2] += (t[2] - c[2]) * k;
    }
    const pose = this.pose;
    for (const n in this.cur) {
      const c = this.cur[n];
      const o = pose[n] || (pose[n] = [0, 0, 0]);
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
    }
    const kneel = e.def.boss && e.state === 'dazed' ? -0.36 : 0;
    this.bob = damp(this.bob, (T._bob || 0) + kneel, kneel ? 6 : 10, dt);
    // action overlay
    const anim = e.anim;
    const frames = anim && ENEMY_CLIPS[anim.clip];
    this.actionW = damp(this.actionW, frames ? 1 : 0, 20, dt);
    if (frames && this.actionW > 0.01) {
      let u = anim.t + (anim.rate || 0) * alpha / 60;
      if (anim.loop) u = (u % 1 + 1) % 1; else u = clamp(u, 0, 1);
      const s = sampleClip(frames, u, this._clip || (this._clip = {}));
      overlayPose(pose, s, this.actionW);
    }
    // whole-body motion
    if (e.state === 'dead') {
      const u = smoothstep(0, 0.6, e.deathT);
      if (skel === 'humanoid') rootRx = -u * 1.5 * (e.killKind === 'assassinate' ? -1 : 1);
      else if (skel === 'hound') rootRz = u * 1.5;
      this.sink = smoothstep(1.8, 3.4, e.deathT) * 0.8;
    } else if (e.state === 'knockdown') {
      const u = e.stateTime < 1.8 ? smoothstep(0, 0.3, e.stateTime) : 1 - smoothstep(1.8, 2.2, e.stateTime);
      rootRx = -u * 1.45;
    } else if (e.state === 'spawn') {
      rootY = -(e.spawnT / 1.1) * e.def.height * 1.1;
    } else if (e.state === 'attack' && e.attack && e.attack.leap && skel === 'hound') {
      rootRx = -0.25;
    }
    this.fall = rootRx;
    // apply
    const b = this.bones;
    for (const n in b) {
      const q = pose[n];
      if (q) b[n].rotation.set(q[0], q[1], q[2]);
    }
    if (b.hips) b.hips.position.y = this.rest.hips.y + this.bob * (e.def.height / 1.75);
    if (b.root) {
      b.root.rotation.set(rootRx, 0, rootRz);
      b.root.position.y = rootY - this.sink;
      if (skel === 'humanoid' && rootRx !== 0) {
        // pivot near the hips so falls look natural
        const c = e.def.height * 0.12;
        b.root.position.z = -Math.sin(rootRx) * c;
      } else b.root.position.z = 0;
    }
  }

  styleHumanoid(T, sp) {
    const e = this.enemy;
    const st = e.state;
    if (e.type === 'thrall') {
      T.spine = [(T.spine?.[0] || 0) + 0.3, 0, 0];
      T.head = [-0.25, Math.sin(this.time * 0.7) * 0.3, Math.sin(this.time * 0.5) * 0.15];
      if (st === 'combat' || st === 'suspicious' || st === 'search') {
        T.armL = [-0.9 + (T.armL?.[0] || 0) * 0.3, 0, 0.2];
        T.armR = [-0.9 + (T.armR?.[0] || 0) * 0.3, 0, -0.2];
        T.foreL = [-0.4, 0, 0]; T.foreR = [-0.4, 0, 0];
      }
    } else if (e.type === 'imp') {
      T.spine = [(T.spine?.[0] || 0) + 0.25, 0, 0];
      T.head = [-0.3, 0, 0];
      if (T.thighL) { T.thighL[0] -= 0.25; T.thighR[0] -= 0.25; T.shinL[0] += 0.35; T.shinR[0] += 0.35; }
      T._bob = (T._bob || 0) - 0.08;
      if (T.armL) { T.armL[2] += 0.25; T.armR[2] -= 0.25; }
      if (T.tail1) { T.tail1 = [0.2 + Math.sin(this.time * 3) * 0.2, Math.sin(this.time * 2) * 0.4, 0]; T.tail2 = [0.3, Math.sin(this.time * 2 + 1) * 0.5, 0]; T.tail3 = [0.2, 0, 0]; }
      else { T.tail1 = [0.2 + Math.sin(this.time * 3) * 0.2, Math.sin(this.time * 2) * 0.4, 0]; T.tail2 = [0.3, Math.sin(this.time * 2 + 1) * 0.5, 0]; T.tail3 = [0.2, 0, 0]; }
    } else if (e.type === 'brute' || e.type === 'boss') {
      T.spine = [(T.spine?.[0] || 0) + 0.15, 0, 0];
      if (T.armL) { T.armL[2] += 0.28; T.armR[2] -= 0.28; T.armL[0] *= 0.7; T.armR[0] *= 0.7; }
      if (T.thighL) { T.thighL[2] += 0.12; T.thighR[2] -= 0.12; }
      T.foreL = [-0.45, 0, 0]; T.foreR = [-0.45, 0, 0];
    }
    void sp;
  }

  houndPose(T, sp, dt) {
    const e = this.enemy;
    const run = clamp(sp / 8, 0, 1);
    this.phase += dt * (sp > 0.2 ? 3 + sp * 1.4 : 0);
    const ph = this.phase;
    const s = Math.sin(ph), c = Math.cos(ph);
    const A = 0.25 + run * 0.6;
    T.body = [Math.sin(ph * 2) * 0.05 * run, 0, 0];
    T.chest = [-Math.sin(ph * 2) * 0.06 * run, 0, 0];
    T.neck = [0.1 + run * 0.15, Math.sin(this.time * 0.8) * 0.2 * (1 - run), 0];
    T.head = [-0.1, 0, 0];
    T.jaw = [0.05 + (e.state === 'combat' ? 0.15 + Math.max(0, Math.sin(this.time * 4)) * 0.1 : 0), 0, 0];
    // gallop: front pair and back pair out of phase
    T.flU = [-s * A, 0, 0]; T.frU = [-Math.sin(ph + 0.4) * A, 0, 0];
    T.flL = [Math.max(0, c) * 0.9 * run, 0, 0]; T.frL = [Math.max(0, Math.cos(ph + 0.4)) * 0.9 * run, 0, 0];
    T.blU = [Math.sin(ph + 2.4) * A, 0, 0]; T.brU = [Math.sin(ph + 2.8) * A, 0, 0];
    T.blL = [-Math.max(0, Math.cos(ph + 2.4)) * 0.8 * run, 0, 0]; T.brL = [-Math.max(0, Math.cos(ph + 2.8)) * 0.8 * run, 0, 0];
    T.tail1 = [0.4 - run * 0.5, Math.sin(this.time * (e.alerted ? 9 : 3)) * 0.4, 0];
    T.tail2 = [0.2, Math.sin(this.time * 3 + 1) * 0.3, 0];
    T._bob = -Math.abs(s) * 0.06 * run;
    if (e.state === 'combat' && sp < 1) { T.body = [0.15, 0, 0]; T.chest = [0.12, 0, 0]; T.neck = [0.35, 0, 0]; }
  }

  gazerPose(T, dt) {
    const e = this.enemy;
    const t = this.time;
    T.body = [Math.sin(t * 1.3) * 0.08, 0, Math.sin(t * 0.9) * 0.06];
    T.jaw = [0.1 + Math.sin(t * 2) * 0.05, 0, 0];
    // eye tracks the player
    const p = this.game.player;
    const dx = p.pos.x - e.pos.x, dy = p.pos.y + 1.2 - e.pos.y, dz = p.pos.z - e.pos.z;
    const yawTo = Math.atan2(dx, dz) - e.yaw;
    const pitch = -Math.atan2(dy, Math.hypot(dx, dz));
    T.eye = [clamp(pitch, -0.6, 0.6), clamp(Math.atan2(Math.sin(yawTo), Math.cos(yawTo)), -0.6, 0.6), 0];
    for (let i = 0; i < 4; i++) {
      const ph = t * 2.2 + i * 1.6;
      T[`t${i}a`] = [Math.sin(ph) * 0.35, 0, Math.cos(ph) * 0.35];
      T[`t${i}b`] = [Math.sin(ph - 0.7) * 0.5, 0, Math.cos(ph - 0.7) * 0.5];
      T[`t${i}c`] = [Math.sin(ph - 1.4) * 0.6, 0, Math.cos(ph - 1.4) * 0.6];
    }
    T._bob = 0;
    void dt;
  }

  effects(dt) {
    const e = this.enemy;
    let col = null, inten = 0;
    const t = this.time;
    if (e.hitFlash > 0) { col = C_WHITE; inten = 0.8; }
    else if (e.state === 'dead') {
      const u = smoothstep(1.5, 3.2, e.deathT);
      col = C_FIRE; inten = u * 3;
      if (u > 0.05) {
        this.emberAcc += dt * 60 * u;
        while (this.emberAcc > 1) {
          this.emberAcc -= 1;
          const p = this.mesh.position;
          const h = e.def.height;
          this.game.fx.add.emit(p.x + (Math.random() - 0.5) * h * 0.4, p.y + Math.random() * h * 0.5, p.z + (Math.random() - 0.5) * h * 0.4, (Math.random() - 0.5), 1 + Math.random() * 2, (Math.random() - 0.5), 0.6 + Math.random() * 0.6, 0.08, 0.02, [3, 1.2, 0.3, 1], [1, 0.2, 0, 0], -0.5, 0.5);
        }
      }
    } else if (e.state === 'glory') {
      const u = e.stateTime;
      col = u < 1.6 ? C_BLUE : C_ORANGE;
      inten = 0.6 + 0.6 * Math.max(0, Math.sin(t * (u < 1.6 ? 6 : 14)));
    } else if (e.state === 'stagger' && e.parried) {
      col = C_BLUE; inten = 0.5 + 0.4 * Math.sin(t * 10);
    } else if (e.state === 'attack' && e.phaseName === 'windup' && e.telegraph) {
      const a = e.attack;
      const u = clamp(e.stateTime / (e.attackW ?? a.windup), 0, 1);
      col = e.telegraph === 'red' ? C_RED : C_YELLOW;
      inten = u > 0.45 ? (0.4 + 0.9 * u) * (0.75 + 0.25 * Math.sin(t * 30)) : 0;
    } else if (e.state === 'dazed') {
      col = C_PURPLE; inten = 0.35 + 0.25 * Math.sin(t * 5);
    } else if (e.burning > 0) {
      col = C_FIRE; inten = 0.5 + 0.4 * Math.sin(t * 17) * Math.sin(t * 7);
    }
    for (const m of this.litMats) {
      if (col) m.flash.copy(col).multiplyScalar(inten);
      else m.flash.setRGB(0, 0, 0);
    }
    if (this.glowMat) {
      const base = e.state === 'attack' && e.phaseName === 'windup' ? 1.6 : e.alerted ? 1.25 : 1;
      this.glowMat.color.setScalar(e.dead ? Math.max(0, 1 - e.deathT) : base);
    }
    // burning: flames licking off the body + light
    if (e.burning > 0 && !e.dead) {
      this.burnAcc = (this.burnAcc || 0) + dt * 40;
      const p = this.mesh.position, h = e.def.height;
      while (this.burnAcc > 1) {
        this.burnAcc -= 1;
        this.game.fx.add.emit(p.x + (Math.random() - 0.5) * h * 0.35, p.y + Math.random() * h * 0.9, p.z + (Math.random() - 0.5) * h * 0.35, 0, 1.5 + Math.random() * 1.5, 0, 0.3 + Math.random() * 0.35, 0.25, 0.05, [2.8, 1.2, 0.3, 1], [0.8, 0.1, 0, 0], -1, 1);
      }
      this.game.fx.attachedLight({ x: p.x, y: p.y + h * 0.6, z: p.z, color: 0xff6020, intensity: 2.2, distance: 8, flicker: 0.4 });
    }
    // the mesh sinks while dissolving
    if (e.state === 'dead') {
      const s = 1 - smoothstep(2.6, 3.6, e.deathT) * 0.9;
      this.mesh.scale.setScalar(s * this.baseScale);
    } else if (this.mesh.scale.x !== this.baseScale) this.mesh.scale.setScalar(this.baseScale);
  }
}
