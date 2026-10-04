import * as THREE from 'three';
import { RigBuilder, G, mat, limb, ZERO } from './rig.js';
import { lerp, clamp } from '../core/math.js';

// ---------------------------------------------------------------- skeleton
/** Humanoid bone layout; o scales proportions (height ~1.8m at s = 1). */
export function humanoidBones(o = {}) {
  const s = o.scale ?? 1;
  const hipY = (o.hipY ?? 0.97) * s;
  const shY = (o.shoulderY ?? 1.46) * s;
  const shX = (o.shoulderX ?? 0.2) * s;
  const hipX = (o.hipX ?? 0.1) * s;
  const upper = (o.upperArm ?? 0.29) * s;
  const fore = (o.foreArm ?? 0.26) * s;
  const kneeY = (o.kneeY ?? 0.52) * s;
  const ankleY = (o.ankleY ?? 0.09) * s;
  const hunch = o.hunchZ ?? 0;
  const bones = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'hips', parent: 'root', pos: [0, hipY, 0] },
    { name: 'spine', parent: 'hips', pos: [0, hipY + 0.13 * s, 0] },
    { name: 'chest', parent: 'spine', pos: [0, hipY + 0.33 * s, hunch * 0.5] },
    { name: 'neck', parent: 'chest', pos: [0, shY + 0.06 * s, hunch] },
    { name: 'head', parent: 'neck', pos: [0, shY + 0.14 * s, hunch * 1.2] },
    { name: 'armL', parent: 'chest', pos: [shX, shY, hunch * 0.8] },
    { name: 'foreL', parent: 'armL', pos: [shX, shY - upper, hunch * 0.8] },
    { name: 'handL', parent: 'foreL', pos: [shX, shY - upper - fore, hunch * 0.8] },
    { name: 'armR', parent: 'chest', pos: [-shX, shY, hunch * 0.8] },
    { name: 'foreR', parent: 'armR', pos: [-shX, shY - upper, hunch * 0.8] },
    { name: 'handR', parent: 'foreR', pos: [-shX, shY - upper - fore, hunch * 0.8] },
    { name: 'thighL', parent: 'hips', pos: [hipX, hipY - 0.04 * s, 0] },
    { name: 'shinL', parent: 'thighL', pos: [hipX, kneeY, 0] },
    { name: 'footL', parent: 'shinL', pos: [hipX, ankleY, 0] },
    { name: 'thighR', parent: 'hips', pos: [-hipX, hipY - 0.04 * s, 0] },
    { name: 'shinR', parent: 'thighR', pos: [-hipX, kneeY, 0] },
    { name: 'footR', parent: 'shinR', pos: [-hipX, ankleY, 0] },
  ];
  if (o.tails) {
    bones.push(
      { name: 'tail1', parent: 'hips', pos: [0, hipY + 0.02 * s, -0.15 * s] },
      { name: 'tail2', parent: 'tail1', pos: [0, hipY - 0.31 * s, -0.16 * s] },
      { name: 'tail3', parent: 'tail2', pos: [0, hipY - 0.62 * s, -0.17 * s] },
    );
  }
  if (o.tail) {
    // demon tail
    bones.push(
      { name: 'tail1', parent: 'hips', pos: [0, hipY - 0.02 * s, -0.12 * s] },
      { name: 'tail2', parent: 'tail1', pos: [0, hipY - 0.12 * s, -0.42 * s] },
      { name: 'tail3', parent: 'tail2', pos: [0, hipY - 0.2 * s, -0.75 * s] },
    );
  }
  return { bones, dims: { s, hipY, shY, shX, hipX, upper, fore, kneeY, ankleY, hunch } };
}

export const CHAR_MATS = ['charCloth', 'charLeather', 'charMetal', 'charSkin'];

// ---------------------------------------------------------------- assassin
const WHITE = [0.93, 0.91, 0.87];
const RED = [0.62, 0.07, 0.05];
const DARK = [0.2, 0.19, 0.19];
const LEATHER = [0.36, 0.23, 0.15];
const GLOVE = [0.18, 0.13, 0.1];
const STEEL = [0.78, 0.78, 0.8];
const SKIN = [0.42, 0.3, 0.24];

export function buildAssassin(materials) {
  const { bones, dims: d } = humanoidBones({ tails: true });
  const r = new RigBuilder(bones);
  const { hipY, shY, shX, hipX, kneeY } = d;

  // torso
  r.add('chest', G.cyl(0.205, 0.165, 0.36, 12), mat(0, 1.36, 0, 0, 0, 0, 1, 1, 0.68), 'charCloth', WHITE);
  r.add('chest', G.sphere(0.13, 12, 8), mat(0, 1.47, 0.0, 0, 0, 0, 1.45, 0.55, 0.8), 'charCloth', WHITE);
  r.add('chest', G.box(0.05, 0.56, 0.02), mat(0.02, 1.3, 0.122, 0, 0, 0.62), 'charLeather', LEATHER);
  r.add('chest', G.torus(0.1, 0.045, 6, 14), mat(0, 1.5, 0.0, Math.PI / 2, 0, 0, 1, 1.05, 1), 'charCloth', WHITE);
  r.add('spine', G.cyl(0.168, 0.158, 0.22, 12), mat(0, 1.14, 0, 0, 0, 0, 1, 1, 0.7), 'charCloth', WHITE);
  r.add('hips', G.cyl(0.172, 0.17, 0.1, 12), mat(0, 1.03, 0, 0, 0, 0, 1, 1, 0.74), 'charCloth', RED);
  r.add('hips', G.cyl(0.176, 0.176, 0.05, 12), mat(0, 0.975, 0, 0, 0, 0, 1, 1, 0.76), 'charLeather', LEATHER);
  r.add('hips', G.box(0.07, 0.06, 0.02), mat(0, 0.975, 0.13), 'charMetal', [0.75, 0.6, 0.3]);
  r.add('hips', G.cyl(0.165, 0.15, 0.17, 12), mat(0, 0.9, 0, 0, 0, 0, 1, 1, 0.76), 'charCloth', DARK);
  // sash tail hanging on the left hip
  r.add('hips', G.box(0.08, 0.32, 0.015), mat(0.12, 0.86, 0.1, 0.1, 0, 0.12), 'charCloth', RED);

  // head + hood
  r.add('neck', G.cyl(0.05, 0.055, 0.1, 8), mat(0, 1.55, 0), 'charSkin', SKIN);
  r.add('head', G.sphere(0.093, 14, 10), mat(0, 1.665, 0.012, 0, 0, 0, 0.92, 1.12, 0.98), 'charSkin', SKIN);
  const hoodGeo = new THREE.SphereGeometry(0.128, 16, 12, Math.PI / 2 + 0.85, Math.PI * 2 - 1.7, 0, Math.PI * 0.78);
  r.add('head', hoodGeo, mat(0, 1.69, -0.012, 0, 0, 0, 1.02, 1.14, 1.12), 'charCloth', WHITE);
  r.add('head', G.sphere(0.12, 12, 8), mat(0, 1.69, -0.04, 0, 0, 0, 0.96, 1.06, 1.0), 'charCloth', [0.12, 0.11, 0.11]);
  r.add('head', G.cone(0.07, 0.13, 10), mat(0, 1.78, 0.07, 1.95, 0, 0, 1, 1, 0.55), 'charCloth', WHITE);
  // hood drape over the shoulders
  r.add('chest', G.cone(0.2, 0.2, 14), mat(0, 1.53, -0.03, 0, 0, 0, 1, 1, 0.82), 'charCloth', WHITE);

  // arms
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const x = sx * shX;
    r.add('arm' + side, G.sphere(0.078, 10, 8), mat(x, shY - 0.01, 0), 'charCloth', WHITE);
    limb(r, 'arm' + side, [x, shY, 0], [x, shY - d.upper, 0], 0.063, 0.052, 'charCloth', WHITE);
    r.add('fore' + side, G.sphere(0.052, 8, 6), mat(x, shY - d.upper, 0), 'charCloth', WHITE);
    limb(r, 'fore' + side, [x, shY - d.upper, 0], [x, shY - d.upper - d.fore + 0.02, 0], 0.053, 0.043, 'charLeather', LEATHER);
    // bracer straps
    r.add('fore' + side, G.cyl(0.055, 0.055, 0.025, 10), mat(x, shY - d.upper - 0.08, 0), 'charLeather', GLOVE);
    r.add('fore' + side, G.cyl(0.048, 0.048, 0.025, 10), mat(x, shY - d.upper - 0.2, 0), 'charLeather', GLOVE);
    // hand (glove)
    const hy = shY - d.upper - d.fore;
    r.add('hand' + side, G.box(0.06, 0.1, 0.085), mat(x, hy - 0.045, 0.005), 'charLeather', GLOVE);
    r.add('hand' + side, G.box(0.035, 0.05, 0.03), mat(x - sx * 0.02, hy - 0.03, 0.045), 'charLeather', GLOVE);
  }
  // pauldron (left) and hidden blade housing (left forearm)
  r.add('armL', new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(shX + 0.01, shY + 0.0, 0, 0, 0, -0.25, 1.05, 0.9, 1.15), 'charMetal', [0.42, 0.4, 0.38]);
  r.add('foreL', G.box(0.03, 0.16, 0.032), mat(shX - 0.045, shY - d.upper - 0.17, 0), 'charMetal', [0.55, 0.55, 0.58]);

  // legs
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const x = sx * hipX;
    limb(r, 'thigh' + side, [x, hipY - 0.03, 0], [x, kneeY, 0], 0.09, 0.066, 'charCloth', DARK);
    r.add('shin' + side, G.sphere(0.064, 8, 6), mat(x, kneeY, 0.01), 'charCloth', DARK);
    limb(r, 'shin' + side, [x, kneeY, 0], [x, 0.38, 0], 0.062, 0.054, 'charCloth', DARK);
    limb(r, 'shin' + side, [x, 0.4, 0], [x, 0.1, 0], 0.064, 0.056, 'charLeather', LEATHER);
    r.add('shin' + side, G.cyl(0.072, 0.07, 0.05, 10), mat(x, 0.4, 0), 'charLeather', GLOVE);
    r.add('foot' + side, G.box(0.1, 0.085, 0.25), mat(x, 0.045, 0.045), 'charLeather', LEATHER);
    // robe front flaps follow the thighs
    r.add('thigh' + side, G.box(0.12, 0.42, 0.018), mat(x * 0.9, 0.75, 0.1, 0.08, 0, sx * 0.04), 'charCloth', WHITE);
    r.add('thigh' + side, G.box(0.12, 0.04, 0.022), mat(x * 0.9, 0.55, 0.115, 0.08, 0, sx * 0.04), 'charCloth', RED);
  }
  // back coat tails (spring-animated chain)
  // split coat tails (left/right halves with a gap, tapering down)
  for (const sx of [1, -1]) {
    r.add('tail1', G.box(0.16, 0.33, 0.022), mat(sx * 0.085, hipY - 0.15, -0.155, 0, 0, sx * 0.04), 'charCloth', WHITE);
    r.add('tail2', G.box(0.145, 0.31, 0.022), mat(sx * 0.09, hipY - 0.46, -0.165, 0, 0, sx * 0.06), 'charCloth', WHITE);
    r.add('tail3', G.box(0.12, 0.2, 0.022), mat(sx * 0.095, hipY - 0.71, -0.172, 0, 0, sx * 0.08), 'charCloth', WHITE);
    r.add('tail3', G.box(0.12, 0.035, 0.026), mat(sx * 0.1, hipY - 0.8, -0.172, 0, 0, sx * 0.08), 'charCloth', RED);
  }
  // scabbard on the left hip
  r.add('hips', G.box(0.05, 0.05, 0.86), mat(0.21, 0.56, -0.17, -0.96, 0, 0), 'charLeather', [0.25, 0.15, 0.1]);

  const rig = r.build(materials, CHAR_MATS);

  // ---- sword (separate mesh: re-parented between hand and hip)
  const sword = new THREE.Group();
  const sm = new THREE.MeshStandardMaterial({ color: 0xa8acb4, metalness: 0.8, roughness: 0.42, emissive: new THREE.Color(0xff3a10), emissiveIntensity: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.6 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xb08a40, metalness: 0.9, roughness: 0.35 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 0.86), sm);
  blade.position.z = 0.55;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.12, 4), sm);
  tip.rotation.x = Math.PI / 2;
  tip.position.z = 1.04;
  tip.scale.set(1, 1, 0.35);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 8), dark);
  grip.rotation.x = Math.PI / 2;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.03), gold);
  guard.position.z = 0.1;
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), gold);
  pommel.position.z = -0.1;
  sword.add(blade, tip, grip, guard, pommel);
  sword.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  sword.userData.bladeMat = sm;

  // ---- hidden blade (extends during assassinations)
  const hb = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.24, 0.004), new THREE.MeshStandardMaterial({ color: 0xe0e0e8, metalness: 1, roughness: 0.18 }));
  hb.geometry.translate(0, -0.12, 0);
  const hbPivot = new THREE.Group();
  hbPivot.position.set(-0.045, -0.17, 0); // relative to foreL bone (inner forearm)
  hbPivot.add(hb);
  rig.bones.foreL.add(hbPivot);
  hb.scale.y = 0.05;

  return { ...rig, sword, hiddenBlade: hb, dims: d };
}

/** Attach the sword either to the right hand (drawn) or the left hip (sheathed). */
export function placeSword(model, drawn) {
  const { sword, bones } = model;
  if (drawn) {
    bones.handR.add(sword);
    sword.position.set(0, -0.06, 0.01);
    sword.rotation.set(0, 0, 0);
  } else {
    bones.hips.add(sword);
    sword.position.set(0.21, -0.06, 0.07);
    sword.rotation.set(2.18, 0, 0);
  }
}

// ---------------------------------------------------------------- poses
// Pose maps: bone -> [rx, ry, rz]. Root/hips translations are separate.

const sin = Math.sin, cos = Math.cos;

export function idlePose(out, t, k = 1) {
  const b = sin(t * 1.7) * 0.015 * k;
  out.hips = [0, 0, 0];
  out.spine = [0.03 + b, 0, 0];
  out.chest = [0.02 + b, 0, 0];
  out.neck = [0, 0, 0];
  out.head = [-0.03 - b, sin(t * 0.37) * 0.15, 0];
  out.armL = [0.04, 0, 0.11 + b];
  out.armR = [0.04, 0, -0.11 - b];
  out.foreL = [-0.18, 0, 0];
  out.foreR = [-0.18, 0, 0];
  out.handL = [0, 0, 0];
  out.handR = [0, 0, 0];
  out.thighL = [-0.04, 0, 0.04];
  out.thighR = [-0.02, 0, -0.04];
  out.shinL = [0.08, 0, 0];
  out.shinR = [0.05, 0, 0];
  out.footL = [-0.04, 0, -0.04];
  out.footR = [-0.03, 0, 0.04];
  return out;
}

/**
 * Locomotion cycle. ph = phase (rad), run = 0 walk .. 1 run .. 2 sprint.
 * Returns hip bob in out._bob.
 */
export function gaitPose(out, ph, run) {
  const s = sin(ph), c = cos(ph);
  const r1 = clamp(run, 0, 1), r2 = clamp(run - 1, 0, 1);
  const A = lerp(lerp(0.4, 0.72, r1), 0.92, r2);
  const K = lerp(lerp(0.6, 1.25, r1), 1.55, r2);
  const ARM = lerp(lerp(0.32, 0.65, r1), 0.85, r2);
  const lean = lerp(lerp(0.04, 0.14, r1), 0.26, r2);
  const off = lerp(0, 0.12, r1);
  const swingL = Math.max(0, c), swingR = Math.max(0, -c);
  out.hips = [0, s * 0.12 * (0.6 + r1 * 0.4), 0];
  out.spine = [lean * 0.55, -s * 0.06, 0];
  out.chest = [lean * 0.45, -s * 0.12, 0];
  out.neck = [0, 0, 0];
  out.head = [-lean * 0.8, s * 0.05, 0];
  out.thighL = [-s * A - off, 0, 0.02];
  out.thighR = [s * A - off, 0, -0.02];
  out.shinL = [0.08 + K * Math.pow(swingL, 1.4) + r1 * 0.1, 0, 0];
  out.shinR = [0.08 + K * Math.pow(swingR, 1.4) + r1 * 0.1, 0, 0];
  out.footL = [-(out.thighL[0] + out.shinL[0]) * 0.45 + 0.1 * swingL, 0, 0];
  out.footR = [-(out.thighR[0] + out.shinR[0]) * 0.45 + 0.1 * swingR, 0, 0];
  const elbow = lerp(lerp(0.25, 0.95, r1), 1.25, r2);
  out.armL = [s * ARM + r1 * 0.1, 0, 0.1 + r1 * 0.06];
  out.armR = [-s * ARM + r1 * 0.1, 0, -0.1 - r1 * 0.06];
  out.foreL = [-(elbow + 0.35 * Math.max(0, -s)), 0, 0];
  out.foreR = [-(elbow + 0.35 * Math.max(0, s)), 0, 0];
  out.handL = [0, 0, 0];
  out.handR = [0, 0, 0];
  out._bob = -Math.abs(c) * lerp(0.02, 0.055, r1) + lerp(0, -0.04, r2);
  return out;
}

/** Crouched sneaking walk. */
export function sneakPose(out, ph, amount) {
  const s = sin(ph), c = cos(ph);
  const A = 0.38 * amount;
  out.hips = [0, s * 0.08, 0];
  out.spine = [0.32, 0, 0];
  out.chest = [0.18, -s * 0.05, 0];
  out.neck = [0, 0, 0];
  out.head = [-0.38, 0, 0];
  out.thighL = [-0.85 - s * A, 0, 0.12];
  out.thighR = [-0.85 + s * A, 0, -0.12];
  out.shinL = [1.25 + 0.4 * Math.max(0, c) * amount, 0, 0];
  out.shinR = [1.25 + 0.4 * Math.max(0, -c) * amount, 0, 0];
  out.footL = [-0.4, 0, 0];
  out.footR = [-0.4, 0, 0];
  out.armL = [-0.35 + s * 0.2 * amount, 0, 0.2];
  out.armR = [-0.35 - s * 0.2 * amount, 0, -0.2];
  out.foreL = [-0.9, 0, 0];
  out.foreR = [-0.9, 0, 0];
  out._bob = -0.32 - Math.abs(c) * 0.02 * amount;
  return out;
}

/** Witcher-like guard stance with the sword drawn. */
export function combatStance(out, t) {
  const b = sin(t * 2.2) * 0.02;
  out.hips = [0, 0.32, 0];
  out.spine = [0.12, -0.12, 0];
  out.chest = [0.06 + b, -0.14, 0];
  out.neck = [0, 0, 0];
  out.head = [-0.12, -0.05, 0];
  out.armR = [-0.55, 0.1, -0.32];
  out.foreR = [-1.15, 0, 0];
  out.handR = [0.25, 0, 0];
  out.armL = [-0.3, 0, 0.42];
  out.foreL = [-1.25, 0, 0];
  out.handL = [0, 0, 0];
  out.thighL = [-0.48, -0.25, 0.12];
  out.shinL = [0.6, 0, 0];
  out.footL = [-0.12, 0.25, 0];
  out.thighR = [0.18, -0.35, -0.12];
  out.shinR = [0.45, 0, 0];
  out.footR = [-0.3, 0.3, 0];
  out._bob = -0.1;
  return out;
}

/** Climbing on a wall. ph advances with movement; hang = 1 at a ledge top. */
export function climbPose(out, ph, hang, side) {
  const s = sin(ph), c = cos(ph);
  const reach = 1 - hang;
  out.hips = [0, 0, 0];
  out.spine = [0.12 * reach, side * 0.1, 0];
  out.chest = [-0.05, 0, side * 0.05];
  out.neck = [0, 0, 0];
  out.head = [-0.35 * (0.6 + reach * 0.4), 0, 0];
  out.armL = [-2.75 - 0.35 * s * reach, 0, 0.18 + side * 0.15];
  out.armR = [-2.75 + 0.35 * s * reach, 0, -0.18 + side * 0.15];
  out.foreL = [-0.35 - 0.6 * Math.max(0, s) * reach, 0, 0];
  out.foreR = [-0.35 - 0.6 * Math.max(0, -s) * reach, 0, 0];
  out.handL = [0.3, 0, 0];
  out.handR = [0.3, 0, 0];
  const legL = reach * (0.5 + 0.5 * s);
  const legR = reach * (0.5 - 0.5 * s);
  out.thighL = [-0.25 - 0.85 * legR - hang * 0.15, 0, 0.12 + side * 0.1];
  out.thighR = [-0.25 - 0.85 * legL - hang * 0.25, 0, -0.12 + side * 0.1];
  out.shinL = [0.35 + 1.0 * legR + hang * 0.25, 0, 0];
  out.shinR = [0.35 + 1.0 * legL + hang * 0.45, 0, 0];
  out.footL = [0.25, 0, 0];
  out.footR = [0.25, 0, 0];
  out._bob = 0;
  void c;
  return out;
}

export function airPose(out, vy, t) {
  const up = clamp(vy / 6, -1, 1);
  const f = sin(t * 9) * 0.12 * Math.max(0, -up);
  out.hips = [0, 0, 0];
  out.spine = [0.1 + 0.1 * up, 0, 0];
  out.chest = [0.05, 0, 0];
  out.neck = [0, 0, 0];
  out.head = [-0.1, 0, 0];
  out.armL = [-0.6 - 0.5 * up + f, 0, 0.55 + 0.4 * Math.max(0, -up)];
  out.armR = [-0.3 - 0.3 * up - f, 0, -0.55 - 0.4 * Math.max(0, -up)];
  out.foreL = [-0.7, 0, 0];
  out.foreR = [-0.7, 0, 0];
  out.handL = [0, 0, 0];
  out.handR = [0, 0, 0];
  out.thighL = [-0.95 * Math.max(0.2, up + 0.3), 0, 0.08];
  out.thighR = [-0.2 - 0.25 * Math.max(0, up), 0, -0.08];
  out.shinL = [1.2 * Math.max(0.3, up + 0.4), 0, 0];
  out.shinR = [0.45, 0, 0];
  out.footL = [0.2, 0, 0];
  out.footR = [0.1, 0, 0];
  out._bob = 0;
  return out;
}

export function deadPose(out) {
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = [0, 0, 0];
  out.spine = [0.2, 0, 0];
  out.head = [0.3, 0.6, 0];
  out.armL = [-0.6, 0, 1.2];
  out.armR = [0.4, 0, -1.4];
  out.foreL = [-0.4, 0, 0];
  out.foreR = [-0.6, 0, 0];
  out.thighL = [-0.4, 0, 0.2];
  out.shinL = [0.8, 0, 0];
  out.thighR = [-0.1, 0, -0.1];
  out.shinR = [0.3, 0, 0];
  return out;
}

export { ZERO };
