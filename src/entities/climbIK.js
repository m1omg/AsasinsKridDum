import * as THREE from 'three';
import { clamp, damp, dampFactor } from '../core/math.js';
import { limbChain, aimLimb, orientEnd } from './footIK.js';

// Hands and feet on the wall while climbing.
//
// Each hand and foot rests on a hold on the real surface of the wall: the plaster, or a
// window frame, pane, shutter, sill, cornice or ledge (the city's relief map), and a hand
// grips the top edge of a ledge when one is near. Holds stay put while the body moves; in
// turn (diagonal pairs together) a limb lets go and reaches for the next hold ahead, so the
// hands go over each other at the pace the body climbs, and every limb reaches for where
// the body will be after a leap. Two-bone IK puts the limbs on their holds. The body hugs
// the wall a little closer than the climbing contact, and is held out from it by whatever
// stands out behind the knees, hips, chest and head. Purely visual: climbing is unchanged.

const CYCLE = 0.95; // body travel (m) per cycle of the hands: each moves once
const CYCLE_F = 0.8; // and of the feet (shorter steps: knees splay less)
const SWING = 0.4; // share of a cycle a limb is in the air
const HUG = 0.09; // the body sits this much nearer the wall than the climbing contact
const PALM = 0.08; // wrist joint to palm
const GRIP = 0.11; // wrist below the top edge a hand grips
const EDGE = 0.03; // and that much further out (the hand tips in over the edge)
const CURL = 0.25; // how far (rad)
const TOE = 0.19; // ankle joint to the toes
const SOLE = 0.1; // ankle joint to the sole
const OUT = 0.7; // surface probes start this far out from the wall plane...
const BEHIND = 0.3; // ...and look this far behind it (recesses)

const HAND = { s: 0.22, y: 1.62, lead: 0.28, yMin: 1.25, yMax: 1.9, sMax: 0.42 };
const REACH = 1.95; // highest a hand grips an edge (wrist, above the feet)
const FOOT = { s: 0.15, y: 0.27, lead: 0.24, yMin: 0.04, yMax: 0.55, sMax: 0.35 };

// the left hand moves with the right foot, the right hand with the left foot
const LIMBS = [
  { chain: ['armL', 'foreL', 'handL'], hand: true, side: -1, phase: 0, rest: [0, 0, -1] },
  { chain: ['armR', 'foreR', 'handR'], hand: true, side: 1, phase: 0.5, rest: [0, 0, -1] },
  { chain: ['thighL', 'shinL', 'footL'], hand: false, side: -1, phase: 0.58, rest: [0.12, 0, 1] },
  { chain: ['thighR', 'shinR', 'footR'], hand: false, side: 1, phase: 0.08, rest: [-0.12, 0, 1] },
];

// how near the body comes to the wall plane (before any push out), by height above the feet:
// [from, to, clearance] (measured climbing a bare wall, less a margin: shins and knees, thighs and
// hips, belly, chest, shoulders and upper arms, head); and its half width (knees and elbows included)
const BODY = [[0.25, 0.65, 0.1], [0.65, 0.95, 0.105], [0.95, 1.2, 0.1], [1.2, 1.38, 0.095], [1.38, 1.62, 0.065], [1.62, 1.85, 0.11]];
const BODY_W = 0.3;

const UP = new THREE.Vector3(0, 1, 0);
const _o = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _hit = {};
const visible = (c) => c.kind !== 'bounds';
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const WAIST = 1.2; // bands below this are the lower body (legs, hips, belly), the rest the upper body

/** Least clearance of the lower or upper body between heights h0 and h1 above the feet (Infinity if none of it is there). */
function clearance(h0, h1, upper) {
  let c = Infinity;
  for (const [a, b, k] of BODY) if (a >= WAIST === upper && h1 > a && h0 < b && k < c) c = k;
  return c;
}

export class ClimbRig {
  /** model: { bones, rest }; world: { col: CollisionWorld, relief: ReliefMap | null } */
  constructor(model, world) {
    this.world = world;
    this.limbs = LIMBS.map((d) => ({
      ...d,
      ik: limbChain(model, d.chain[0], d.chain[1], d.chain[2], d.rest),
      pos: new THREE.Vector3(), // IK target: wrist or ankle (world)
      hold: new THREE.Vector3(), // where it rests
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      y: 0, // height of the hold's contact: wrist, or sole
      grip: 'face', toGrip: 'face', fromGrip: 'face',
      has: true, toHas: true,
      swinging: false, t: 0, dur: 0.2, cycle: 0,
      fixed: false, // swinging to a hold chosen up front (grabbing the wall), not re-aimed on the way
      strainAt: -1, // how far the body had travelled when it last stepped back into reach
      w: 1,
    }));
    this._test = (x0, y0, z0, x1, y1, z1) => this.testBox(x0, y0, z0, x1, y1, z1);
    this._span = (x0, y0, z0, x1, y1, z1) => this.spanBox(x0, y0, z0, x1, y1, z1);
    this.weight = 0;
    this.active = false;
    this.wanted = false;
    this.top = null; // ledge top while hanging from it
    this.needLo = 0; // how far the lower and upper body must stand out
    this.needHi = 0;
    this.phase = 0;
    this.off = 0; // mesh offset out from the wall (m)
    this.push = 0;
    this.vs = 0; // body velocity along the wall (right) and up, smoothed
    this.vy = 0;
    this.travel = 0; // distance travelled along the wall
    this.lean = 0; // upper body tipped toward the wall (rad)
    this.spine = model.bones.spine;
    this.leap = false;
    this.n = new THREE.Vector3(0, 0, 1);
    this.r = new THREE.Vector3(1, 0, 0);
    this.lastN = new THREE.Vector3(0, 0, 1);
    this.base = new THREE.Vector3();
    this.last = new THREE.Vector3();
    this.climbOff = 0.37;
  }

  /**
   * After the animation pose and the foot IK. ctx: { mesh, player, want (1 while climbing),
   * climbOff (body centre to the wall while climbing) }. Moves the mesh off the wall.
   */
  update(dt, ctx) {
    const p = ctx.player, mesh = ctx.mesh;
    const want = ctx.want;
    this.weight += (want - this.weight) * dampFactor(want > 0 ? 30 : 20, dt);
    const n = this.n.set(p.wall.nx, 0, p.wall.nz);
    if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
    n.normalize();
    if (want <= 0 && this.weight < 0.01) {
      this.weight = 0;
      this.active = false;
      this.wanted = false;
      this.lean = 0;
      this.off = Math.abs(this.off) < 1e-4 ? 0 : damp(this.off, 0, 10, dt);
      if (this.off) { mesh.position.addScaledVector(n, this.off); mesh.updateMatrixWorld(true); }
      return;
    }
    this.climbOff = ctx.climbOff;
    const base = this.base.copy(mesh.position);
    this.r.set(n.z, 0, -n.x);
    const w = p.wall;
    const hanging = want > 0 && w.hanging && w.top !== null;
    this.top = hanging ? w.top : null;
    const leaping = want > 0 && (p.climbBoost > 1e-3 || p.climbSideT > 0);

    if (!this.active || (want > 0 && !this.wanted)) {
      // on the wall (again: the old holds are stale even while the last climb still blends out)
      this.start(base);
      if (leaping) this.reach(p); // caught the wall on a run-up: reach for the top of it
    } else if (want > 0) {
      // motion along the wall since the last frame
      const dx = base.x - this.last.x, dy = base.y - this.last.y, dz = base.z - this.last.z;
      const ds = dx * this.r.x + dz * this.r.z;
      if (dx * dx + dy * dy + dz * dz > 1 || n.dot(this.lastN) < 0.95) this.replant();
      else {
        if (dt > 1e-5) {
          const k = dampFactor(14, dt);
          this.vs += (ds / dt - this.vs) * k;
          this.vy += (dy / dt - this.vy) * k;
        }
        if (leaping && !this.leap) this.reach(p);
        else if (!leaping) this.step(Math.hypot(ds, dy));
      }
    }
    if (this.leap && !leaping) this.sync();
    this.leap = leaping;
    this.wanted = want > 0;
    this.last.copy(base);
    this.lastN.copy(n);

    // swings in flight and holds
    for (const L of this.limbs) {
      if (L.swinging && want > 0) {
        L.t += dt;
        if (!L.fixed) this.target(L, p);
        const u = clamp(L.t / L.dur, 0, 1);
        this.swingPos(L, u);
        L.w += ((L.toHas ? 1 : 0) - L.w) * dampFactor(14, dt);
        if (u >= 1) {
          L.swinging = false;
          L.hold.copy(L.to);
          L.grip = L.toGrip;
          L.has = L.toHas;
        }
      } else if (!L.swinging) {
        L.pos.copy(L.hold);
        L.w += ((L.has ? 1 : 0) - L.w) * dampFactor(14, dt);
      }
    }

    // the body: close to the wall, clear of what stands out of it
    // (something deep behind the hips only, the rose window's tracery say: the upper body leans in over it)
    if (want > 0) {
      const need = this.bodyPush(base);
      this.push = damp(this.push, need, need > this.push ? 20 : 7, dt);
      this.off = damp(this.off, -HUG + this.push, 14, dt);
      this.lean = damp(this.lean, Math.atan2(Math.max(0, this.needLo - this.needHi), 0.55), 10, dt);
    } else {
      this.off = damp(this.off, 0, 12, dt);
      this.lean = damp(this.lean, 0, 20, dt);
    }
    mesh.position.addScaledVector(n, this.off);
    if (this.lean > 1e-3) this.spine.rotation.x += this.lean * Math.min(1, this.weight);
    mesh.updateMatrixWorld(true);

    // limbs onto their holds
    const yaw = Math.atan2(-n.x, -n.z);
    for (const L of this.limbs) {
      const wt = this.weight * L.w;
      if (wt < 0.002) continue;
      const out = _c.copy(this.r).multiplyScalar(L.side);
      if (L.hand) {
        // elbows down and out reaching up, back and out pushing on a hold at the chest
        L.ik.up.getWorldPosition(_a);
        const high = clamp((L.pos.y - _a.y + 0.1) / 0.4, 0, 1);
        _pole.copy(out).multiplyScalar(0.5).addScaledVector(n, 0.35 + 0.5 * (1 - high)).addScaledVector(UP, -0.75 * high);
      } else _pole.copy(out).multiplyScalar(0.7).addScaledVector(n, 0.05).addScaledVector(UP, 0.1); // knees out (forward would be into the wall)
      _pole.normalize();
      L.ik.up.parent.getWorldQuaternion(_qp).invert();
      _pole.applyQuaternion(_qp);
      aimLimb(L.ik, L.pos, _pole, wt);
      const sw = L.swinging ? Math.sin(clamp(L.t / L.dur, 0, 1) * Math.PI) : 0;
      if (L.hand) {
        // palm to the wall, fingers up, curled over an edge it grips
        const u = L.swinging ? clamp(L.t / L.dur, 0, 1) : 1;
        const cf = L.swinging ? (L.fromGrip === 'edge' ? CURL : 0) : 0;
        const ct = (L.swinging ? L.toGrip : L.grip) === 'edge' ? CURL : 0;
        const curl = cf + (ct - cf) * u - sw * 0.25;
        this.handQuat(L.side, curl, _q);
      } else {
        _e.set((L.grip === 'ledge' && !L.swinging ? 0 : 0.12) + sw * 0.35, yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
      }
      orientEnd(L.ik, _q, wt);
    }
  }

  /** World orientation of a hand: palm toward the wall, fingers up, tipped over toward the wall by `curl`. */
  handQuat(side, curl, out) {
    const n = this.n, c = Math.cos(curl), s = Math.sin(curl);
    const U = _a.copy(UP).multiplyScalar(c).addScaledVector(n, -s); // fingers
    const F = _b.copy(n).multiplyScalar(-c).addScaledVector(UP, -s); // palm normal
    // rest pose: fingers along -Y, palm toward the body's middle (-X for the left hand, +X for the right)
    const X = _o.copy(F).multiplyScalar(side < 0 ? -1 : 1);
    const Y = U.negate();
    const Z = _c.crossVectors(X, Y);
    _m.makeBasis(X, Y, Z);
    return out.setFromRotationMatrix(_m);
  }

  // ------------------------------------------------------------------ planting

  /**
   * First frame on the wall: every limb goes from where the animation has it (kept in front of
   * the wall) onto a hold, staggered as if mid-climb.
   */
  start(base) {
    this.active = true;
    this.weight = 1;
    this.phase = 0;
    this.vs = 0;
    this.vy = 0;
    this.push = 0;
    this.lean = 0;
    this.leap = false;
    this.last.copy(base);
    this.lastN.copy(this.n);
    const n = this.n;
    for (const L of this.limbs) {
      const H = L.hand ? HAND : FOOT;
      const u = (L.phase % 1) / (1 - SWING); // how far through its stance
      const lead = H.lead * (1 - 2 * clamp(u, 0, 1));
      const y = this.top !== null && L.hand ? this.top - GRIP : base.y + H.y + lead;
      this.place(L, L.side * H.s, y, L.hold);
      L.grip = L.toGrip;
      L.has = L.toHas;
      L.w = L.has ? 1 : 0;
      L.ik.end.getWorldPosition(L.pos);
      const out = (L.hold.x - L.pos.x) * n.x + (L.hold.z - L.pos.z) * n.z;
      if (out > 0) L.pos.addScaledVector(n, out);
      L.swinging = false;
      this.lift(L, L.hand ? 0.12 : 0.16);
      L.to.copy(L.hold);
      L.toGrip = L.grip;
      L.fixed = true;
    }
    this.sync();
  }

  /** Cycle counters to the phase (no limb lets go because of the jump in the count). */
  sync() {
    for (const L of this.limbs) L.cycle = Math.floor(this.phase * (L.hand ? 1 : CYCLE / CYCLE_F) + L.phase);
  }

  lift(L, dur) {
    L.from.copy(L.pos);
    L.fromGrip = L.swinging ? L.toGrip : L.grip;
    L.swinging = true;
    L.fixed = false;
    L.t = 0;
    L.dur = dur;
  }

  /** The body moved `dist` along the wall: limbs let go in turn, or step back into reach. */
  step(dist) {
    this.phase += dist / CYCLE;
    const speed = Math.hypot(this.vs, this.vy);
    let swinging = false;
    for (const L of this.limbs) {
      const cyc = L.hand ? CYCLE : CYCLE_F;
      const c = Math.floor(this.phase * (CYCLE / cyc) + L.phase);
      if (c !== L.cycle) {
        L.cycle = c;
        if (!L.swinging && dist > 0) this.lift(L, clamp((SWING * cyc) / Math.max(speed, 0.6), 0.12, 0.32));
      }
      if (L.swinging) swinging = true;
    }
    // out of reach (the body turned back, stood off the wall, or stopped short of a ledge): the
    // worst one steps, at once when well out, else one at a time once the body is (nearly) still;
    // either not again before the body has moved on a little
    this.travel += dist;
    let worst = null, wd = 0;
    for (const L of this.limbs) {
      if (L.swinging) continue;
      const d = this.strain(L);
      if (d <= 0 || d <= wd) continue;
      const moved = this.travel - L.strainAt;
      if (d > 0.1 ? moved > 0.15 : !swinging && speed < 0.3 && moved > 0.05) { wd = d; worst = L; }
    }
    if (worst) {
      worst.strainAt = this.travel;
      this.lift(worst, 0.22);
    }
  }

  /** How far (m) a resting limb is outside where it can comfortably rest (0 = fine). */
  strain(L) {
    const H = L.hand ? HAND : FOOT;
    const b = this.base;
    const s = (L.hold.x - b.x) * this.r.x + (L.hold.z - b.z) * this.r.z;
    const y = L.y - b.y;
    let d = Math.max(0, Math.abs(s - L.side * H.s) - (H.sMax - 0.1));
    // beyond the limb's length from its shoulder or hip
    L.ik.up.getWorldPosition(_a);
    d = Math.max(d, _a.distanceTo(L.hold) - (L.ik.l1 + L.ik.l2) * 1.02);
    if (L.hand && this.top !== null) return Math.max(d, Math.abs(L.y + GRIP - this.top) - 0.21); // on the ledge
    return Math.max(d, H.yMin - y, y - (L.grip === 'edge' ? REACH : H.yMax));
  }

  /** Climb leap up or sideways: every limb lets go and reaches for where the body lands. */
  reach(p) {
    const t = p.climbBoost > 1e-3 ? p.climbBoost / Math.max(p.climbBoostV, 1) : Math.max(p.climbSideT, 0.05);
    for (const L of this.limbs) this.lift(L, t + (L.hand ? 0.06 : 0.14));
  }

  /** The wall moved under the limbs (a corner, a jump): all of them find new holds. */
  replant() {
    for (const L of this.limbs) this.lift(L, L.hand ? 0.16 : 0.2);
    this.vs = 0;
    this.vy = 0;
  }

  /** Where a swinging limb lands: ahead of where the body will be by then. */
  target(L, p) {
    const H = L.hand ? HAND : FOOT;
    const left = Math.max(0, L.dur - L.t);
    let bs, by, ls = 0, ly = 0;
    if (this.leap) {
      // the end of the leap
      bs = p.climbSideT > 0 ? p.climbSide * 6.2 * p.climbSideT : 0;
      by = p.climbBoost > 1e-3 ? p.climbBoost : 0;
    } else {
      bs = this.vs * left;
      by = this.vy * left;
      const speed = Math.hypot(this.vs, this.vy);
      if (speed > 0.05) {
        const k = clamp(speed / 0.8, 0, 1) * H.lead / speed;
        ls = this.vs * k;
        ly = this.vy * k;
      }
    }
    const s = bs + clamp(L.side * H.s + ls, L.side * H.s - H.sMax, L.side * H.s + H.sMax);
    let y;
    if (L.hand && this.top !== null) y = this.top - GRIP;
    else y = this.base.y + by + clamp(H.y + ly, H.yMin, H.yMax);
    this.place(L, s, y, L.to);
  }

  /**
   * A limb in the air, u through its swing: off the wall, past whatever stands out between
   * its old and new holds, and onto the new one.
   */
  swingPos(L, u) {
    const b = this.base, n = this.n, r = this.r, off = this.climbOff;
    const s0 = (L.from.x - b.x) * r.x + (L.from.z - b.z) * r.z, d0 = (L.from.x - b.x) * n.x + (L.from.z - b.z) * n.z + off;
    const s1 = (L.to.x - b.x) * r.x + (L.to.z - b.z) * r.z, d1 = (L.to.x - b.x) * n.x + (L.to.z - b.z) * n.z + off;
    const e = smooth((u - 0.15) / 0.7);
    const y = L.from.y + (L.to.y - L.from.y) * e;
    const s = s0 + (s1 - s0) * e;
    const d = d0 + (d1 - d0) * smooth(u);
    // how far out to pass: the relief between the two holds, plus the hand (palm) or foot (toes) in front of the joint
    const lo = Math.min(L.from.y, L.to.y), hi = Math.max(L.from.y, L.to.y);
    const clear = this.reliefOut(Math.min(s0, s1) - 0.1, Math.max(s0, s1) + 0.1, lo - (L.hand ? 0.05 : 0.12), hi + (L.hand ? 0.2 : 0.05));
    const out = Math.max(d0, d1, clear + (L.hand ? PALM : TOE) + 0.03) + 0.03;
    const k = smooth(u / 0.25) * (1 - smooth((u - 0.75) / 0.25));
    this.point(s, y, d + Math.max(0, out - d) * k, L.pos);
  }

  /** The most anything stands out of the wall (m) over s0..s1 along it and heights y0..y1. */
  reliefOut(s0, s1, y0, y1) {
    this._s0 = s0; this._s1 = s1; this._y0 = y0; this._y1 = y1; this._out = 0;
    const b = this.base, R = 1.3;
    this.world.relief?.each(b.x - R, b.z - R, b.x + R, b.z + R, this._span);
    for (const c of this.world.col.query(b.x - R, b.z - R, b.x + R, b.z + R)) {
      if (!c.shape && !c.slope && visible(c)) this.spanBox(c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ);
    }
    return this._out;
  }

  spanBox(x0, y0, z0, x1, y1, z1) {
    if (y1 < this._y0 || y0 > this._y1) return;
    const b = this.base, n = this.n, r = this.r;
    let sLo = Infinity, sHi = -Infinity, d = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = k & 1 ? x1 : x0, z = k & 2 ? z1 : z0;
      const s = (x - b.x) * r.x + (z - b.z) * r.z;
      const o = (x - b.x) * n.x + (z - b.z) * n.z;
      if (s < sLo) sLo = s;
      if (s > sHi) sHi = s;
      if (o > d) d = o;
    }
    d += this.climbOff;
    if (sHi < this._s0 || sLo > this._s1 || d > 0.6) return;
    if (d > this._out) this._out = d;
  }

  // ------------------------------------------------------------------ the surface

  /** How far the body must stand out to clear what sticks out of the wall behind it (and just ahead of it). */
  bodyPush(base) {
    const ahead = (this._ahead = this.vy * 0.12);
    this._yLo = base.y + BODY[0][0] + Math.min(0, ahead);
    this._yHi = base.y + BODY[BODY.length - 1][1] + Math.max(0, ahead);
    this._lo = 0;
    this._hi = 0;
    const x0 = base.x - 1, z0 = base.z - 1, x1 = base.x + 1, z1 = base.z + 1;
    this.world.relief?.each(x0, z0, x1, z1, this._test);
    for (const c of this.world.col.query(x0, z0, x1, z1)) {
      if (!c.shape && !c.slope && visible(c)) this.testBox(c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ);
    }
    this.needLo = Math.min(this._lo, 0.45);
    this.needHi = Math.min(this._hi, 0.45);
    return Math.max(this.needLo, this.needHi);
  }

  testBox(x0, y0, z0, x1, y1, z1) {
    if (y1 < this._yLo || y0 > this._yHi) return;
    const b = this.base, n = this.n, r = this.r;
    let sLo = Infinity, sHi = -Infinity, d = -Infinity;
    for (let k = 0; k < 4; k++) {
      const x = k & 1 ? x1 : x0, z = k & 2 ? z1 : z0;
      const s = (x - b.x) * r.x + (z - b.z) * r.z;
      const o = (x - b.x) * n.x + (z - b.z) * n.z;
      if (s < sLo) sLo = s;
      if (s > sHi) sHi = s;
      if (o > d) d = o;
    }
    d += this.climbOff; // out from the wall plane
    if (sHi < -BODY_W || sLo > BODY_W || d <= 0 || d > 0.6) return; // beside the body, flush, or not a decoration
    // now, and where the body will be a moment from now
    const h0 = y0 - b.y, h1 = y1 - b.y, a = this._ahead;
    const lo = d - Math.min(clearance(h0, h1, false), clearance(h0 - a, h1 - a, false));
    const hi = d - Math.min(clearance(h0, h1, true), clearance(h0 - a, h1 - a, true));
    if (lo > this._lo) this._lo = lo;
    if (hi > this._hi) this._hi = hi;
  }

  /** A hold for limb L near (s along the wall, height y of the wrist / sole): sets L.to-grip fields. */
  place(L, s, y, out) {
    let d = null, grip = 'face';
    if (L.hand) {
      // an edge near where the hand goes (one just below it too: the forearm would hang through it);
      // reaching up, the top of the wall anywhere in reach
      let hi = y + GRIP + 0.2;
      if (y - this.base.y >= HAND.y - 0.05 && this.vy > -0.1) hi = Math.max(hi, this.base.y + REACH + GRIP);
      const e = this.ledge(s, y - 0.25, hi, 0.06);
      if (e) {
        // palm on the ledge's front, fingers over its top (tipped in, so the wrist sits out a little more)
        y = e.top - GRIP;
        d = Math.max(e.front, this.surface(s, y - 0.02, e.top - 0.01, 0.05) ?? 0) + EDGE;
        grip = 'edge';
      } else {
        for (const dy of [0, -0.25, 0.25, -0.5]) {
          d = this.surface(s, y + dy - 0.02, y + dy + 0.19, 0.05); // the whole hand
          if (d !== null) { y += dy; break; }
        }
      }
      L.toHas = true;
      this.point(s, y, clamp(d ?? 0, -0.05, 0.45) + PALM, out);
    } else {
      // a ledge to stand on: mostly above the foot climbing up, below it climbing down, never too high to step on
      const up = this.vy > -0.1;
      const e = this.ledge(s, y - (up ? 0.15 : 0.3), Math.min(y + (up ? 0.3 : 0.05), this.base.y + FOOT.yMax + 0.05), 0.06);
      if (e) {
        y = e.top;
        d = this.surface(s, y + 0.01, y + 0.12, 0.07) ?? e.front - 0.12; // toes against the face above it
        grip = 'ledge';
      } else {
        for (const dy of [0, 0.2, -0.2]) {
          d = this.surface(s, y + dy, y + dy + 0.12, 0.07); // the whole foot
          if (d !== null) { y += dy; break; }
        }
      }
      L.toHas = d !== null;
      // the shin clear of what stands out just above the foot
      const shin = this.reliefOut(s - 0.07, s + 0.07, y + 0.13, y + 0.45) + 0.07 - TOE;
      this.point(s, y + SOLE + (grip === 'ledge' ? 0.015 : 0), clamp(Math.max(d ?? 0, shin), -0.05, 0.45) + TOE, out);
    }
    L.toGrip = grip;
    L.y = y;
    return out;
  }

  /**
   * How far the surface stands out of the wall plane over a patch (s +- hw along it, heights
   * y0..y1), the most of it: null where there is nothing there (an opening).
   */
  surface(s, y0, y1, hw) {
    const d = this.depth(s, (y0 + y1) / 2);
    const boxes = this.reliefOut(s - hw, s + hw, y0, y1);
    if (d === null && boxes <= 0) return null;
    return Math.max(d ?? 0, boxes);
  }

  /** World point at s along the wall (right of the body), height y, depth d out from the wall plane. */
  point(s, y, d, out) {
    const n = this.n, r = this.r, b = this.base, k = d - this.climbOff;
    return out.set(b.x + r.x * s + n.x * k, y, b.z + r.z * s + n.z * k);
  }

  /** How far the surface stands out from the wall plane at (s, y): null where there is none. */
  depth(s, y) {
    const n = this.n;
    const o = this.point(s, y, OUT, _o);
    let t = OUT + BEHIND, found = false;
    const h = this.world.col.raycast(o.x, o.y, o.z, -n.x, 0, -n.z, t, visible, _hit);
    if (h && h.t > 1e-4) { t = h.t; found = true; }
    const rel = this.world.relief;
    if (rel && rel.raycast(o.x, o.y, o.z, -n.x, 0, -n.z, t, _hit)) { t = _hit.t; found = true; }
    return found ? OUT - t : null;
  }

  /**
   * The highest top edge between yLo and yHi just in front of the wall, or just behind its
   * face (the top of the wall), that stands out at least `minOut` from the face above it:
   * { top, front (its depth) } or null.
   */
  ledge(s, yLo, yHi, minOut) {
    let top = null;
    const col = this.world.col, rel = this.world.relief;
    for (const d of [0.04, -0.04]) {
      const o = this.point(s, yHi, d, _o);
      const h = col.raycast(o.x, o.y, o.z, 0, -1, 0, yHi - yLo, visible, _hit);
      if (h && h.t > 1e-4 && h.ny > 0.5 && (top === null || h.y > top)) top = h.y;
      if (rel && rel.raycast(o.x, o.y, o.z, 0, -1, 0, yHi - yLo, _hit) && _hit.ny > 0.5 && (top === null || _hit.y > top)) top = _hit.y;
    }
    if (top === null) return null;
    const front = this.depth(s, top - 0.03);
    if (front === null) return null;
    const above = this.depth(s, top + 0.08);
    if (above !== null && front - above < minOut) return null;
    return { top, front };
  }
}
