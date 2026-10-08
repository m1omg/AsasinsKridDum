// Convert a generated character GLB (Higgsfield image -> SAM 3D or Tripo mesh) into the
// game's compact skinned format, rigged for the game's own skeletons so the
// procedural animations drive it unchanged.
//
// Usage: node tools/convert_character.mjs <in.glb> <name> <kind> <height> [opts-json]
//   kind: humanoid | quadruped | gazer | rigid
//   opts: { tails, armR, torsoR, hipY, ..., out: <dir>, debugDir: <dir> }
// Writes assets/models/<name>.bin and the mesh's base colour texture as
// assets/models/<name>.src.png, which tools/process_character_textures.py
// turns into <name>.webp (and an optional <name>_e.webp glow map).
//
// Needs (not part of the game build): npm i --no-save @gltf-transform/core @gltf-transform/extensions
//
// Commands used for the shipped models:
//   hero humanoid 1.8 '{"tails":true,"yaw":-1.5707963}'   (Tripo H3.1 mesh, which faces +X;
//        textures: process_character_textures.py hero --size 2048)
//   thrall humanoid 1.78   imp humanoid 1.72
//   brute humanoid 2.9 '{"armR":0.055,"torsoR":0.13}'   boss humanoid 6.6 '{"armR":0.07,"torsoR":0.1}'
//   hound quadruped 1.04   gazer gazer 2.2
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const [, , inFile, name, kind = 'humanoid', heightArg = '1.8', optsArg = '{}'] = process.argv;
if (!inFile || !name) {
  console.error('usage: node tools/convert_character.mjs <in.glb> <name> <humanoid|quadruped|gazer|rigid> <height> [opts-json]');
  process.exit(1);
}
const OPTS = JSON.parse(optsArg);
const OUT = OPTS.out || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'models');
const H = Number(heightArg);
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ load
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inFile);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const P0 = prim.getAttribute('POSITION').getArray();
const UV0 = prim.getAttribute('TEXCOORD_0').getArray();
const IDX = prim.getIndices() ? Array.from(prim.getIndices().getArray()) : [...Array(P0.length / 3).keys()];
const tex = prim.getMaterial()?.getBaseColorTexture();
if (tex) fs.writeFileSync(path.join(OUT, name + '.src.' + (tex.getMimeType() === 'image/jpeg' ? 'jpg' : 'png')), tex.getImage());
const N = P0.length / 3;

// ------------------------------------------------------------------ normalise: feet at 0, height H, centred
const v3 = (i, a = P0) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let i = 0; i < N; i++) {
  const [x, y, z] = v3(i);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
}
// optional yaw correction (radians) so the character faces +Z
const yaw = OPTS.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
const s = H / (maxY - minY);
const P = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  let [x, y, z] = v3(i);
  x -= (minX + maxX) / 2; z -= (minZ + maxZ) / 2;
  const rx = x * cy + z * sy, rz = -x * sy + z * cy;
  P[i * 3] = rx * s; P[i * 3 + 1] = (y - minY) * s; P[i * 3 + 2] = rz * s;
}
const median = (a) => { if (!a.length) return 0; const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
// centre the body column (torso) on x = z = 0
{
  const xs = [], zs = [];
  for (let i = 0; i < N; i++) {
    const y = P[i * 3 + 1];
    if (y > 0.45 * H && y < 0.75 * H && Math.abs(P[i * 3]) < 0.12 * H) { xs.push(P[i * 3]); zs.push(P[i * 3 + 2]); }
  }
  const mx = kind === 'humanoid' ? median(xs) : 0, mz = kind === 'humanoid' ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0;
  for (let i = 0; i < N; i++) { P[i * 3] -= mx; P[i * 3 + 2] -= mz; }
}

// ------------------------------------------------------------------ weld + smooth normals
const key = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
const weld = new Int32Array(N);
{
  const map = new Map();
  for (let i = 0; i < N; i++) { const k = key(i); if (!map.has(k)) map.set(k, i); weld[i] = map.get(k); }
}
const NRM = new Float32Array(N * 3);
for (let t = 0; t < IDX.length; t += 3) {
  const a = IDX[t], b = IDX[t + 1], c = IDX[t + 2];
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
  const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // area weighted
  for (const v of [a, b, c]) { const w = weld[v]; NRM[w * 3] += nx; NRM[w * 3 + 1] += ny; NRM[w * 3 + 2] += nz; }
}
for (let i = 0; i < N; i++) {
  const w = weld[i];
  const x = NRM[w * 3], y = NRM[w * 3 + 1], z = NRM[w * 3 + 2], l = Math.hypot(x, y, z) || 1;
  NRM[i * 3] = x / l; NRM[i * 3 + 1] = y / l; NRM[i * 3 + 2] = z / l;
}
// adjacency on welded vertices (for weight smoothing)
const adj = new Map();
const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
for (let t = 0; t < IDX.length; t += 3) {
  const a = weld[IDX[t]], b = weld[IDX[t + 1]], c = weld[IDX[t + 2]];
  link(a, b); link(b, a); link(b, c); link(c, b); link(a, c); link(c, a);
}

// ------------------------------------------------------------------ vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** parameter t of the closest point on segment ab, and distance */
function segInfo(p, a, b) {
  const ab = sub(b, a), l2 = dot(ab, ab) || 1e-9;
  const t = dot(sub(p, a), ab) / l2;
  const tc = Math.min(1, Math.max(0, t));
  return { t, d: len(sub(p, add(a, mul(ab, tc)))) };
}
const pos = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

/** principal axis of a point set (power iteration on the covariance) */
function pca(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = sub(p, c); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r][k] += d[r] * d[k]; }
  let v = [1, -1, 0.1];
  for (let it = 0; it < 60; it++) { v = norm([dot(C[0], v), dot(C[1], v), dot(C[2], v)]); }
  return { c, d: v };
}

// ------------------------------------------------------------------ skeletons
const W = new Float32Array(N * 4);
const J = new Uint8Array(N * 4);
let bones, bind = {}, dims = {}, extra = {};

if (kind === 'humanoid') ({ bones, bind, dims, extra } = humanoid());
else if (kind === 'quadruped') ({ bones, bind, dims, extra } = quadruped());
else if (kind === 'gazer') ({ bones, bind, dims, extra } = gazer());
else ({ bones, dims } = rigid());

function setWeights(i, list) {
  // list: [[boneIndex, weight], ...] -> top 4, normalised
  const m = new Map();
  for (const [b, w] of list) if (w > 1e-4) m.set(b, (m.get(b) || 0) + w);
  const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const tot = top.reduce((a, [, w]) => a + w, 0) || 1;
  for (let k = 0; k < 4; k++) { J[i * 4 + k] = top[k] ? top[k][0] : 0; W[i * 4 + k] = top[k] ? top[k][1] / tot : 0; }
  if (!top.length) { J[i * 4] = 0; W[i * 4] = 1; }
}

function smoothWeights(iterations, nb) {
  // Laplacian smoothing of the full weight vectors over welded topology
  let cur = [];
  for (let i = 0; i < N; i++) {
    if (weld[i] !== i) continue;
    const v = new Float32Array(nb);
    for (let k = 0; k < 4; k++) v[J[i * 4 + k]] += W[i * 4 + k];
    cur[i] = v;
  }
  for (let it = 0; it < iterations; it++) {
    const next = [];
    for (let i = 0; i < N; i++) {
      if (weld[i] !== i) continue;
      const n = adj.get(i);
      const v = Float32Array.from(cur[i]);
      if (n && n.size) {
        const acc = new Float32Array(nb);
        for (const j of n) { const c = cur[j]; for (let b = 0; b < nb; b++) acc[b] += c[b]; }
        for (let b = 0; b < nb; b++) v[b] = 0.5 * v[b] + 0.5 * acc[b] / n.size;
      }
      next[i] = v;
    }
    cur = next;
  }
  for (let i = 0; i < N; i++) {
    const v = cur[weld[i]];
    setWeights(i, [...v].map((w, b) => [b, w]));
  }
}

function humanoid() {
  const o = OPTS;
  const f = (k, d) => (o[k] ?? d) * H;
  const hipY = f('hipY', 0.53), spineY = f('spineY', 0.6), chestY = f('chestY', 0.71), shY = f('shoulderY', 0.81);
  const neckY = f('neckY', 0.845), headY = f('headY', 0.885);
  // torso centre line (x, z) at a height
  const centre = (y, halfW = 0.1 * H) => {
    const xs = [], zs = [];
    for (let i = 0; i < N; i++) if (Math.abs(P[i * 3 + 1] - y) < 0.025 * H && Math.abs(P[i * 3]) < halfW) { xs.push(P[i * 3]); zs.push(P[i * 3 + 2]); }
    if (!xs.length) return [0, y, 0];
    return [median(xs), y, (Math.min(...zs) + Math.max(...zs)) / 2];
  };
  const hips = centre(hipY), spine = centre(spineY), chest = centre(chestY), neck = centre(neckY, 0.06 * H), head = centre(headY, 0.06 * H);
  const top = [head[0], H, head[2]];

  // arms: principal axis of the outer arm vertices, shoulder where the axis reaches shoulder height
  const arm = (side) => {
    let tip = null;
    for (let i = 0; i < N; i++) {
      const y = P[i * 3 + 1];
      if (y < 0.25 * H || y > 0.9 * H) continue;
      if (!tip || P[i * 3] * side > tip[0] * side) tip = pos(i);
    }
    const pts = [];
    for (let i = 0; i < N; i++) {
      const p = pos(i);
      if (p[0] * side > (o.armSelect ?? 0.55) * tip[0] * side && p[1] > 0.25 * H && p[1] < 0.9 * H) pts.push(p);
    }
    const { c, d: d0 } = pca(pts);
    const d = d0[0] * side > 0 ? d0 : mul(d0, -1); // outward
    let t = (shY - c[1]) / (d[1] || -1e-6);
    let shoulder = add(c, mul(d, t));
    const sx = Math.min(0.17 * H, Math.max(0.06 * H, Math.abs(shoulder[0])));
    shoulder = [sx * side, shY, (shoulder[2] + chest[2]) / 2];
    const dir = norm(sub(tip, shoulder));
    const L = len(sub(tip, shoulder));
    const wristF = o.wristFrac ?? 0.76, elbowF = o.elbowFrac ?? 0.41;
    return { shoulder, elbow: add(shoulder, mul(dir, L * elbowF)), wrist: add(shoulder, mul(dir, L * wristF)), tip, dir, L };
  };
  const aL = arm(1), aR = arm(-1);

  // legs: feet from the lowest vertices on each side
  const leg = (side) => {
    const foot = [];
    for (let i = 0; i < N; i++) if (P[i * 3 + 1] < 0.06 * H && P[i * 3] * side > 0) foot.push(pos(i));
    const fx = median(foot.map((p) => p[0]));
    const zs = foot.map((p) => p[2]);
    const zMin = Math.min(...zs), zMax = Math.max(...zs);
    const ankle = [fx, (o.ankleY ?? 0.05) * H, zMin + (zMax - zMin) * 0.32];
    const toe = [fx, 0.015 * H, zMax];
    const hip = [Math.max(0.04 * H, Math.abs(fx) * (o.hipSpread ?? 0.75)) * side, hipY - 0.025 * H, hips[2]];
    const knee = lerp3(hip, ankle, o.kneeFrac ?? 0.5);
    knee[2] += 0.012 * H; // knees sit slightly forward
    return { hip, knee, ankle, toe };
  };
  const lL = leg(1), lR = leg(-1);

  // coat / tail chain behind the hips (optional)
  const tails = o.tails ? (() => {
    const back = (y) => { let zb = 0; for (let i = 0; i < N; i++) if (Math.abs(P[i * 3 + 1] - y) < 0.02 * H && Math.abs(P[i * 3]) < 0.08 * H) zb = Math.min(zb, P[i * 3 + 2]); return zb; };
    const y1 = hipY + 0.01 * H, y2 = hipY - 0.17 * H, y3 = hipY - 0.34 * H, y4 = hipY - 0.46 * H;
    return [[0, y1, back(y1) * 0.6], [0, y2, back(y2) * 0.6], [0, y3, back(y3) * 0.6], [0, y4, back(y4) * 0.6]];
  })() : null;

  // rest layout: arms hang straight down from the shoulder (the game's zero pose)
  const down = (p, l) => [p[0], p[1] - l, p[2]];
  const upL = len(sub(aL.elbow, aL.shoulder)), foL = len(sub(aL.wrist, aL.elbow));
  const upR = len(sub(aR.elbow, aR.shoulder)), foR = len(sub(aR.wrist, aR.elbow));
  const B = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'hips', parent: 'root', pos: hips },
    { name: 'spine', parent: 'hips', pos: spine },
    { name: 'chest', parent: 'spine', pos: chest },
    { name: 'neck', parent: 'chest', pos: neck },
    { name: 'head', parent: 'neck', pos: head },
    { name: 'armL', parent: 'chest', pos: aL.shoulder },
    { name: 'foreL', parent: 'armL', pos: down(aL.shoulder, upL) },
    { name: 'handL', parent: 'foreL', pos: down(aL.shoulder, upL + foL) },
    { name: 'armR', parent: 'chest', pos: aR.shoulder },
    { name: 'foreR', parent: 'armR', pos: down(aR.shoulder, upR) },
    { name: 'handR', parent: 'foreR', pos: down(aR.shoulder, upR + foR) },
    { name: 'thighL', parent: 'hips', pos: lL.hip },
    { name: 'shinL', parent: 'thighL', pos: lL.knee },
    { name: 'footL', parent: 'shinL', pos: lL.ankle },
    { name: 'thighR', parent: 'hips', pos: lR.hip },
    { name: 'shinR', parent: 'thighR', pos: lR.knee },
    { name: 'footR', parent: 'shinR', pos: lR.ankle },
  ];
  if (tails) B.push(
    { name: 'tail1', parent: 'hips', pos: tails[0] },
    { name: 'tail2', parent: 'tail1', pos: tails[1] },
    { name: 'tail3', parent: 'tail2', pos: tails[2] },
  );
  const bi = Object.fromEntries(B.map((b, i) => [b.name, i]));

  // bind pose: rotate each arm from hanging (0,-1,0) to the A-pose direction found in the mesh
  const quatFromTo = (a, b) => {
    a = norm(a); b = norm(b);
    const d = dot(a, b);
    if (d < -0.999999) return [1, 0, 0, 0];
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const q = [c[0], c[1], c[2], 1 + d];
    const l = Math.hypot(...q);
    return q.map((v) => v / l);
  };
  const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
  const qRot = (q, v) => {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  for (const [a, sideName] of [[aL, 'L'], [aR, 'R']]) {
    const qUp = quatFromTo([0, -1, 0], sub(a.elbow, a.shoulder));
    const foreLocal = qRot(qConj(qUp), sub(a.wrist, a.elbow));
    const qFore = quatFromTo([0, -1, 0], foreLocal);
    bind['arm' + sideName] = qUp;
    bind['fore' + sideName] = qFore;
  }

  // ---- weights (bind pose positions), then smoothed over the surface
  // torso axis through hips, spine, chest, neck at a given height
  const axisPts = [hips, spine, chest, neck, head];
  const torsoAxis = (y) => {
    if (y <= axisPts[0][1]) return axisPts[0];
    for (let k = 0; k < axisPts.length - 1; k++) {
      const a = axisPts[k], b = axisPts[k + 1];
      if (y <= b[1]) return lerp3(a, b, (y - a[1]) / (b[1] - a[1] || 1));
    }
    return axisPts[axisPts.length - 1];
  };
  const armR = (o.armR ?? 0.042) * H, torsoR = (o.torsoR ?? 0.11) * H;
  const eT = o.elbowFrac ?? 0.41, wT = o.wristFrac ?? 0.76;
  const legR = (o.legRadius ?? 0.075) * H;
  const torsoW = (y) => {
    // hips / spine / chest / neck / head by height
    const w1 = smooth(hipY + 0.01 * H, spineY + 0.02 * H, y);
    const w2 = smooth(spineY + 0.02 * H, chestY, y);
    const w3 = smooth(neckY - 0.025 * H, neckY + 0.005 * H, y);
    const w4 = smooth(neckY + 0.005 * H, headY, y);
    return [[bi.hips, 1 - w1], [bi.spine, w1 * (1 - w2)], [bi.chest, w2 * (1 - w3)], [bi.neck, w3 * (1 - w4)], [bi.head, w4]];
  };
  const legW = (p, side) => {
    const L = side > 0 ? lL : lR, S = side > 0 ? 'L' : 'R';
    const th = segInfo(p, L.hip, L.knee), sh = segInfo(p, L.knee, L.ankle), ft = segInfo(p, L.ankle, L.toe);
    const dLeg = Math.min(th.d, sh.d, ft.d);
    if (tails && dLeg > legR * 1.05 && p[2] < -0.02 * H && p[1] > 0.12 * H) {
      // back of the coat: tail chain by height
      const y = p[1];
      const t1 = smooth(tails[1][1] - 0.04 * H, tails[1][1] + 0.04 * H, y);
      const t2 = smooth(tails[2][1] - 0.04 * H, tails[2][1] + 0.04 * H, y);
      return [[bi.tail1, t1], [bi.tail2, (1 - t1) * t2], [bi.tail3, 1 - t2], [bi['thigh' + S], 0.15]];
    }
    const kneeY = L.knee[1], ankY = L.ankle[1];
    const wHip = smooth(hipY - 0.01 * H, hipY - 0.07 * H, p[1]);
    const wThigh = wHip * smooth(kneeY - 0.04 * H, kneeY + 0.04 * H, p[1]);
    const wShin = smooth(kneeY + 0.04 * H, kneeY - 0.04 * H, p[1]) * smooth(ankY - 0.01 * H, ankY + 0.03 * H, p[1]);
    const wFoot = smooth(ankY + 0.03 * H, ankY - 0.01 * H, p[1]);
    return [[bi.hips, 1 - wHip], [bi['thigh' + S], wThigh], [bi['shin' + S], wShin], [bi['foot' + S], wFoot]];
  };
  for (let i = 0; i < N; i++) {
    const p = pos(i);
    const side = p[0] >= 0 ? 1 : -1;
    const a = side > 0 ? aL : aR, S = side > 0 ? 'L' : 'R';
    // arm-ness: compare distance to the arm axis and to the torso axis, each relative to its thickness
    const rel = sub(p, a.shoulder);
    const t = dot(rel, a.dir) / a.L;
    const dA = len(sub(rel, mul(a.dir, t * a.L)));
    const ax = torsoAxis(p[1]);
    const dT = Math.hypot(p[0] - ax[0], (p[2] - ax[2]) * 0.8);
    let armness = 0;
    if (p[1] > 0.2 * H && t > -0.08) armness = smooth(-0.35, 0.35, dT / torsoR - dA / armR) * smooth(-0.08, 0.04, t);
    const list = [];
    if (armness > 0) {
      const wUpper = 1 - smooth(eT - 0.05, eT + 0.05, t);
      const wFore = smooth(eT - 0.05, eT + 0.05, t) * (1 - smooth(wT - 0.03, wT + 0.03, t));
      const wHand = smooth(wT - 0.03, wT + 0.03, t);
      const near = 1 - smooth(-0.02, 0.1, t); // the shoulder joint itself stays partly with the chest
      list.push([bi.chest, armness * near], [bi['arm' + S], armness * wUpper * (1 - near)], [bi['fore' + S], armness * wFore], [bi['hand' + S], armness * wHand]);
    }
    const rest = 1 - armness;
    if (rest > 0) {
      // body: torso above the hips, legs below, blended across the hip line
      const k = smooth(hipY - 0.04 * H, hipY + 0.01 * H, p[1]);
      if (k > 0) for (const [b, w] of torsoW(p[1])) list.push([b, w * k * rest]);
      if (k < 1) for (const [b, w] of legW(p, side)) list.push([b, w * (1 - k) * rest]);
    }
    setWeights(i, list);
  }
  smoothWeights(o.smooth ?? 2, B.length);

  return {
    bones: B, bind,
    dims: { hipY: hips[1], chestY: chest[1], shY, height: H, backZ: (() => { let zb = 0; for (let i = 0; i < N; i++) if (Math.abs(P[i * 3 + 1] - 0.78 * H) < 0.03 * H && Math.abs(P[i * 3]) < 0.08 * H) zb = Math.min(zb, P[i * 3 + 2]); return zb; })() },
    extra: { arms: { L: aL, R: aR }, legs: { L: lL, R: lR }, tails },
  };
}

function quadruped() {
  // hound: legs from the four lowest clusters, head forward (+Z), tail back
  const o = OPTS;
  let zMinAll = Infinity, zMaxAll = -Infinity;
  for (let i = 0; i < N; i++) { zMinAll = Math.min(zMinAll, P[i * 3 + 2]); zMaxAll = Math.max(zMaxAll, P[i * 3 + 2]); }
  const Lz = zMaxAll - zMinAll;
  const bodyY = (o.bodyY ?? 0.62) * H;
  const centreAt = (z) => {
    const ys = [], xs = [];
    for (let i = 0; i < N; i++) if (Math.abs(P[i * 3 + 2] - z) < 0.03 * Lz && P[i * 3 + 1] > 0.35 * H) { ys.push(P[i * 3 + 1]); xs.push(P[i * 3]); }
    if (!ys.length) return [0, bodyY, z];
    return [median(xs), (Math.min(...ys) + Math.max(...ys)) / 2, z];
  };
  const feet = { fl: [], fr: [], bl: [], br: [] };
  const zMid = zMinAll + Lz * (o.legSplit ?? 0.5);
  for (let i = 0; i < N; i++) {
    if (P[i * 3 + 1] > 0.08 * H) continue;
    const k = (P[i * 3 + 2] > zMid ? 'f' : 'b') + (P[i * 3] > 0 ? 'l' : 'r');
    feet[k].push(pos(i));
  }
  const footPos = (arr) => [median(arr.map((p) => p[0])), 0.04 * H, median(arr.map((p) => p[2]))];
  const fp = Object.fromEntries(Object.entries(feet).map(([k, a]) => [k, footPos(a.length ? a : [[0, 0, 0]])]));
  const zBack = Math.max(fp.bl[2], fp.br[2]), zFront = Math.min(fp.fl[2], fp.fr[2]);
  const body = centreAt(zBack + 0.05 * Lz), chest = centreAt(zFront);
  const headZ = zMaxAll - (o.headLen ?? 0.12) * Lz;
  const neck = centreAt(zFront + (headZ - zFront) * 0.5), head = centreAt(headZ);
  const jaw = [0, head[1] - 0.04 * H, zMaxAll - 0.05 * Lz];
  const tail1 = centreAt(zMinAll + 0.2 * Lz), tail2 = [0, tail1[1] - 0.02 * H, zMinAll + 0.02 * Lz];
  const legChain = (foot, top) => {
    const shoulder = [foot[0], top[1] - 0.08 * H, foot[2]];
    const mid = [foot[0], (shoulder[1] + foot[1]) * 0.5, foot[2] + (o.kneeOffset ?? 0.02) * H];
    return [shoulder, mid, foot];
  };
  const [flU, flL, flP] = legChain(fp.fl, chest), [frU, frL, frP] = legChain(fp.fr, chest);
  const [blU, blL, blP] = legChain(fp.bl, body), [brU, brL, brP] = legChain(fp.br, body);
  const B = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'body', parent: 'root', pos: body },
    { name: 'chest', parent: 'body', pos: chest },
    { name: 'neck', parent: 'chest', pos: neck },
    { name: 'head', parent: 'neck', pos: head },
    { name: 'jaw', parent: 'head', pos: jaw },
    { name: 'flU', parent: 'chest', pos: flU }, { name: 'flL', parent: 'flU', pos: flL }, { name: 'flP', parent: 'flL', pos: flP },
    { name: 'frU', parent: 'chest', pos: frU }, { name: 'frL', parent: 'frU', pos: frL }, { name: 'frP', parent: 'frL', pos: frP },
    { name: 'blU', parent: 'body', pos: blU }, { name: 'blL', parent: 'blU', pos: blL }, { name: 'blP', parent: 'blL', pos: blP },
    { name: 'brU', parent: 'body', pos: brU }, { name: 'brL', parent: 'brU', pos: brL }, { name: 'brP', parent: 'brL', pos: brP },
    { name: 'tail1', parent: 'body', pos: tail1 }, { name: 'tail2', parent: 'tail1', pos: tail2 },
  ];
  const bi = Object.fromEntries(B.map((b, i) => [b.name, i]));
  const segs = [
    ['body', body, chest], ['chest', chest, neck], ['neck', neck, head], ['head', head, [0, head[1], zMaxAll]],
    ['flU', flU, flL], ['flL', flL, flP], ['flP', flP, [flP[0], 0, flP[2] + 0.03 * Lz]],
    ['frU', frU, frL], ['frL', frL, frP], ['frP', frP, [frP[0], 0, frP[2] + 0.03 * Lz]],
    ['blU', blU, blL], ['blL', blL, blP], ['blP', blP, [blP[0], 0, blP[2] + 0.03 * Lz]],
    ['brU', brU, brL], ['brL', brL, brP], ['brP', brP, [brP[0], 0, brP[2] + 0.03 * Lz]],
    ['tail1', tail1, tail2], ['tail2', tail2, [0, tail2[1], zMinAll]],
  ];
  const legTop = (o.legTop ?? 0.4) * H;
  for (let i = 0; i < N; i++) {
    const p = pos(i);
    const cands = [];
    for (const [b, a, c] of segs) {
      const isLeg = /^[fb][lr]/.test(b);
      if (isLeg) {
        if (p[1] > legTop + 0.06 * H) continue;
        if ((b[1] === 'l') !== (p[0] >= 0)) continue;
      } else if (p[1] < legTop - 0.1 * H && !b.startsWith('tail')) continue;
      cands.push([bi[b], segInfo(p, a, c).d]);
    }
    cands.sort((x, y) => x[1] - y[1]);
    const [b1, d1] = cands[0] || [bi.body, 1];
    const [b2, d2] = cands[1] || [b1, 1];
    const w1 = Math.pow(d2 + 1e-4, 4), w2 = Math.pow(d1 + 1e-4, 4);
    setWeights(i, [[b1, w1], [b2, w2 * 0.6]]);
  }
  smoothWeights(o.smooth ?? 2, B.length);
  return { bones: B, bind: {}, dims: { height: H, bodyY: body[1] }, extra: { feet: fp } };
}

function gazer() {
  // floating eye: origin at the widest slice of the body; tentacles traced downward as clusters
  let best = -1, bestY = 0.7 * H;
  for (let y = 0.3 * H; y < 0.95 * H; y += 0.01 * H) {
    let ext = 0;
    for (let i = 0; i < N; i++) if (Math.abs(P[i * 3 + 1] - y) < 0.01 * H) ext = Math.max(ext, Math.abs(P[i * 3]));
    if (ext > best) { best = ext; bestY = y; }
  }
  for (let i = 0; i < N; i++) P[i * 3 + 1] -= bestY;
  const R = best;
  const bottom = -R * (OPTS.bottomK ?? 0.9);
  let minYv = Infinity;
  for (let i = 0; i < N; i++) minYv = Math.min(minYv, P[i * 3 + 1]);
  // tentacle seeds: angular peaks just below the body
  const bins = 36, hist = new Float32Array(bins);
  for (let i = 0; i < N; i++) {
    const y = P[i * 3 + 1];
    if (y < bottom - 0.02 * H && y > bottom - 0.12 * H) hist[Math.floor(((Math.atan2(P[i * 3 + 2], P[i * 3]) + Math.PI) / (2 * Math.PI)) * bins) % bins]++;
  }
  const sm = hist.map((_, k) => hist[(k + bins - 1) % bins] + 2 * hist[k] + hist[(k + 1) % bins]);
  const mean = sm.reduce((a, b) => a + b, 0) / bins;
  const peaks = [];
  for (let k = 0; k < bins; k++) if (sm[k] > mean * 0.8 && sm[k] >= sm[(k + 1) % bins] && sm[k] > sm[(k + bins - 1) % bins]) peaks.push(k);
  // centroids per tentacle, followed down in bands
  let cents = peaks.map((k) => {
    const a = ((k + 0.5) / bins) * 2 * Math.PI - Math.PI;
    let sx = 0, sz = 0, n = 0;
    for (let i = 0; i < N; i++) {
      const y = P[i * 3 + 1];
      if (y < bottom - 0.02 * H && y > bottom - 0.12 * H) {
        const va = Math.atan2(P[i * 3 + 2], P[i * 3]);
        let d = Math.abs(va - a); d = Math.min(d, 2 * Math.PI - d);
        if (d < Math.PI / peaks.length) { sx += P[i * 3]; sz += P[i * 3 + 2]; n++; }
      }
    }
    return [sx / (n || 1), sz / (n || 1)];
  });
  const T = cents.length;
  const band = 0.04 * H;
  const track = cents.map((c) => [[c[0], bottom, c[1]]]);
  for (let y = bottom - band; y > minYv; y -= band) {
    const acc = cents.map(() => [0, 0, 0]);
    for (let i = 0; i < N; i++) {
      const py = P[i * 3 + 1];
      if (py > y || py < y - band) continue;
      let bi = 0, bd = Infinity;
      cents.forEach((c, k) => { const d = Math.hypot(P[i * 3] - c[0], P[i * 3 + 2] - c[1]); if (d < bd) { bd = d; bi = k; } });
      acc[bi][0] += P[i * 3]; acc[bi][1] += P[i * 3 + 2]; acc[bi][2]++;
    }
    cents = cents.map((c, k) => (acc[k][2] ? [acc[k][0] / acc[k][2], acc[k][1] / acc[k][2]] : c));
    cents.forEach((c, k) => { if (acc[k][2]) track[k].push([c[0], y - band / 2, c[1]]); });
  }
  const at = (tr, f) => tr[Math.min(tr.length - 1, Math.round(f * (tr.length - 1)))];
  const B = [
    { name: 'root', parent: null, pos: [0, 0, 0] },
    { name: 'body', parent: 'root', pos: [0, 0, 0] },
    { name: 'eye', parent: 'body', pos: [0, 0.05 * H, R * 0.8] },
    { name: 'jaw', parent: 'body', pos: [0, -R * 0.45, R * 0.75] },
  ];
  track.forEach((tr, k) => {
    B.push({ name: `t${k}a`, parent: 'body', pos: at(tr, 0) }, { name: `t${k}b`, parent: `t${k}a`, pos: at(tr, 0.33) }, { name: `t${k}c`, parent: `t${k}b`, pos: at(tr, 0.66) });
  });
  const bi = Object.fromEntries(B.map((b, i) => [b.name, i]));
  for (let i = 0; i < N; i++) {
    const p = pos(i);
    if (p[1] > bottom + 0.02 * H || !T) { setWeights(i, [[bi.body, 1]]); continue; }
    // nearest tentacle at this height
    let bk = 0, bd = Infinity;
    track.forEach((tr, k) => {
      let near = tr[0];
      for (const q of tr) if (Math.abs(q[1] - p[1]) < Math.abs(near[1] - p[1])) near = q;
      const d = Math.hypot(p[0] - near[0], p[2] - near[2]);
      if (d < bd) { bd = d; bk = k; }
    });
    const tr = track[bk];
    const ya = at(tr, 0)[1], yb = at(tr, 0.33)[1], yc = at(tr, 0.66)[1];
    const wBody = smooth(ya - 0.03 * H, ya + 0.02 * H, p[1]);
    const wb = smooth(yb + 0.03 * H, yb - 0.03 * H, p[1]), wc = smooth(yc + 0.03 * H, yc - 0.03 * H, p[1]);
    setWeights(i, [[bi.body, wBody], [bi[`t${bk}a`], (1 - wBody) * (1 - wb)], [bi[`t${bk}b`], (1 - wBody) * wb * (1 - wc)], [bi[`t${bk}c`], (1 - wBody) * wc]]);
  }
  smoothWeights(OPTS.smooth ?? 1, B.length);
  return { bones: B, bind: {}, dims: { height: H, radius: R, tentacles: T }, extra: { track } };
}

function rigid() {
  for (let i = 0; i < N; i++) setWeights(i, [[1, 1]]);
  return { bones: [{ name: 'root', parent: null, pos: [0, 0, 0] }, { name: 'body', parent: 'root', pos: [0, H / 2, 0] }], dims: { height: H } };
}

// ------------------------------------------------------------------ write
const header = { name, kind, verts: N, tris: IDX.length / 3, bones, bind, dims, index32: N > 65535 };
const hb = Buffer.from(JSON.stringify(header));
const pad4 = (n) => (n + 3) & ~3;
const parts = [];
const push = (buf) => { parts.push(buf); const p = pad4(buf.byteLength) - buf.byteLength; if (p) parts.push(Buffer.alloc(p)); };
const magic = Buffer.from('HCM1');
const hl = Buffer.alloc(4); hl.writeUInt32LE(hb.byteLength);
push(Buffer.concat([magic, hl])); push(hb);
push(Buffer.from(P.buffer));
const n8 = new Int8Array(N * 3); for (let i = 0; i < N * 3; i++) n8[i] = Math.round(Math.max(-1, Math.min(1, NRM[i])) * 127);
push(Buffer.from(n8.buffer));
const uv16 = new Uint16Array(N * 2); for (let i = 0; i < N * 2; i++) uv16[i] = Math.round(Math.max(0, Math.min(1, UV0[i])) * 65535);
push(Buffer.from(uv16.buffer));
push(Buffer.from(J.buffer));
const w8 = new Uint8Array(N * 4);
for (let i = 0; i < N; i++) {
  // quantise weights so they still sum to 255
  let rem = 255;
  for (let k = 0; k < 4; k++) { const q = k === 3 ? rem : Math.round(W[i * 4 + k] * 255); w8[i * 4 + k] = Math.max(0, Math.min(rem, q)); rem -= w8[i * 4 + k]; }
}
push(Buffer.from(w8.buffer));
const ib = header.index32 ? new Uint32Array(IDX) : new Uint16Array(IDX);
push(Buffer.from(ib.buffer));
const outBin = Buffer.concat(parts);
fs.writeFileSync(path.join(OUT, name + '.bin'), outBin);
if (OPTS.debugDir) fs.writeFileSync(path.join(OPTS.debugDir, name + '.debug.json'), JSON.stringify({ header, extra }, null, 1));
console.log(JSON.stringify({ name, kind, verts: N, tris: IDX.length / 3, bytes: outBin.byteLength, dims, bones: bones.length }));
