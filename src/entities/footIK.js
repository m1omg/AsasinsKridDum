import * as THREE from 'three';
import { clamp, smoothstep, angleDiff, lerpAngle, dampFactor } from '../core/math.js';

// Foot planting: feet stay put on the ground while they carry weight, so
// characters walk instead of gliding.
//
// The body keeps its procedural animation (arm swing, torso twist, combat
// clips); the legs are solved with two-bone IK toward footholds. A foothold is
// fixed in the world while the foot is planted. When the gait phase says the
// foot should lift, it swings in an arc to the next foothold, predicted from
// the character's velocity so it lands where the body will be. Footholds sit
// on the real ground (stairs, slopes, beams), the hips lower when a foothold is
// out of reach, and standing characters step their feet back under them when
// they turn or drift. Works for two legs (humanoids) and four (the hound).

const TAU = Math.PI * 2;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _k = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _e = new THREE.Euler();
const _qe = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const frac = (x) => x - Math.floor(x);
const LEG = 0.86; // leg length (hip to ankle) of a 1.8 m human, the reference for gait tables

/**
 * Stride (distance per full gait cycle, i.e. two steps) and duty factor (the
 * share of the cycle each foot spends on the ground) at a given speed, for a
 * leg of `legLen` world units. Bigger characters take proportionally longer,
 * slower strides.
 */
export function gaitShape(speed, legLen) {
  const k = LEG / Math.max(legLen, 0.05);
  const v = speed * k;
  const stride = v < 1.4 ? 1.1 + v * 0.1786 : v < 4.9 ? 1.35 + (v - 1.4) * 0.2429 : 2.2 + (v - 4.9) * 0.2333;
  const duty = v < 1.6 ? 0.62 : v < 4.9 ? 0.62 - (v - 1.6) * 0.0848 : Math.max(0.26, 0.34 - (v - 4.9) * 0.02);
  return { stride: stride / k, duty };
}

/** Model-space position of a bone's joint at rest (rest rotations are identity). */
function restJoint(bone, rest, out) {
  out.set(0, 0, 0);
  for (let b = bone; b && b.isBone; b = b.parent) {
    const r = rest[b.name];
    if (r) out.add(r);
  }
  return out;
}

/** Rotation basis with the bone pointing along `dir` (local -Y) and its front toward `front`. */
function boneBasis(dir, front, out) {
  _y.copy(dir).negate().normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.copy(Z_AXIS).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  out.makeBasis(_x, _y, _z);
  return out;
}

/**
 * A two-bone limb of a rig (thigh-shin-foot, upper arm-forearm-hand) set up for aimLimb.
 * restPole: the side of the limb (parent space, at rest) that the middle joint bends toward.
 */
export function limbChain(model, upper, lower, end, restPole = [0, 0, 1]) {
  const B = model.bones, R = model.rest;
  const k = R[lower].clone(), f = R[end].clone();
  const pole = new THREE.Vector3(...restPole).normalize();
  const restBasis = boneBasis(k, pole, new THREE.Matrix4());
  return {
    up: B[upper], lo: B[lower], end: B[end],
    l1: k.length(), l2: f.length(),
    endRest: f.clone().normalize(),
    pole,
    restBasisInv: restBasis.clone().invert(),
    hinge: new THREE.Vector3().setFromMatrixColumn(restBasis, 0).normalize(), // knee / elbow axis
  };
}

/**
 * Two-bone IK: aim the upper bone so the lower one bends the middle joint toward the pole
 * (parent space) and the end joint reaches the target (world), or as near as the limb allows.
 * weight blends from the current pose. Returns false when the target sits on the root joint.
 */
export function aimLimb(l, target, pole, weight) {
  const parent = l.up.parent;
  _m.copy(parent.matrixWorld).invert();
  _t.copy(target).applyMatrix4(_m); // end target in the parent's space (model units)
  const o = l.up.position;
  _n.subVectors(_t, o);
  let d = _n.length();
  if (d < 1e-6) return false;
  _n.divideScalar(d);
  const { l1, l2 } = l;
  d = clamp(d, Math.abs(l1 - l2) * 1.02 + 1e-4, (l1 + l2) * 0.9995);
  // middle joint direction perpendicular to the root-end line
  _p.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1).addScaledVector(_n, -_n.z);
  _p.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _k.copy(_n).multiplyScalar(cosA * l1).addScaledVector(_p, sinA * l1); // middle - root
  // upper bone: rest frame -> frame along the upper bone with its front toward the pole
  boneBasis(_k, _p, _basis).multiply(l.restBasisInv);
  _q.setFromRotationMatrix(_basis);
  // lower bone: hinge about the upper bone's local x axis
  _v.copy(_n).multiplyScalar(d).sub(_k).normalize(); // middle -> end, parent space
  _q2.copy(_q).invert();
  _v.applyQuaternion(_q2); // in upper-bone space
  _x.copy(l.hinge);
  const r = _w.copy(l.endRest).addScaledVector(_x, -l.endRest.dot(_x)).normalize();
  const u = _z.copy(_v).addScaledVector(_x, -_v.dot(_x)).normalize();
  const ang = Math.atan2(_y.crossVectors(r, u).dot(_x), r.dot(u));
  _q3.setFromAxisAngle(_x, ang);
  if (weight >= 0.999) {
    l.up.quaternion.copy(_q);
    l.lo.quaternion.copy(_q3);
  } else {
    l.up.quaternion.slerp(_q, weight);
    l.lo.quaternion.slerp(_q3, weight);
  }
  l.up.updateMatrixWorld(true);
  return true;
}

/** Turn the end bone (foot, hand) to a world orientation, blended by weight. */
export function orientEnd(l, worldQuat, weight) {
  l.lo.getWorldQuaternion(_q2).invert();
  _q.copy(worldQuat).premultiply(_q2);
  if (weight >= 0.999) l.end.quaternion.copy(_q);
  else l.end.quaternion.slerp(_q, weight);
  l.end.updateMatrixWorld(true);
}

export class FootPlanter {
  /**
   * model: { bones, rest } (rest = bone positions relative to their parents).
   * cfg: {
   *   pelvis: bone lowered when footholds are out of reach,
   *   legs: [{ upper, lower, end, offset (gait phase, rad), pole: [x,y,z] knee direction }],
   *   width: scale for the side-to-side spacing of the feet,
   * }
   */
  constructor(model, cfg) {
    const B = model.bones, R = model.rest;
    this.pelvis = B[cfg.pelvis];
    this.legs = cfg.legs.map((c) => {
      const ankle = restJoint(B[c.end], R, new THREE.Vector3());
      return {
        ...limbChain(model, c.upper, c.lower, c.end, c.pole || [0, 0, 1]),
        offset: c.offset || 0,
        // where the foot rests under the body (model space, on the ground)
        home: new THREE.Vector3(ankle.x * (cfg.width ?? 1), 0, ankle.z),
        ankleH: ankle.y,
        planted: true,
        ready: true,
        plant: new THREE.Vector3(),
        pos: new THREE.Vector3(),
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        yaw: 0, fromYaw: 0, pitch: 0, fromPitch: 0,
        t: 0, dur: 0.3, idle: false, prevU: 0,
      };
    });
    this.legLen = this.legs.reduce((s, l) => s + l.l1 + l.l2, 0) / this.legs.length;
    this.footLen = this.legLen * 0.2;
    this.weight = 0;
    this.active = false;
    this.drop = 0;
    this.last = new THREE.Vector3(); // body position last frame (a jump re-plants the feet)
  }

  /**
   * Run after the animation pose has been written to the bones.
   * ctx: {
   *   mesh, yaw, vel (world, x/z used), speed, phase, gait: { stride, duty },
   *   want: 0..1, ground(x, z, maxY) -> ground height, narrow: feet in line (beams),
   *   onStep(leg, idle): called when a foot lands,
   * }
   */
  update(dt, ctx) {
    const want = ctx.want;
    this.weight += (want - this.weight) * dampFactor(12, dt);
    if (want <= 0 && this.weight < 0.01) { this.weight = 0; this.active = false; this.drop = 0; return; }
    const mesh = ctx.mesh;
    const s = mesh.scale.x;
    const L = this.legLen * s;
    mesh.updateMatrixWorld(true);
    const body = mesh.position;
    if (!this.active || body.distanceTo(this.last) > L * 2) this.plantAll(ctx, s);
    this.last.copy(body);

    // ---------------------------------------------------------------- schedule
    const speed = ctx.speed;
    const moving = speed > 0.3 * (L / LEG);
    const { stride, duty } = ctx.gait;
    const cycle = stride / Math.max(speed, 0.05);
    const run = clamp((speed * (LEG / L) - 1.5) / 3.5, 0, 1);
    const fwdX = moving ? ctx.vel.x / speed : Math.sin(ctx.yaw);
    const fwdZ = moving ? ctx.vel.z / speed : Math.cos(ctx.yaw);
    const legs = this.legs;
    let swinging = 0;
    for (const l of legs) if (!l.planted) swinging++;

    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const u = frac((ctx.phase + l.offset - (Math.PI - Math.PI * duty)) / TAU);
      if (u < duty) l.ready = true; // in its stance window: the next step may start
      if (l.planted) {
        let lift = false, dur = 0.3;
        if (moving && u >= duty && l.ready) {
          // the schedule says this foot is in the air: lift now unless it is about to land
          const left = (1 - u) / (1 - duty);
          if (left > 0.25 || l.prevU < duty) { lift = true; dur = Math.max(0.1, (1 - u) * cycle); l.ready = false; }
        } else if (!moving && swinging === 0) {
          // standing: step the foot back under the body when it is off or twisted
          this.home(l, ctx, s, _v);
          const off = Math.hypot(l.plant.x - _v.x, l.plant.z - _v.z);
          const twist = Math.abs(angleDiff(l.yaw, ctx.yaw));
          if (off > 0.2 * L || twist > 0.75) { lift = true; dur = 0.26 * Math.sqrt(L / LEG); l.idle = true; }
        }
        // stretched past reach (shoved, sharp turn): take a quick step
        if (!lift) {
          l.up.getWorldPosition(_w);
          if (Math.hypot(l.plant.x - _w.x, l.plant.z - _w.z) > 0.92 * L) { lift = true; dur = 0.18 * Math.sqrt(L / LEG); }
        }
        if (lift) {
          l.planted = false;
          l.t = 0;
          l.dur = dur;
          l.from.copy(l.pos);
          l.fromYaw = l.yaw;
          l.fromPitch = l.pitch;
          l.idle = l.idle && !moving;
          swinging++;
        }
      }
      l.prevU = u;

      if (l.planted) {
        l.pos.copy(l.plant);
        // heel lifts as the foot trails behind the body (toe-off)
        const back = -((l.plant.x - body.x) * fwdX + (l.plant.z - body.z) * fwdZ);
        const h = moving ? smoothstep(0.12 * L, 0.5 * L, back) * (0.06 + 0.08 * run) * L : 0;
        l.pos.y += h;
        l.pitch = Math.asin(clamp(h / (this.footLen * s), 0, 0.9));
      } else {
        l.t += dt;
        const w = clamp(l.t / l.dur, 0, 1);
        // the foothold where this step lands
        if (moving && !l.idle) {
          const tTouch = (1 - w) * l.dur;
          // land a little ahead of the hips (centred when walking, less when running)
          const ahead = duty * stride * (0.5 - 0.15 * run);
          this.home(l, ctx, s, _v);
          _v.x += ctx.vel.x * tTouch + fwdX * ahead;
          _v.z += ctx.vel.z * tTouch + fwdZ * ahead;
        } else this.home(l, ctx, s, _v);
        _v.y = this.groundY(ctx, _v.x, _v.z, body.y, s) + l.ankleH * s;
        l.to.copy(_v);
        const e = smoothstep(0, 1, w);
        l.pos.lerpVectors(l.from, l.to, e);
        // lift early (heel kicks up behind), travel forward, then reach down
        const arc = (l.idle ? 0.05 : 0.07 + 0.14 * run) * L * Math.sin(Math.PI * Math.pow(w, 0.75));
        l.pos.y += arc;
        l.yaw = lerpAngle(l.fromYaw, ctx.yaw, e);
        l.pitch = l.fromPitch * (1 - e) - 0.25 * Math.sin(Math.PI * w) * run;
        if (w >= 1) {
          if (ctx.onStep) ctx.onStep(l, l.idle);
          l.planted = true;
          l.idle = false;
          l.plant.copy(l.to);
          l.pos.copy(l.plant);
          l.yaw = ctx.yaw;
          l.pitch = 0;
        }
      }
    }

    // ---------------------------------------------------------------- hips
    // lower the pelvis just enough for every weight-bearing foot to reach
    let need = 0;
    for (const l of legs) {
      const landing = l.planted ? 1 : smoothstep(0.6, 1, l.t / l.dur);
      if (landing <= 0) continue;
      l.up.getWorldPosition(_w);
      const R = (l.l1 + l.l2) * s * 0.985;
      const dx = l.pos.x - _w.x, dz = l.pos.z - _w.z, dy = _w.y - l.pos.y;
      const h2 = dx * dx + dz * dz;
      const reach = h2 < R * R ? Math.sqrt(R * R - h2) : 0;
      need = Math.max(need, (dy - reach) * landing);
    }
    need = clamp(need, 0, 0.3 * L);
    this.drop = need > this.drop ? need : Math.max(need, this.drop - dt * 1.2 * L);
    if (this.drop > 1e-5) {
      this.pelvis.position.y -= (this.drop * this.weight) / s;
      this.pelvis.updateMatrixWorld(true);
    }

    // ---------------------------------------------------------------- legs
    for (const l of legs) this.solve(l, this.weight);
  }

  /** Where a foot rests under the body (world), ground height not set. */
  home(l, ctx, s, out) {
    const c = Math.cos(ctx.yaw), sn = Math.sin(ctx.yaw);
    const hx = l.home.x * s * (ctx.narrow ? 0.25 : 1), hz = l.home.z * s;
    out.set(ctx.mesh.position.x + hx * c + hz * sn, 0, ctx.mesh.position.z - hx * sn + hz * c);
    return out;
  }

  groundY(ctx, x, z, y, s) {
    const g = ctx.ground(x, z, y + 0.7 * s * (this.legLen / LEG));
    // off a ledge or into a wall: keep the foot level with the body
    return g < y - 0.7 * s * (this.legLen / LEG) || g > y + 0.75 * s * (this.legLen / LEG) ? y : g;
  }

  plantAll(ctx, s) {
    for (const l of this.legs) {
      l.end.getWorldPosition(l.plant);
      l.plant.y = this.groundY(ctx, l.plant.x, l.plant.z, ctx.mesh.position.y, s) + l.ankleH * s;
      l.pos.copy(l.plant);
      l.planted = true;
      l.idle = false;
      l.yaw = ctx.yaw;
      l.pitch = 0;
      l.prevU = 1;
      l.ready = true;
    }
    this.active = true;
    this.drop = 0;
  }

  /** Two-bone IK onto the leg's ankle target, then the foot level (or rolled onto the toes), facing its own yaw. */
  solve(l, weight) {
    if (!aimLimb(l, l.pos, l.pole, weight)) return;
    _e.set(l.pitch, l.yaw, 0, 'YXZ');
    orientEnd(l, _qe.setFromEuler(_e), weight);
  }
}

/** Foot planting for the game's humanoid skeleton. */
export function humanoidFeet(model, width = 1) {
  return new FootPlanter(model, {
    pelvis: 'hips',
    width,
    legs: [
      { upper: 'thighL', lower: 'shinL', end: 'footL', offset: 0, pole: [0.12, 0, 1] },
      { upper: 'thighR', lower: 'shinR', end: 'footR', offset: Math.PI, pole: [-0.12, 0, 1] },
    ],
  });
}

/** Foot planting for the hellhound (trot: diagonal pairs together). */
export function houndFeet(model) {
  return new FootPlanter(model, {
    pelvis: 'body',
    legs: [
      { upper: 'flU', lower: 'flL', end: 'flP', offset: 0, pole: [0, 0, 1] },
      { upper: 'frU', lower: 'frL', end: 'frP', offset: Math.PI, pole: [0, 0, 1] },
      { upper: 'blU', lower: 'blL', end: 'blP', offset: Math.PI, pole: [0, 0, -1] },
      { upper: 'brU', lower: 'brL', end: 'brP', offset: 0, pole: [0, 0, -1] },
    ],
  });
}

