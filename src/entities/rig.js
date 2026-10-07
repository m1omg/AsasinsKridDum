import * as THREE from 'three';

// Procedural characters: primitive parts are merged into ONE SkinnedMesh per
// character (rigidly skinned to bones, optional soft blending at joints) so a
// whole demon costs a couple of draw calls. All bones have identity rest
// rotation, so poses are authored as simple Euler angles in model space:
//   +Z forward, +Y up, character's left = +X.
//   Limbs hang down: negative rx swings an arm/leg forward.
//   Spine/head point up: positive rx leans forward.

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

export class RigBuilder {
  /** bones: [{ name, parent, pos:[x,y,z] (model space) }] */
  constructor(bones) {
    this.defs = bones;
    this.index = new Map();
    bones.forEach((b, i) => this.index.set(b.name, i));
    this.parts = [];
  }

  /**
   * Add a primitive geometry. `matrix` places it in MODEL space (rest pose).
   * opts: { mat: material key, color: [r,g,b], soft: {bone, from:[x,y,z], dir:[x,y,z], width} }
   */
  add(bone, geometry, matrix, mat, color, soft = null) {
    if (!this.index.has(bone)) throw new Error('no bone ' + bone);
    this.parts.push({ bone: this.index.get(bone), geometry, matrix, mat, color, soft });
    return this;
  }

  build(materials, matKeys) {
    const groups = new Map();
    for (const p of this.parts) {
      if (!groups.has(p.mat)) groups.set(p.mat, []);
      groups.get(p.mat).push(p);
    }
    const pos = [], nrm = [], uv = [], col = [], si = [], sw = [], idx = [];
    const geoGroups = [];
    const matList = [];
    let vcount = 0;
    const keys = matKeys ? matKeys.filter((k) => groups.has(k)) : [...groups.keys()];
    for (const key of keys) {
      const start = idx.length;
      for (const p of groups.get(key)) {
        const g = p.geometry.index ? p.geometry : p.geometry;
        const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
        _m3.getNormalMatrix(p.matrix);
        const softBone = p.soft ? this.index.get(p.soft.bone) : -1;
        for (let i = 0; i < P.count; i++) {
          _v.fromBufferAttribute(P, i).applyMatrix4(p.matrix);
          _n.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize();
          pos.push(_v.x, _v.y, _v.z);
          nrm.push(_n.x, _n.y, _n.z);
          uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
          col.push(p.color[0], p.color[1], p.color[2]);
          if (softBone >= 0) {
            const s = p.soft;
            const t = ((_v.x - s.from[0]) * s.dir[0] + (_v.y - s.from[1]) * s.dir[1] + (_v.z - s.from[2]) * s.dir[2]) / s.width;
            const w = Math.min(1, Math.max(0, 0.5 + t * 0.5));
            si.push(p.bone, softBone, 0, 0);
            sw.push(w, 1 - w, 0, 0);
          } else {
            si.push(p.bone, 0, 0, 0);
            sw.push(1, 0, 0, 0);
          }
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(vcount + g.index.getX(i));
        else for (let i = 0; i < P.count; i++) idx.push(vcount + i);
        vcount += P.count;
      }
      geoGroups.push({ start, count: idx.length - start, materialIndex: matList.length });
      matList.push(materials[key]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    for (const gg of geoGroups) geo.addGroup(gg.start, gg.count, gg.materialIndex);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius *= 1.6;

    // bones
    const bones = [];
    const byName = {};
    this.defs.forEach((d) => {
      const b = new THREE.Bone();
      b.name = d.name;
      bones.push(b);
      byName[d.name] = b;
    });
    this.defs.forEach((d, i) => {
      const b = bones[i];
      if (d.parent) {
        const pd = this.defs[this.index.get(d.parent)];
        b.position.set(d.pos[0] - pd.pos[0], d.pos[1] - pd.pos[1], d.pos[2] - pd.pos[2]);
        byName[d.parent].add(b);
      } else b.position.set(d.pos[0], d.pos[1], d.pos[2]);
    });
    const mesh = new THREE.SkinnedMesh(geo, matList.length === 1 ? matList[0] : matList);
    const roots = bones.filter((b, i) => !this.defs[i].parent);
    for (const r of roots) mesh.add(r);
    mesh.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const rest = {};
    for (const b of bones) rest[b.name] = b.position.clone();
    return { mesh, skeleton, bones: byName, rest };
  }
}

// ---------------------------------------------------------------- primitives
const M = () => new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const S = new THREE.Vector3();
const T = new THREE.Vector3();

/** Matrix from position, euler (radians) and scale. */
export function mat(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return M().compose(T.set(px, py, pz), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz));
}

/** Matrix placing a Y-aligned primitive between two model-space points. */
export function between(a, b, sx = 1, sz = 1) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  return { m: M().compose(new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(sx, 1, sz)), len };
}

const geoCache = new Map();
function cached(key, make) {
  if (!geoCache.has(key)) geoCache.set(key, make());
  return geoCache.get(key);
}
export const G = {
  box: (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
  sphere: (r, ws = 12, hs = 8) => cached(`s${r},${ws},${hs}`, () => new THREE.SphereGeometry(r, ws, hs)),
  cyl: (rt, rb, h, seg = 10) => cached(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)),
  cone: (r, h, seg = 8) => cached(`k${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg)),
  capsule: (r, len, seg = 8) => cached(`p${r},${len},${seg}`, () => new THREE.CapsuleGeometry(r, len, 3, seg)),
  torus: (r, t, rs = 8, ts = 16, arc = Math.PI * 2) => cached(`t${r},${t},${rs},${ts},${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc)),
};

/** Tapered limb segment (cylinder) between two model-space points. */
export function limb(rig, bone, a, b, r0, r1, matKey, color, seg = 9, soft = null) {
  const { m, len } = between(a, b);
  rig.add(bone, new THREE.CylinderGeometry(r1, r0, len, seg, 1), m, matKey, color, soft);
  return rig;
}

// ---------------------------------------------------------------- poses
export const ZERO = [0, 0, 0];

/** Linear blend of two Euler pose maps into `out` (missing bones treated as zero). */
export function blendPose(out, a, b, t) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k[0] === '_') continue; // scalar extras such as _bob are not bone rotations
    const pa = a[k] || ZERO, pb = b[k] || ZERO;
    const o = out[k] || (out[k] = [0, 0, 0]);
    o[0] = pa[0] + (pb[0] - pa[0]) * t;
    o[1] = pa[1] + (pb[1] - pa[1]) * t;
    o[2] = pa[2] + (pb[2] - pa[2]) * t;
  }
  return out;
}

/** Overlay pose `b` onto `out` with weight w (only bones present in b). */
export function overlayPose(out, b, w) {
  if (w <= 0) return out;
  for (const k in b) {
    const pb = b[k];
    const o = out[k] || (out[k] = [0, 0, 0]);
    o[0] += (pb[0] - o[0]) * w;
    o[1] += (pb[1] - o[1]) * w;
    o[2] += (pb[2] - o[2]) * w;
  }
  return out;
}

/** Add pose `b` on top of `out` (additive layer). */
export function addPose(out, b, w = 1) {
  for (const k in b) {
    const pb = b[k];
    const o = out[k] || (out[k] = [0, 0, 0]);
    o[0] += pb[0] * w; o[1] += pb[1] * w; o[2] += pb[2] * w;
  }
  return out;
}

const ease = (t) => t * t * (3 - 2 * t);

/**
 * Sample a keyframed clip: frames = [{t, pose}], t normalized 0..1.
 * Bones absent from a frame are held from neighbours (treated as zero).
 */
export function sampleClip(frames, t, out = {}) {
  if (t <= frames[0].t) return blendPose(out, frames[0].pose, frames[0].pose, 0);
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (t <= b.t) {
      const u = ease((t - a.t) / (b.t - a.t || 1));
      return blendPose(out, a.pose, b.pose, u);
    }
  }
  const last = frames[frames.length - 1];
  return blendPose(out, last.pose, last.pose, 0);
}

/** Apply an Euler pose to the rig bones. */
export function applyPose(rig, pose) {
  for (const name in rig.bones) {
    const b = rig.bones[name];
    const p = pose[name];
    if (p) b.rotation.set(p[0], p[1], p[2]);
    else b.rotation.set(0, 0, 0);
  }
}
