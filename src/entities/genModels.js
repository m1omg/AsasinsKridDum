import * as THREE from 'three';
import { addRim } from '../render/materials.js';

// Characters generated with Higgsfield (image -> SAM 3D textured mesh) and
// converted by tools/convert_character.mjs: the mesh gets skin weights for
// the game's own skeleton layout (same bone names, identity rest rotations),
// so every procedural animation drives it unchanged. The source meshes have
// their arms out in an A-pose; the converter stores that pose as "bind"
// rotations: we bind in it, then return to the game's zero pose (arms down).
//
// File format (little endian): 'HCM1', u32 header length, JSON header, then
// 4-byte aligned arrays: f32 position xyz, i8 normal xyz, u16 uv, u8 skin
// index x4, u8 skin weight x4 (sum 255), u16/u32 triangle indices.

const bins = import.meta.glob('../../assets/models/*.bin', { eager: true, query: '?inline', import: 'default' });
const texs = import.meta.glob('../../assets/models/*.webp', { eager: true, import: 'default' });

const byName = (glob, name, ext) => {
  for (const k in glob) if (k.endsWith('/' + name + ext)) return glob[k];
  return null;
};

export function hasGenerated(name) {
  return !!byName(bins, name, '.bin') && !!byName(texs, name, '.webp');
}

function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const pad4 = (n) => (n + 3) & ~3;
const parsed = {};

function parse(name) {
  if (parsed[name]) return parsed[name];
  const bytes = dataUrlBytes(byName(bins, name, '.bin'));
  const dv = new DataView(bytes.buffer);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'HCM1') throw new Error('bad model ' + name);
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  let off = pad4(8 + hl);
  const take = (Type, count) => {
    const arr = new Type(bytes.buffer.slice(off, off + count * Type.BYTES_PER_ELEMENT));
    off = pad4(off + count * Type.BYTES_PER_ELEMENT);
    return arr;
  };
  const n = header.verts;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(take(Float32Array, n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(take(Int8Array, n * 3), 3, true));
  geo.setAttribute('uv', new THREE.BufferAttribute(take(Uint16Array, n * 2), 2, true));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(take(Uint8Array, n * 4), 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(take(Uint8Array, n * 4), 4, true));
  geo.setIndex(new THREE.BufferAttribute(take(header.index32 ? Uint32Array : Uint16Array, header.tris * 3), 1));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius *= 1.6;
  const load = (url) => {
    let done;
    const ready = new Promise((r) => (done = r));
    const t = new THREE.TextureLoader().load(url, () => done(), undefined, () => done());
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // glTF texture coordinates
    t.anisotropy = 4;
    t.userData.ready = ready;
    return t;
  };
  const tex = load(byName(texs, name, '.webp'));
  // optional glow map (<name>_e.webp): molten cracks, burning eyes
  const glowUrl = byName(texs, name, '_e.webp');
  const glow = glowUrl ? load(glowUrl) : null;
  parsed[name] = { header, geo, tex, glow };
  return parsed[name];
}

/**
 * Decode every generated model during the loading screen and wait for its
 * textures (uploaded to the GPU right away), so a demon type that first
 * appears mid-game never shows a frame without its skin.
 */
export function preloadGenerated(renderer) {
  const waits = [];
  for (const k in bins) {
    const name = k.slice(k.lastIndexOf('/') + 1, -4);
    if (!hasGenerated(name)) continue;
    const { tex, glow } = parse(name);
    for (const t of [tex, glow]) if (t) waits.push(t.userData.ready.then(() => renderer?.initTexture(t)));
  }
  return Promise.all(waits);
}

/**
 * Build a skinned character in the same shape the procedural builders return:
 * { mesh, skeleton, bones (by name), rest (bone positions), dims }.
 * opts: { roughness, metalness, rim, rimStrength, emissive, emissiveIntensity, glow }
 */
export function buildGenerated(name, opts = {}) {
  const { header, geo, tex, glow } = parse(name);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
  if (glow) { mat.glowMap = glow; mat.glowStrength = opts.glow ?? 2; }
  addRim(mat, opts.rim ?? 0x8aa6d8, opts.rimStrength ?? 0.3, 2.5);

  const bones = [];
  const named = {};
  const defs = header.bones;
  const index = new Map(defs.map((d, i) => [d.name, i]));
  for (const d of defs) {
    const b = new THREE.Bone();
    b.name = d.name;
    bones.push(b);
    named[d.name] = b;
  }
  defs.forEach((d, i) => {
    const b = bones[i];
    if (d.parent) {
      const pd = defs[index.get(d.parent)];
      b.position.set(d.pos[0] - pd.pos[0], d.pos[1] - pd.pos[1], d.pos[2] - pd.pos[2]);
      named[d.parent].add(b);
    } else b.position.set(d.pos[0], d.pos[1], d.pos[2]);
  });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  for (let i = 0; i < defs.length; i++) if (!defs[i].parent) mesh.add(bones[i]);
  // bind in the modelled pose, then return to the game's zero pose
  for (const k in header.bind) named[k]?.quaternion.set(...header.bind[k]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  for (const b of bones) b.quaternion.identity();
  mesh.updateMatrixWorld(true);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const rest = {};
  for (const b of bones) rest[b.name] = b.position.clone();
  return { mesh, skeleton, bones: named, rest, dims: { ...header.dims }, generated: true };
}
