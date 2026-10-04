import * as THREE from 'three';
import { buildAssassin, placeSword, idlePose, gaitPose, sneakPose, combatStance, climbPose, airPose, deadPose } from './humanoid.js';
import { sampleClip, overlayPose, blendPose } from './rig.js';
import { CLIPS } from './clips.js';
import { clamp, damp, dampFactor, smoothstep, angleDiff } from '../core/math.js';
import { LAYER_XRAY } from '../render/renderer.js';

// Renders + procedurally animates the assassin from the controller state.
// Runs every rendered frame with (scaled) frame dt; reads interpolated state.

const TMP = new THREE.Vector3();

export class PlayerView {
  constructor(game, materials) {
    this.game = game;
    this.model = buildAssassin(materials);
    this.mesh = this.model.mesh;
    this.mesh.frustumCulled = false;
    game.scene.add(this.mesh);
    placeSword(this.model, false);
    this.swordDrawn = false;
    this.cur = {};
    this.target = {};
    this.act = {};
    this.phase = 0;
    this.climbPhase = 0;
    this.bob = 0;
    this.rootPitch = 0;
    this.rootRoll = 0;
    this.rootY = 0;
    this.lean = 0;
    this.lastYaw = 0;
    this.tails = [0, 0, 0].map(() => ({ a: 0, v: 0 }));
    this.landSquash = 0;
    this.actionWeight = 0;
    this.time = 0;
    this.hbExtend = 0;
    this.renderPos = new THREE.Vector3();
  }

  setDrawn(drawn) {
    if (this.swordDrawn === drawn) return;
    this.swordDrawn = drawn;
    placeSword(this.model, drawn);
  }

  update(dt, alpha) {
    const p = this.game.player;
    this.time += dt;
    const pos = p.renderPos(alpha, this.renderPos);
    const yaw = p.renderYaw(alpha);
    this.mesh.position.copy(pos);
    this.mesh.rotation.y = yaw;
    this.mesh.visible = p.visible;
    if (!p.visible) return;

    // ---------------- base pose from the movement state
    const T = this.target;
    const st = p.state;
    const speed = p.speed2d;
    const k = dampFactor(14, dt);
    let rootPitch = 0, rootRoll = 0, rootY = 0, poseRate = 12;
    let bob = 0;
    const stateT = p.stateTime + alpha * (1 / 60);
    if (st === 'ground' || st === 'landroll' || p.groundLike) {
      const run = speed < 1.2 ? 0 : speed < 5.2 ? (speed - 1.2) / 3.7 : 1 + clamp((speed - 5.2) / 2.6, 0, 1);
      const stride = p.sneaking ? 1.0 : run < 1 ? 1.25 + run * 1.0 : 2.25 + (run - 1) * 0.65;
      this.phase += (speed * dt / stride) * Math.PI * 2 * (p.sneaking ? 1 : 1);
      const moving = clamp(speed / 1.4, 0, 1);
      const combat = p.inCombatStance && p.inCombatStance() && !p.sprinting;
      if (p.sneaking) {
        sneakPose(T, this.phase, moving);
        bob = T._bob;
      } else if (combat) {
        combatStance(T, this.time);
        const g = gaitPose({}, this.phase, Math.min(run, 0.8));
        // strafing legs only
        for (const b of ['thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR']) {
          const w = moving * 0.7;
          T[b] = [T[b][0] + (g[b][0] - T[b][0]) * w, T[b][1] * (1 - w), T[b][2]];
        }
        bob = T._bob + g._bob * moving;
      } else if (moving < 0.05) {
        idlePose(T, this.time);
        bob = 0;
      } else {
        gaitPose(T, this.phase, run);
        if (moving < 1) blendPose(T, idlePose({}, this.time), T, moving);
        bob = T._bob * moving;
      }
      if (st === 'landroll') {
        const u = clamp(stateT / 0.5, 0, 1);
        rootPitch = Math.sin(u * Math.PI) * 0.0 + u * Math.PI * 2;
        rootY = Math.sin(u * Math.PI) * 0.35 - 0.0;
        T.spine = [0.9, 0, 0]; T.chest = [0.4, 0, 0]; T.head = [0.4, 0, 0];
        T.thighL = [-1.9, 0, 0.1]; T.thighR = [-1.9, 0, -0.1]; T.shinL = [2.4, 0, 0]; T.shinR = [2.4, 0, 0];
        T.armL = [-1.0, 0, 0.3]; T.armR = [-1.0, 0, -0.3]; T.foreL = [-1.4, 0, 0]; T.foreR = [-1.4, 0, 0];
        bob = -0.45 * Math.sin(u * Math.PI);
        poseRate = 30;
      }
      // lean into turns
      const yawRate = angleDiff(this.lastYaw, yaw) / Math.max(dt, 1e-4);
      this.lean = damp(this.lean, clamp(-yawRate * speed * 0.012, -0.3, 0.3), 8, dt);
      rootRoll = this.lean;
    } else if (st === 'air') {
      airPose(T, p.vel.y, this.time);
      poseRate = 9;
      if (p.jumpTarget && p.vel.y > 0) { T.thighL = [-1.2, 0, 0.1]; T.shinL = [1.6, 0, 0]; T.thighR = [0.35, 0, 0]; T.shinR = [0.6, 0, 0]; }
    } else if (st === 'climb') {
      const w = p.wall;
      this.climbPhase += (p.climbDist - (this.lastClimbDist ?? p.climbDist)) * 4.2;
      this.lastClimbDist = p.climbDist;
      climbPose(T, this.climbPhase, w.hanging ? 1 : 0, 0);
      poseRate = 16;
    } else if (st === 'mantle' || st === 'vault') {
      const tr = p.trans;
      const u = tr ? clamp((tr.t + alpha / 60) / tr.dur, 0, 1) : 1;
      sampleClip(CLIPS[st === 'mantle' ? 'mantle' : 'vault'], u, T);
      poseRate = 30;
    } else if (st === 'leap') {
      const u = clamp(p.leap.t / p.leap.dur, 0, 1);
      sampleClip(CLIPS.dive, u, T);
      rootPitch = smoothstep(0, 0.3, u) * 1.35 - smoothstep(0.8, 1.0, u) * 1.9;
      poseRate = 10;
    } else if (st === 'sync') {
      sampleClip(CLIPS.sync, clamp(stateT / 3.6, 0, 1), T);
      bob = -0.55;
      poseRate = 6;
    } else if (st === 'dead') {
      deadPose(T);
      rootRoll = smoothstep(0, 0.7, stateT) * 1.45;
      poseRate = 8;
    } else if (st === 'hidden') {
      sampleClip(CLIPS.hidden, 0, T);
    } else {
      // combat-owned states start from the stance; the action clip overlays it
      combatStance(T, this.time);
      bob = T._bob;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (sp > 1) {
        const g = gaitPose({}, (this.phase += (sp * dt / 1.6) * Math.PI * 2), 0.6);
        for (const b of ['thighL', 'thighR', 'shinL', 'shinR']) T[b] = [T[b][0] * 0.5 + g[b][0] * 0.5, 0, T[b][2]];
      }
    }
    this.lastYaw = yaw;

    // ---------------- damped blend toward the target pose
    const kk = dampFactor(poseRate, dt);
    for (const name in T) {
      if (name[0] === '_') continue;
      const t = T[name];
      const c = this.cur[name] || (this.cur[name] = [t[0], t[1], t[2]]);
      c[0] += (t[0] - c[0]) * kk;
      c[1] += (t[1] - c[1]) * kk;
      c[2] += (t[2] - c[2]) * kk;
    }
    this.bob = damp(this.bob, bob, 14, dt);
    this.rootPitch = st === 'landroll' || st === 'leap' ? rootPitch : damp(this.rootPitch, rootPitch, 10, dt);
    this.rootRoll = damp(this.rootRoll, rootRoll, 8, dt);
    this.rootY = st === 'landroll' ? rootY : damp(this.rootY, rootY, 10, dt);

    // ---------------- action overlay (combat clips; crisp, not damped)
    const pose = this.act;
    for (const n in this.cur) {
      const c = this.cur[n];
      const o = pose[n] || (pose[n] = [0, 0, 0]);
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2];
    }
    const anim = p.anim;
    const want = anim && anim.clip ? 1 : 0;
    this.actionWeight = damp(this.actionWeight, want, anim && anim.fast ? 40 : 22, dt);
    if (anim && anim.clip && this.actionWeight > 0.001) {
      const frames = anim.frames || CLIPS[anim.clip];
      if (frames) {
        const u = clamp(anim.t + (anim.rate || 0) * alpha / 60, 0, 1);
        const sampled = sampleClip(frames, u, this._clipTmp || (this._clipTmp = {}));
        overlayPose(pose, sampled, this.actionWeight * (anim.weight ?? 1));
        if (anim.rootYaw) this.mesh.rotation.y += anim.rootYaw(u);
        if (anim.rootPitch) this.rootPitch = anim.rootPitch(u);
        if (anim.bob !== undefined) this.bob = anim.bob;
      }
    } else if (this._clipTmp) {
      for (const n in this._clipTmp) delete this._clipTmp[n];
    }

    // landing squash
    if (p.fx.landing > 0) {
      this.landSquash = Math.max(this.landSquash, p.fx.landing);
      p.fx.landing = 0;
    }
    this.landSquash = Math.max(0, this.landSquash - dt * 3.2);
    const sq = Math.sin(Math.min(1, this.landSquash) * Math.PI * 0.5) * this.landSquash;
    if (sq > 0.01 && (st === 'ground')) {
      pose.thighL[0] -= sq * 0.7; pose.thighR[0] -= sq * 0.7;
      pose.shinL[0] += sq * 1.2; pose.shinR[0] += sq * 1.2;
      pose.spine[0] += sq * 0.3;
    }

    // ---------------- apply
    const bones = this.model.bones;
    for (const name in bones) {
      const b = bones[name];
      const q = pose[name];
      if (q) b.rotation.set(q[0], q[1], q[2]);
    }
    bones.hips.position.y = this.model.rest.hips.y + this.bob - sq * 0.22;
    bones.root.rotation.set(this.rootPitch, 0, this.rootRoll);
    bones.root.position.y = this.rootY + (st === 'landroll' ? 0.35 * Math.sin(clamp(stateT / 0.5, 0, 1) * Math.PI) : 0);
    if (st === 'landroll' || st === 'leap' || (anim && anim.rootPitch)) {
      // rotate around the body centre instead of the feet
      const c = 0.9;
      bones.root.position.y += c - c * Math.cos(this.rootPitch);
      bones.root.position.z = -c * Math.sin(this.rootPitch) * (st === 'leap' ? 1 : 1);
    } else bones.root.position.z = 0;

    this.updateTails(dt, p, speed);

    // hidden blade
    this.hbExtend = damp(this.hbExtend, p.hiddenBladeOut ? 1 : 0, 25, dt);
    const hb = this.model.hiddenBlade;
    hb.scale.y = 0.05 + this.hbExtend * 0.95;
    hb.position.y = -this.hbExtend * 0.06;
    // sword glow with fury
    const bm = this.model.sword.userData.bladeMat;
    bm.emissiveIntensity = damp(bm.emissiveIntensity, (p.fury || 0) >= 3 ? 1.4 : (p.fury || 0) * 0.25, 5, dt);
    void k;
  }

  updateTails(dt, p, speed) {
    // spring chain: swing back with speed, lift when falling, follow legs
    const bones = this.model.bones;
    const falling = p.state === 'air' ? clamp(-p.vel.y / 12, -0.5, 1) : 0;
    const climbing = p.state === 'climb' ? 0.15 : 0;
    const target1 = clamp(speed * 0.085, 0, 0.75) + falling * 1.1 + climbing + Math.max(0, -this.act.thighL[0] - 0.3) * 0.25 + Math.max(0, -this.act.thighR[0] - 0.3) * 0.25;
    const flap = Math.sin(this.time * (6 + speed)) * 0.06 * clamp(speed / 4, 0, 1);
    const targets = [target1 + flap, target1 * 0.35 + flap * 1.5, target1 * 0.25 + flap * 2];
    for (let i = 0; i < 3; i++) {
      const s = this.tails[i];
      const stiff = 90 - i * 25, damping = 9 - i * 2;
      s.v += ((targets[i] - s.a) * stiff - s.v * damping) * dt;
      s.a += s.v * dt;
      s.a = clamp(s.a, -0.6, 1.6);
    }
    bones.tail1.rotation.set(this.tails[0].a + Math.max(0, this.act.spine[0]) * -0.6, 0, 0);
    bones.tail2.rotation.set(this.tails[1].a, 0, 0);
    bones.tail3.rotation.set(this.tails[2].a, 0, 0);
  }

  setXray(on) {
    if (on) this.mesh.layers.enable(LAYER_XRAY); else this.mesh.layers.disable(LAYER_XRAY);
  }

  /** World position of a bone (e.g. 'handL') for effects. */
  bonePos(name, out = TMP) {
    return this.model.bones[name].getWorldPosition(out);
  }
}
