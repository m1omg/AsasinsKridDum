import * as THREE from 'three';
import { RigBuilder, G, mat, limb } from './rig.js';
import { humanoidBones } from './humanoid.js';

// Procedural demon models. Humanoid demons share the humanoid skeleton (so
// they reuse its pose conventions); hounds and gazers have their own rigs.

const MATS = ['demon', 'charCloth', 'charMetal', 'charLeather', 'demonGlow'];
const BONE = [0.86, 0.8, 0.68];

function glowEyes(r, bone, y, z, x, color, size = 0.025) {
  r.add(bone, G.sphere(size, 6, 4), mat(x, y, z, 0, 0, 0, 1.3, 0.8, 0.6), 'demonGlow', color);
  r.add(bone, G.sphere(size, 6, 4), mat(-x, y, z, 0, 0, 0, 1.3, 0.8, 0.6), 'demonGlow', color);
}

function horn(r, bone, base, dir, len, rad, color = BONE) {
  const geo = new THREE.ConeGeometry(rad, len, 6);
  geo.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir).normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...base), q, new THREE.Vector3(1, 1, 1));
  r.add(bone, geo, m, 'demon', color);
}

// ------------------------------------------------------------- thrall
export function buildThrall(materials) {
  const { bones, dims: d } = humanoidBones({ hunchZ: 0.1, hipY: 0.93, shoulderY: 1.4 });
  const r = new RigBuilder(bones);
  const skin = [0.62, 0.62, 0.55];
  const rag = [0.32, 0.26, 0.2];
  const pants = [0.22, 0.2, 0.18];
  const glow = [1.6, 0.55, 0.12];
  const hz = d.hunch;
  r.add('chest', G.cyl(0.19, 0.16, 0.36, 10), mat(0, 1.3, hz * 0.5, 0.2, 0, 0, 1, 1, 0.72), 'charCloth', rag);
  r.add('chest', G.box(0.05, 0.22, 0.02), mat(0.06, 1.3, 0.14 + hz * 0.5, 0.2, 0, 0.3), 'demonGlow', glow);
  r.add('spine', G.cyl(0.16, 0.15, 0.22, 10), mat(0, 1.1, 0.02, 0, 0, 0, 1, 1, 0.72), 'charCloth', rag);
  r.add('hips', G.cyl(0.16, 0.15, 0.2, 10), mat(0, 0.88, 0, 0, 0, 0, 1, 1, 0.75), 'charCloth', pants);
  r.add('neck', G.cyl(0.045, 0.05, 0.12, 8), mat(0, 1.47, hz), 'demon', skin);
  r.add('head', G.sphere(0.1, 12, 8), mat(0, 1.6, hz * 1.2 + 0.01, 0, 0, 0, 0.9, 1.1, 1.0), 'demon', skin);
  r.add('head', G.box(0.12, 0.05, 0.08), mat(0, 1.52, hz * 1.2 + 0.06), 'demon', [0.4, 0.38, 0.35]);
  glowEyes(r, 'head', 1.62, hz * 1.2 + 0.085, 0.035, [2, 0.8, 0.15]);
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1, x = sx * d.shX, y = d.shY, z = hz * 0.8;
    limb(r, 'arm' + side, [x, y, z], [x, y - d.upper, z], 0.058, 0.045, 'charCloth', rag);
    limb(r, 'fore' + side, [x, y - d.upper, z], [x, y - d.upper - d.fore, z], 0.045, 0.035, 'demon', skin);
    r.add('hand' + side, G.box(0.06, 0.12, 0.07), mat(x, y - d.upper - d.fore - 0.05, z + 0.01), 'demon', skin);
    const hx = sx * d.hipX;
    limb(r, 'thigh' + side, [hx, d.hipY - 0.03, 0], [hx, d.kneeY, 0], 0.08, 0.06, 'charCloth', pants);
    limb(r, 'shin' + side, [hx, d.kneeY, 0], [hx, 0.1, 0], 0.058, 0.045, 'charCloth', pants);
    r.add('foot' + side, G.box(0.09, 0.07, 0.22), mat(hx, 0.04, 0.04), 'demon', [0.3, 0.28, 0.25]);
  }
  return r.build(materials, MATS);
}

// ------------------------------------------------------------- imp
export function buildImp(materials) {
  const { bones, dims: d } = humanoidBones({ hipY: 0.9, shoulderY: 1.36, shoulderX: 0.19, upperArm: 0.3, foreArm: 0.31, hunchZ: 0.06, tail: true });
  const r = new RigBuilder(bones);
  const skin = [0.78, 0.42, 0.3];
  const dark = [0.4, 0.2, 0.14];
  const hz = d.hunch;
  r.add('chest', G.cyl(0.18, 0.13, 0.36, 10), mat(0, 1.27, hz * 0.5, 0.1, 0, 0, 1, 1, 0.72), 'demon', skin);
  r.add('spine', G.cyl(0.13, 0.12, 0.22, 10), mat(0, 1.07, 0.01, 0, 0, 0, 1, 1, 0.75), 'demon', skin);
  r.add('hips', G.cyl(0.14, 0.13, 0.18, 10), mat(0, 0.86, 0, 0, 0, 0, 1, 1, 0.8), 'demon', dark);
  r.add('neck', G.cyl(0.045, 0.05, 0.12, 8), mat(0, 1.43, hz), 'demon', skin);
  r.add('head', G.sphere(0.095, 12, 8), mat(0, 1.55, hz * 1.2 + 0.01, 0, 0, 0, 0.85, 1.05, 1.1), 'demon', skin);
  r.add('head', G.cone(0.05, 0.1, 6), mat(0, 1.49, hz * 1.2 + 0.08, 1.8, 0, 0), 'demon', dark);
  glowEyes(r, 'head', 1.57, hz * 1.2 + 0.09, 0.034, [2.2, 1.3, 0.2]);
  horn(r, 'head', [0.05, 1.62, hz * 1.2 - 0.01], [0.5, 0.8, -0.5], 0.16, 0.025);
  horn(r, 'head', [-0.05, 1.62, hz * 1.2 - 0.01], [-0.5, 0.8, -0.5], 0.16, 0.025);
  // spikes on shoulders and spine
  for (const sx of [1, -1]) horn(r, 'chest', [sx * 0.15, 1.38, hz * 0.6 - 0.05], [sx * 0.3, 1, -0.6], 0.14, 0.03);
  for (let k = 0; k < 4; k++) horn(r, k < 2 ? 'chest' : 'spine', [0, 1.36 - k * 0.1, -0.1 + hz * 0.3], [0, 0.4, -1], 0.1, 0.022);
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1, x = sx * d.shX, y = d.shY, z = hz * 0.8;
    limb(r, 'arm' + side, [x, y, z], [x, y - d.upper, z], 0.055, 0.042, 'demon', skin);
    limb(r, 'fore' + side, [x, y - d.upper, z], [x, y - d.upper - d.fore, z], 0.045, 0.035, 'demon', skin);
    horn(r, 'fore' + side, [x + sx * 0.04, y - d.upper - 0.08, z - 0.02], [sx * 0.6, 0.6, -0.4], 0.09, 0.02);
    const hy = y - d.upper - d.fore;
    r.add('hand' + side, G.box(0.06, 0.09, 0.07), mat(x, hy - 0.04, z + 0.01), 'demon', dark);
    for (const k of [-1, 0, 1]) horn(r, 'hand' + side, [x + k * 0.02, hy - 0.08, z + 0.03], [0, -1, 0.3], 0.08, 0.012);
    const hx = sx * d.hipX;
    limb(r, 'thigh' + side, [hx, d.hipY - 0.03, 0], [hx, d.kneeY, 0], 0.075, 0.055, 'demon', skin);
    limb(r, 'shin' + side, [hx, d.kneeY, 0], [hx, 0.1, 0], 0.052, 0.04, 'demon', dark);
    r.add('foot' + side, G.box(0.08, 0.06, 0.2), mat(hx, 0.035, 0.05), 'demon', dark);
    horn(r, 'foot' + side, [hx, 0.03, 0.15], [0, 0, 1], 0.06, 0.015);
  }
  // tail
  limb(r, 'tail1', [0, d.hipY - 0.02, -0.12], [0, d.hipY - 0.12, -0.42], 0.045, 0.035, 'demon', skin);
  limb(r, 'tail2', [0, d.hipY - 0.12, -0.42], [0, d.hipY - 0.2, -0.75], 0.035, 0.022, 'demon', skin);
  horn(r, 'tail3', [0, d.hipY - 0.2, -0.75], [0, -0.3, -1], 0.12, 0.04);
  // fireball holder glow in the right hand (shown while casting)
  return r.build(materials, MATS);
}

// ------------------------------------------------------------- brute
export function buildBrute(materials) {
  const s = 1.5;
  const { bones, dims: d } = humanoidBones({ scale: s, hipY: 0.92, shoulderY: 1.42, shoulderX: 0.3, hipX: 0.13, upperArm: 0.3, foreArm: 0.3, hunchZ: 0.18 });
  const r = new RigBuilder(bones);
  const skin = [0.62, 0.22, 0.16];
  const dark = [0.28, 0.12, 0.1];
  const iron = [0.22, 0.2, 0.2];
  const glow = [2.4, 0.7, 0.15];
  const hz = d.hunch;
  r.add('chest', G.sphere(0.36 * s * 0.85, 14, 10), mat(0, d.hipY + 0.4 * s, hz * 0.6, 0, 0, 0, 1.25, 0.95, 0.85), 'demon', skin);
  r.add('chest', G.box(0.12 * s, 0.2 * s, 0.02), mat(0, d.hipY + 0.42 * s, hz * 0.6 + 0.27 * s), 'demonGlow', glow);
  r.add('spine', G.cyl(0.26 * s, 0.22 * s, 0.25 * s, 12), mat(0, d.hipY + 0.14 * s, 0.03, 0, 0, 0, 1, 1, 0.8), 'demon', skin);
  r.add('hips', G.cyl(0.24 * s, 0.22 * s, 0.22 * s, 12), mat(0, d.hipY - 0.04 * s, 0, 0, 0, 0, 1, 1, 0.82), 'charLeather', dark);
  r.add('hips', G.box(0.36 * s, 0.32 * s, 0.03), mat(0, d.hipY - 0.2 * s, 0.17 * s), 'charMetal', iron);
  r.add('neck', G.cyl(0.11 * s, 0.13 * s, 0.12 * s, 10), mat(0, d.shY + 0.05 * s, hz), 'demon', skin);
  r.add('head', G.sphere(0.13 * s, 12, 8), mat(0, d.shY + 0.17 * s, hz * 1.2 + 0.04, 0, 0, 0, 1, 0.95, 1.05), 'demon', skin);
  r.add('head', G.box(0.16 * s, 0.07 * s, 0.1 * s), mat(0, d.shY + 0.1 * s, hz * 1.2 + 0.12), 'demon', dark);
  for (let k = -2; k <= 2; k++) horn(r, 'head', [k * 0.03 * s, d.shY + 0.08 * s, hz * 1.2 + 0.16 * s], [0, 1, 0.2], 0.05 * s, 0.012 * s, BONE);
  glowEyes(r, 'head', d.shY + 0.2 * s, hz * 1.2 + 0.17 * s, 0.05 * s, [2.6, 0.9, 0.1], 0.03 * s);
  horn(r, 'head', [0.1 * s, d.shY + 0.25 * s, hz * 1.2], [1, 0.4, 0.3], 0.32 * s, 0.05 * s);
  horn(r, 'head', [-0.1 * s, d.shY + 0.25 * s, hz * 1.2], [-1, 0.4, 0.3], 0.32 * s, 0.05 * s);
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1, x = sx * d.shX, y = d.shY, z = hz * 0.8;
    r.add('arm' + side, G.sphere(0.17 * s, 10, 8), mat(x, y, z, 0, 0, 0, 1.1, 0.9, 1), 'charMetal', iron);
    for (let k = 0; k < 3; k++) horn(r, 'arm' + side, [x + sx * 0.1 * s, y + 0.08 * s, z - 0.05 + k * 0.08 * s], [sx * 0.5, 1, 0], 0.12 * s, 0.025 * s);
    limb(r, 'arm' + side, [x, y, z], [x, y - d.upper, z], 0.14 * s, 0.11 * s, 'demon', skin);
    limb(r, 'fore' + side, [x, y - d.upper, z], [x, y - d.upper - d.fore, z], 0.12 * s, 0.1 * s, 'demon', skin);
    r.add('fore' + side, G.cyl(0.115 * s, 0.11 * s, 0.14 * s, 10), mat(x, y - d.upper - d.fore * 0.6, z), 'charMetal', iron);
    r.add('hand' + side, G.sphere(0.12 * s, 10, 8), mat(x, y - d.upper - d.fore - 0.08 * s, z + 0.02, 0, 0, 0, 1, 1.1, 1.1), 'demon', dark);
    const hx = sx * d.hipX;
    limb(r, 'thigh' + side, [hx, d.hipY - 0.03 * s, 0], [hx, d.kneeY, 0], 0.15 * s, 0.11 * s, 'demon', skin);
    limb(r, 'shin' + side, [hx, d.kneeY, 0], [hx, 0.1 * s, 0], 0.11 * s, 0.08 * s, 'demon', dark);
    r.add('foot' + side, G.box(0.16 * s, 0.1 * s, 0.22 * s), mat(hx, 0.05 * s, 0.04 * s), 'charMetal', [0.15, 0.12, 0.1]);
  }
  return r.build(materials, MATS);
}

// ------------------------------------------------------------- boss
export function buildBoss(materials) {
  const s = 3.0;
  const { bones, dims: d } = humanoidBones({ scale: s, hipY: 0.95, shoulderY: 1.45, shoulderX: 0.27, hipX: 0.12, upperArm: 0.33, foreArm: 0.34, hunchZ: 0.12 * s });
  const r = new RigBuilder(bones);
  const skin = [0.45, 0.2, 0.16];
  const robe = [0.55, 0.05, 0.04];
  const gold = [0.9, 0.7, 0.3];
  const glow = [3, 0.9, 0.2];
  const hz = d.hunch;
  // robe skirt and torso
  r.add('hips', G.cyl(0.25 * s, 0.42 * s, 0.6 * s, 14), mat(0, d.hipY - 0.25 * s, 0), 'charCloth', robe);
  r.add('hips', G.cyl(0.26 * s, 0.26 * s, 0.06 * s, 14), mat(0, d.hipY + 0.04 * s, 0), 'charMetal', gold);
  r.add('spine', G.cyl(0.22 * s, 0.24 * s, 0.25 * s, 12), mat(0, d.hipY + 0.14 * s, 0, 0, 0, 0, 1, 1, 0.8), 'charCloth', robe);
  r.add('chest', G.sphere(0.27 * s, 14, 10), mat(0, d.hipY + 0.42 * s, hz * 0.5, 0, 0, 0, 1.15, 1, 0.85), 'demon', skin);
  r.add('chest', G.sphere(0.07 * s, 10, 8), mat(0, d.hipY + 0.42 * s, hz * 0.5 + 0.22 * s), 'demonGlow', glow);
  r.add('chest', G.torus(0.2 * s, 0.03 * s, 6, 16), mat(0, d.shY - 0.02 * s, hz * 0.6, Math.PI / 2, 0, 0), 'charMetal', gold);
  // mantle (cape) cone
  r.add('chest', G.cone(0.42 * s, 0.6 * s, 14, 1), mat(0, d.shY - 0.18 * s, hz * 0.4 - 0.06 * s, 0, 0, 0, 1, 1, 0.75), 'charCloth', robe);
  // head: skull with mitre crown of horns
  r.add('neck', G.cyl(0.07 * s, 0.09 * s, 0.12 * s, 10), mat(0, d.shY + 0.06 * s, hz), 'demon', skin);
  r.add('head', G.sphere(0.12 * s, 14, 10), mat(0, d.shY + 0.18 * s, hz * 1.2, 0, 0, 0, 0.9, 1.1, 1), 'demon', [0.8, 0.72, 0.6]);
  r.add('head', G.box(0.12 * s, 0.05 * s, 0.09 * s), mat(0, d.shY + 0.1 * s, hz * 1.2 + 0.06 * s), 'demon', [0.7, 0.62, 0.52]);
  glowEyes(r, 'head', d.shY + 0.2 * s, hz * 1.2 + 0.1 * s, 0.045 * s, [3, 1.2, 0.2], 0.022 * s);
  r.add('head', G.cyl(0.08 * s, 0.13 * s, 0.22 * s, 4), mat(0, d.shY + 0.36 * s, hz * 1.2 - 0.01 * s, 0, Math.PI / 4, 0, 1, 1, 0.7), 'charCloth', robe);
  for (let k = 0; k < 7; k++) {
    const a = (k / 6 - 0.5) * 2.2;
    horn(r, 'head', [Math.sin(a) * 0.1 * s, d.shY + 0.26 * s, hz * 1.2 + Math.cos(a) * 0.04 * s - 0.02 * s], [Math.sin(a) * 0.8, 1, -0.2], (0.22 + (k === 3 ? 0.15 : 0)) * s, 0.02 * s, [0.2, 0.15, 0.13]);
  }
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1, x = sx * d.shX, y = d.shY, z = hz * 0.8;
    r.add('arm' + side, G.sphere(0.12 * s, 10, 8), mat(x, y, z), 'charMetal', gold);
    limb(r, 'arm' + side, [x, y, z], [x, y - d.upper, z], 0.1 * s, 0.075 * s, 'charCloth', robe);
    limb(r, 'fore' + side, [x, y - d.upper, z], [x, y - d.upper - d.fore, z], 0.075 * s, 0.06 * s, 'demon', skin);
    const hy = y - d.upper - d.fore;
    r.add('hand' + side, G.box(0.1 * s, 0.12 * s, 0.1 * s), mat(x, hy - 0.05 * s, z + 0.01), 'demon', skin);
    for (const k of [-1, 0, 1]) horn(r, 'hand' + side, [x + k * 0.035 * s, hy - 0.1 * s, z + 0.04 * s], [0, -1, 0.35], 0.16 * s, 0.018 * s, [0.2, 0.15, 0.13]);
    const hx = sx * d.hipX;
    limb(r, 'thigh' + side, [hx, d.hipY - 0.03 * s, 0], [hx, d.kneeY, 0], 0.1 * s, 0.075 * s, 'demon', skin);
    limb(r, 'shin' + side, [hx, d.kneeY, 0], [hx, 0.1 * s, 0], 0.075 * s, 0.06 * s, 'demon', [0.3, 0.14, 0.12]);
    r.add('foot' + side, G.box(0.11 * s, 0.08 * s, 0.24 * s), mat(hx, 0.04 * s, 0.06 * s), 'demon', [0.2, 0.12, 0.1]);
  }
  return r.build(materials, MATS);
}

// ------------------------------------------------------------- hound
export function buildHound(materials) {
  // quadruped: +Z forward. body at the hips (rear), chest at front.
  const bones = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'body', parent: 'root', pos: [0, 0.7, -0.35] },
    { name: 'chest', parent: 'body', pos: [0, 0.74, 0.25] },
    { name: 'neck', parent: 'chest', pos: [0, 0.8, 0.45] },
    { name: 'head', parent: 'neck', pos: [0, 0.92, 0.62] },
    { name: 'jaw', parent: 'head', pos: [0, 0.88, 0.7] },
    { name: 'flU', parent: 'chest', pos: [0.15, 0.66, 0.35] },
    { name: 'flL', parent: 'flU', pos: [0.15, 0.36, 0.38] },
    { name: 'flP', parent: 'flL', pos: [0.15, 0.06, 0.36] },
    { name: 'frU', parent: 'chest', pos: [-0.15, 0.66, 0.35] },
    { name: 'frL', parent: 'frU', pos: [-0.15, 0.36, 0.38] },
    { name: 'frP', parent: 'frL', pos: [-0.15, 0.06, 0.36] },
    { name: 'blU', parent: 'body', pos: [0.14, 0.66, -0.45] },
    { name: 'blL', parent: 'blU', pos: [0.14, 0.38, -0.36] },
    { name: 'blP', parent: 'blL', pos: [0.14, 0.08, -0.48] },
    { name: 'brU', parent: 'body', pos: [-0.14, 0.66, -0.45] },
    { name: 'brL', parent: 'brU', pos: [-0.14, 0.38, -0.36] },
    { name: 'brP', parent: 'brL', pos: [-0.14, 0.08, -0.48] },
    { name: 'tail1', parent: 'body', pos: [0, 0.74, -0.58] },
    { name: 'tail2', parent: 'tail1', pos: [0, 0.7, -0.9] },
  ];
  const r = new RigBuilder(bones);
  const skin = [0.62, 0.24, 0.18];
  const dark = [0.3, 0.12, 0.1];
  r.add('body', G.sphere(0.24, 12, 8), mat(0, 0.72, -0.35, 0, 0, 0, 0.85, 0.85, 1.25), 'demon', skin);
  r.add('chest', G.sphere(0.28, 12, 8), mat(0, 0.76, 0.22, 0, 0, 0, 0.9, 0.95, 1.1), 'demon', skin);
  limb(r, 'neck', [0, 0.8, 0.42], [0, 0.92, 0.62], 0.13, 0.1, 'demon', skin);
  r.add('head', G.box(0.2, 0.16, 0.3), mat(0, 0.95, 0.75), 'demon', skin);
  r.add('head', G.box(0.14, 0.08, 0.2), mat(0, 0.94, 0.95), 'demon', dark);
  r.add('jaw', G.box(0.13, 0.05, 0.28), mat(0, 0.86, 0.88), 'demon', dark);
  for (let k = 0; k < 4; k++) {
    for (const sx of [1, -1]) {
      horn(r, 'head', [sx * 0.05, 0.9, 0.86 + k * 0.045], [0, -1, 0.1], 0.05, 0.01);
      horn(r, 'jaw', [sx * 0.05, 0.88, 0.84 + k * 0.045], [0, 1, 0.1], 0.04, 0.01);
    }
  }
  glowEyes(r, 'head', 1.0, 0.89, 0.07, [2.6, 1.0, 0.1], 0.022);
  horn(r, 'head', [0.08, 1.02, 0.66], [0.4, 0.6, -0.8], 0.2, 0.03);
  horn(r, 'head', [-0.08, 1.02, 0.66], [-0.4, 0.6, -0.8], 0.2, 0.03);
  for (let k = 0; k < 6; k++) horn(r, k < 3 ? 'chest' : 'body', [0, 0.98 - k * 0.01, 0.35 - k * 0.15], [0, 1, -0.4], 0.12 - k * 0.01, 0.025);
  const leg = (u, l, p, top, knee, paw, sx) => {
    limb(r, u, top, knee, 0.075, 0.055, 'demon', skin);
    limb(r, l, knee, paw, 0.05, 0.04, 'demon', dark);
    r.add(p, G.box(0.08, 0.05, 0.13), mat(paw[0], 0.03, paw[2] + 0.04), 'demon', dark);
    for (const k of [-1, 0, 1]) horn(r, p, [paw[0] + k * 0.025, 0.02, paw[2] + 0.1], [0, -0.2, 1], 0.05, 0.01);
    void sx;
  };
  leg('flU', 'flL', 'flP', [0.15, 0.66, 0.35], [0.15, 0.36, 0.38], [0.15, 0.06, 0.36], 1);
  leg('frU', 'frL', 'frP', [-0.15, 0.66, 0.35], [-0.15, 0.36, 0.38], [-0.15, 0.06, 0.36], -1);
  leg('blU', 'blL', 'blP', [0.14, 0.66, -0.45], [0.14, 0.38, -0.36], [0.14, 0.08, -0.48], 1);
  leg('brU', 'brL', 'brP', [-0.14, 0.66, -0.45], [-0.14, 0.38, -0.36], [-0.14, 0.08, -0.48], -1);
  limb(r, 'tail1', [0, 0.74, -0.58], [0, 0.7, -0.9], 0.04, 0.03, 'demon', skin);
  horn(r, 'tail2', [0, 0.7, -0.9], [0, -0.2, -1], 0.25, 0.035, dark);
  return r.build(materials, MATS);
}

// ------------------------------------------------------------- gazer
export function buildGazer(materials) {
  const bones = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'body', parent: 'root', pos: [0, 0, 0] },
    { name: 'eye', parent: 'body', pos: [0, 0.05, 0.42] },
    { name: 'jaw', parent: 'body', pos: [0, -0.3, 0.2] },
  ];
  for (let t = 0; t < 4; t++) {
    const a = (t / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.3, z = Math.sin(a) * 0.3;
    bones.push(
      { name: `t${t}a`, parent: 'body', pos: [x, -0.45, z] },
      { name: `t${t}b`, parent: `t${t}a`, pos: [x * 1.1, -0.85, z * 1.1] },
      { name: `t${t}c`, parent: `t${t}b`, pos: [x * 1.15, -1.25, z * 1.15] },
    );
  }
  const r = new RigBuilder(bones);
  const skin = [0.75, 0.3, 0.32];
  r.add('body', G.sphere(0.55, 18, 14), mat(0, 0, 0), 'demon', skin);
  r.add('body', G.torus(0.42, 0.06, 8, 20), mat(0, 0.05, 0.3, 0, 0, 0, 1, 1, 0.8), 'demon', [0.5, 0.16, 0.16]);
  r.add('eye', G.sphere(0.3, 16, 12), mat(0, 0.05, 0.3), 'charCloth', [0.95, 0.9, 0.85]);
  r.add('eye', G.cyl(0.14, 0.14, 0.03, 16), mat(0, 0.05, 0.58, Math.PI / 2, 0, 0), 'demonGlow', [2.4, 0.5, 0.08]);
  r.add('eye', G.cyl(0.06, 0.06, 0.035, 12), mat(0, 0.05, 0.6, Math.PI / 2, 0, 0), 'demonGlow', [0.05, 0.0, 0.0]);
  r.add('jaw', G.box(0.4, 0.08, 0.3), mat(0, -0.34, 0.25), 'demon', [0.4, 0.12, 0.12]);
  for (let k = -3; k <= 3; k++) horn(r, 'jaw', [k * 0.05, -0.31, 0.38], [0, 1, 0.2], 0.08, 0.012);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    horn(r, 'body', [Math.cos(a) * 0.4, 0.35, Math.sin(a) * 0.4 - 0.05], [Math.cos(a), 0.9, Math.sin(a) - 0.2], 0.28, 0.05);
  }
  for (let t = 0; t < 4; t++) {
    const a = (t / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.3, z = Math.sin(a) * 0.3;
    limb(r, `t${t}a`, [x, -0.45, z], [x * 1.1, -0.85, z * 1.1], 0.07, 0.055, 'demon', skin);
    limb(r, `t${t}b`, [x * 1.1, -0.85, z * 1.1], [x * 1.15, -1.25, z * 1.15], 0.055, 0.035, 'demon', skin);
    horn(r, `t${t}c`, [x * 1.15, -1.25, z * 1.15], [0, -1, 0], 0.25, 0.035, [0.5, 0.16, 0.16]);
  }
  return r.build(materials, MATS);
}

export const BUILDERS = { thrall: buildThrall, imp: buildImp, brute: buildBrute, boss: buildBoss, hound: buildHound, gazer: buildGazer };
