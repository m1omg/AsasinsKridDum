import * as THREE from 'three';
import { ChunkedBuilder, MeshBuilder } from '../render/meshbuilder.js';
import { NavGrid } from './nav.js';
import { makeRng, clamp, lerp } from '../core/math.js';

// ---------------------------------------------------------------------------
// The city of Vellano: a walled Renaissance town laid out on an irregular
// street grid, with a cathedral piazza at the centre, three corrupted piazzas
// holding Hell Rifts, five viewpoint towers and a handful of enterable houses.
// Everything static is merged per chunk/material; colliders mirror the shapes.
// ---------------------------------------------------------------------------

export const CITY_HALF = 116;
export const WALL_OUT = 120;
const WALL_H = 14;
export const FLOOR_H = 3.4;
const PLINTH = 0.7;

export const ROADS = [{ c: -80, w: 6 }, { c: -40, w: 7 }, { c: 0, w: 10 }, { c: 40, w: 7 }, { c: 80, w: 6 }];
export const BLOCKS = [[-110, -83], [-77, -43.5], [-36.5, -5], [5, 36.5], [43.5, 77], [83, 110]];

export const RIFT_DEFS = [
  { id: 'west', name: 'Piazza dei Tintori', i: 1, j: 3 },
  { id: 'east', name: 'Mercato Vecchio', i: 4, j: 2 },
  { id: 'south', name: "L'Arsenale", i: 3, j: 4 },
];

// viewpoint towers: footprint centre, size, height, direction of the perch (+1/-1 on z)
const TOWER_DEFS = [
  { id: 'vp_south', name: 'Torre dei Corvi', block: [1, 4], x: -60, z: 47, size: 6, h: 30, dir: -1 },
  { id: 'vp_campanile', name: 'Campanile', x: 17, z: -11, size: 6, h: 46, dir: 1, campanile: true },
  { id: 'vp_east', name: 'Torre del Mercato', block: [5, 1], x: 96, z: -47, size: 6, h: 32, dir: 1 },
  { id: 'vp_west', name: 'Torre Vecchia', block: [0, 1], x: -96, z: -47, size: 6, h: 31, dir: 1 },
  { id: 'vp_north', name: 'Torre dei Nobili', block: [3, 0], x: 21, z: -87, size: 6, h: 33, dir: 1 },
];

const PLASTER_COLORS = [
  [0.93, 0.78, 0.55], [0.86, 0.6, 0.42], [0.95, 0.89, 0.76], [0.9, 0.68, 0.6],
  [0.94, 0.84, 0.58], [0.82, 0.55, 0.4], [0.88, 0.85, 0.8], [0.78, 0.66, 0.52], [0.92, 0.74, 0.5],
];
const SHUTTER_COLORS = [0x3d5a3a, 0x5a3a24, 0x2f5357, 0x6a2a22, 0x4a4a3a];
const FABRIC_COLORS = [[0.7, 0.12, 0.08], [0.15, 0.25, 0.5], [0.75, 0.6, 0.2], [0.25, 0.45, 0.25], [0.55, 0.15, 0.35]];
const WHITE = [1, 1, 1];

function jitterColor(rng, c, a = 0.06) {
  return [clamp(c[0] + (rng() - 0.5) * a, 0, 1), clamp(c[1] + (rng() - 0.5) * a, 0, 1), clamp(c[2] + (rng() - 0.5) * a, 0, 1)];
}

function rectsOverlap(a, b, m = 0) {
  return a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;
}

export class City {
  constructor({ scene, collision, materials, seed = 1499 }) {
    this.scene = scene;
    this.col = collision;
    this.mats = materials;
    this.rng = makeRng(seed);
    this.cb = new ChunkedBuilder(48);
    this.group = new THREE.Group();
    this.group.name = 'city';
    scene.add(this.group);

    this.buildings = [];
    this.footprints = []; // for the map: {x0,z0,x1,z1,h,kind}
    this.viewpoints = [];
    this.hayCarts = [];
    this.rifts = [];
    this.chests = [];
    this.relics = [];
    this.lights = [];
    this.fires = [];
    this.patrolLoops = [];
    this.streetPoints = [];
    this.rooftopPoints = [];
    this.interiors = [];
    this.piazzas = [];
    this.windows = { dark: [], lit: [], frames: [], sills: [] };
    this.doors = [];
    this.reserved = [];
  }

  // -------------------------------------------------------------- helpers
  B(mat, x, z) { return this.cb.get(mat, x, z); }

  solid(x0, y0, z0, x1, y1, z1, opts = {}) {
    return this.col.box(x0, y0, z0, x1, y1, z1, opts);
  }

  /** Visual + collider box. */
  block(mat, color, x0, y0, z0, x1, y1, z1, opts = {}) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    this.B(mat, cx, cz).box(x0, y0, z0, x1, y1, z1, color, opts.uv || 3, opts.faces ?? 55);
    if (opts.collide !== false) return this.solid(x0, y0, z0, x1, y1, z1, opts);
    return null;
  }

  addLight(x, y, z, color, intensity, distance, flicker = 0.25) {
    this.lights.push({ x, y, z, color, intensity, distance, flicker });
  }

  // -------------------------------------------------------------- build
  build() {
    this.makeGround();
    this.makeCityWalls();
    this.makeCathedralQuarter();
    for (const def of TOWER_DEFS) if (!def.campanile) this.reserved.push({ x0: def.x - def.size / 2 - 2.5, x1: def.x + def.size / 2 + 2.5, z0: def.z - def.size / 2 - 2.5, z1: def.z + def.size / 2 + 2.5 });
    // the hideout (player start) in the south-west block
    this.hideout = { x0: -95, z0: 87, x1: -86, z1: 96 };
    this.reserved.push({ ...this.hideout });

    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        if (i >= 2 && i <= 3 && j >= 2 && j <= 3) continue; // cathedral quarter
        const rift = RIFT_DEFS.find((r) => r.i === i && r.j === j);
        const [x0, x1] = BLOCKS[i];
        const [z0, z1] = BLOCKS[j];
        if (rift) this.makeRiftPiazza(rift, x0, z0, x1, z1);
        else this.fillBlock(x0, z0, x1, z1, i, j);
      }
    }
    for (const def of TOWER_DEFS) this.makeTower(def);
    this.makeHideout();
    this.makeBeams();
    this.makeStreetProps();
    this.makePatrols();
    this.finalize();
    return this;
  }

  // -------------------------------------------------------------- ground
  makeGround() {
    // cobbled streets inside the walls (single big quad, world UVs)
    const n = 4;
    const step = (WALL_OUT * 2) / n;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const x0 = -WALL_OUT + a * step, z0 = -WALL_OUT + b * step;
        this.B('cobble', x0 + step / 2, z0 + step / 2).ground(x0, z0, x0 + step, z0 + step, 0, [0.95, 0.92, 0.88], 3.2);
      }
    }
    // dark earth outside the walls
    const out = new THREE.Mesh(new THREE.RingGeometry(WALL_OUT, 900, 8, 1), new THREE.MeshStandardMaterial({ color: 0x1a0d09, roughness: 1 }));
    out.rotation.x = -Math.PI / 2;
    out.position.y = -0.02;
    out.receiveShadow = true;
    this.group.add(out);
    // distant burning ruins / hills ring for silhouettes beyond the walls
    const rng = this.rng;
    const hills = new MeshBuilder();
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const r = 260 + rng() * 120;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const w = 30 + rng() * 50, h = 8 + rng() * 30;
      hills.cylinder(x, z, -2, h, w, w * 0.25, 7, [0.13, 0.06, 0.05], 20, false);
    }
    const hm = new THREE.Mesh(hills.toGeometry(), new THREE.MeshStandardMaterial({ color: 0x2a1410, roughness: 1, vertexColors: true }));
    this.group.add(hm);
  }

  // -------------------------------------------------------------- walls
  makeCityWalls() {
    const stoneC = [0.62, 0.55, 0.5];
    const W0 = CITY_HALF, W1 = WALL_OUT;
    const walls = [
      [-W1, -W1, W1, -W0], // north
      [-W1, W0, W1, W1], // south
      [-W1, -W0, -W0, W0], // west
      [W0, -W0, W1, W0], // east
    ];
    for (const [x0, z0, x1, z1] of walls) {
      // split long walls into segments for chunked culling
      const alongX = x1 - x0 > z1 - z0;
      const len = alongX ? x1 - x0 : z1 - z0;
      const segs = 6;
      for (let s = 0; s < segs; s++) {
        const a0 = (alongX ? x0 : z0) + (len * s) / segs, a1 = (alongX ? x0 : z0) + (len * (s + 1)) / segs;
        if (alongX) this.block('stone', stoneC, a0, 0, z0, a1, WALL_H, z1, { kind: 'citywall', uv: 3 });
        else this.block('stone', stoneC, x0, 0, a0, x1, WALL_H, a1, { kind: 'citywall', uv: 3 });
      }
      // merlons on the outer edge + a single collider rail
      const outer = alongX ? (z0 < 0 ? z0 : z1) : (x0 < 0 ? x0 : x1);
      const sgn = alongX ? (z0 < 0 ? 1 : -1) : (x0 < 0 ? 1 : -1);
      const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1;
      for (let a = a0 + 0.6; a < a1 - 0.6; a += 2.2) {
        if (alongX) this.block('stone', stoneC, a, WALL_H, Math.min(outer, outer + sgn * 0.9), a + 1.2, WALL_H + 1.1, Math.max(outer, outer + sgn * 0.9), { collide: false, faces: 55 });
        else this.block('stone', stoneC, Math.min(outer, outer + sgn * 0.9), WALL_H, a, Math.max(outer, outer + sgn * 0.9), WALL_H + 1.1, a + 1.2, { collide: false, faces: 55 });
      }
      if (alongX) this.solid(a0, WALL_H, Math.min(outer, outer + sgn * 0.9), a1, WALL_H + 1.1, Math.max(outer, outer + sgn * 0.9), { kind: 'merlon' });
      else this.solid(Math.min(outer, outer + sgn * 0.9), WALL_H, a0, Math.max(outer, outer + sgn * 0.9), WALL_H + 1.1, a1, { kind: 'merlon' });
      // invisible boundary outside
      if (alongX) this.solid(a0 - 4, 0, z0 < 0 ? z0 - 3 : z1, a1 + 4, 120, z0 < 0 ? z0 : z1 + 3, { kind: 'bounds', climbable: false, blocksSight: false, blocksCamera: false });
      else this.solid(x0 < 0 ? x0 - 3 : x1, 0, a0 - 4, x0 < 0 ? x0 : x1 + 3, 120, a1 + 4, { kind: 'bounds', climbable: false, blocksSight: false, blocksCamera: false });
    }
    // corner towers
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * 118, cz = sz * 118;
        this.block('stone', [0.58, 0.5, 0.46], cx - 6, 0, cz - 6, cx + 6, 22, cz + 6, { kind: 'tower' });
        this.B('roof', cx, cz).pyramid(cx - 6.6, cz - 6.6, cx + 6.6, cz + 6.6, 22, 30, WHITE, 3);
        this.solid(cx - 6, 22, cz - 6, cx + 6, 23, cz + 6, { kind: 'roof' });
      }
    }
    // gate houses in the middle of each side
    const gates = [[0, -118, 'x'], [0, 118, 'x'], [-118, 0, 'z'], [118, 0, 'z']];
    for (const [gx, gz, ax] of gates) {
      const hw = 7, hd = 5;
      const [x0, x1, z0, z1] = ax === 'x' ? [gx - hw, gx + hw, gz - hd, gz + hd] : [gx - hd, gx + hd, gz - hw, gz + hw];
      this.block('stone', [0.6, 0.52, 0.47], x0, 0, z0, x1, 19, z1, { kind: 'tower' });
      this.B('roof', gx, gz).gableRoof(x0, z0, x1, z1, 19, 23, ax, WHITE, 3, 0.4, 0.2, this.B('stone', gx, gz), [0.6, 0.52, 0.47]);
      this.addRoofColliders(x0, z0, x1, z1, 19, 4, ax);
      // dark portcullis arch facing the city
      const inward = ax === 'x' ? (gz < 0 ? z1 : z0) : (gx < 0 ? x1 : x0);
      const off = ax === 'x' ? (gz < 0 ? 0.05 : -0.05) : (gx < 0 ? 0.05 : -0.05);
      if (ax === 'x') this.B('blackMetal', gx, gz).box(gx - 2.5, 0, inward + off - 0.02, gx + 2.5, 6.5, inward + off + 0.02, WHITE, 1, 55);
      else this.B('blackMetal', gx, gz).box(inward + off - 0.02, 0, gz - 2.5, inward + off + 0.02, 6.5, gz + 2.5, WHITE, 1, 55);
      this.addLight(ax === 'x' ? gx - 3.5 : inward + Math.sign(-gx) * 1, 5, ax === 'x' ? inward + Math.sign(-gz) * 1 : gz - 3.5, 0xff7a30, 2.5, 14);
      this.fires.push({ x: ax === 'x' ? gx - 3.5 : inward + Math.sign(-gx) * 0.6, y: 5, z: ax === 'x' ? inward + Math.sign(-gz) * 0.6 : gz - 3.5, size: 0.5 });
    }
    this.footprints.push({ x0: -W1, z0: -W1, x1: W1, z1: -W0, h: WALL_H, kind: 'wall' });
    this.footprints.push({ x0: -W1, z0: W0, x1: W1, z1: W1, h: WALL_H, kind: 'wall' });
    this.footprints.push({ x0: -W1, z0: -W0, x1: -W0, z1: W0, h: WALL_H, kind: 'wall' });
    this.footprints.push({ x0: W0, z0: -W0, x1: W1, z1: W0, h: WALL_H, kind: 'wall' });
  }

  addRoofColliders(x0, z0, x1, z1, H, R, axis) {
    if (axis === 'x') {
      const zm = (z0 + z1) / 2;
      this.solid(x0, H, z0, x1, H + R, zm, { kind: 'roof', slope: { axis: 'z', y0: H, y1: H + R } });
      this.solid(x0, H, zm, x1, H + R, z1, { kind: 'roof', slope: { axis: 'z', y0: H + R, y1: H } });
    } else {
      const xm = (x0 + x1) / 2;
      this.solid(x0, H, z0, xm, H + R, z1, { kind: 'roof', slope: { axis: 'x', y0: H, y1: H + R } });
      this.solid(xm, H, z0, x1, H + R, z1, { kind: 'roof', slope: { axis: 'x', y0: H + R, y1: H } });
    }
  }

  // -------------------------------------------------------------- blocks
  fillBlock(x0, z0, x1, z1, bi, bj) {
    const rng = this.rng;
    const subs = [];
    const w = x1 - x0, d = z1 - z0;
    if (rng() < 0.7) {
      if (w >= d) {
        const s = lerp(x0 + 12, x1 - 12, rng());
        subs.push([x0, z0, s - 1.6, z1], [s + 1.6, z0, x1, z1]);
      } else {
        const s = lerp(z0 + 12, z1 - 12, rng());
        subs.push([x0, z0, x1, s - 1.6], [x0, s + 1.6, x1, z1]);
      }
    } else subs.push([x0, z0, x1, z1]);
    const centerDist = Math.max(Math.abs((x0 + x1) / 2), Math.abs((z0 + z1) / 2));
    const district = { minF: centerDist < 60 ? 3 : 2, maxF: centerDist < 60 ? 5 : centerDist < 95 ? 4 : 3 };
    for (const [sx0, sz0, sx1, sz1] of subs) {
      const sw = sx1 - sx0, sd = sz1 - sz0;
      if (sw >= 24 && sd >= 24 && rng() < 0.75) this.perimeterLots(sx0, sz0, sx1, sz1, district);
      else this.rowLots(sx0, sz0, sx1, sz1, district, sw >= sd ? 'x' : 'z');
    }
    void bi; void bj;
  }

  splitLength(len, rng, minW = 6.5, maxW = 11) {
    const out = [];
    let left = len;
    while (left > maxW) {
      let wdt = lerp(minW, maxW, rng());
      if (left - wdt < minW) wdt = left / 2;
      out.push(wdt);
      left -= wdt;
    }
    out.push(left);
    return out;
  }

  rowLots(x0, z0, x1, z1, district, axis) {
    const rng = this.rng;
    const along = axis === 'x' ? x1 - x0 : z1 - z0;
    const across = axis === 'x' ? z1 - z0 : x1 - x0;
    const rows = across > 15 ? 2 : 1;
    const widths = this.splitLength(along, rng);
    for (let r = 0; r < rows; r++) {
      let a = axis === 'x' ? x0 : z0;
      const c0 = (axis === 'x' ? z0 : x0) + (across / rows) * r;
      const c1 = c0 + across / rows;
      for (const wd of widths) {
        const lot = axis === 'x' ? { x0: a, x1: a + wd, z0: c0, z1: c1 } : { x0: c0, x1: c1, z0: a, z1: a + wd };
        a += wd;
        // exposed faces: those on the sub-block boundary
        let exposed = 0;
        if (Math.abs(lot.x1 - x1) < 0.01) exposed |= 1;
        if (Math.abs(lot.x0 - x0) < 0.01) exposed |= 2;
        if (Math.abs(lot.z1 - z1) < 0.01) exposed |= 16;
        if (Math.abs(lot.z0 - z0) < 0.01) exposed |= 32;
        this.makeLot(lot, district, exposed);
      }
    }
  }

  perimeterLots(x0, z0, x1, z1, district) {
    const rng = this.rng;
    const D = 8 + rng() * 2.5;
    // north & south rows run the full width; west & east columns fill between
    const rows = [
      { x0, z0, x1, z1: z0 + D, axis: 'x', outer: 32, inner: 16 },
      { x0, z0: z1 - D, x1, z1, axis: 'x', outer: 16, inner: 32 },
      { x0, z0: z0 + D, x1: x0 + D, z1: z1 - D, axis: 'z', outer: 2, inner: 1 },
      { x0: x1 - D, z0: z0 + D, x1, z1: z1 - D, axis: 'z', outer: 1, inner: 2 },
    ];
    for (const row of rows) {
      const along = row.axis === 'x' ? row.x1 - row.x0 : row.z1 - row.z0;
      const widths = this.splitLength(along, rng);
      let a = row.axis === 'x' ? row.x0 : row.z0;
      widths.forEach((wd, k) => {
        const lot = row.axis === 'x' ? { x0: a, x1: a + wd, z0: row.z0, z1: row.z1 } : { x0: row.x0, x1: row.x1, z0: a, z1: a + wd };
        a += wd;
        let exposed = row.outer | row.inner;
        if (row.axis === 'x') {
          if (k === 0) exposed |= 2;
          if (k === widths.length - 1) exposed |= 1;
        }
        this.makeLot(lot, district, exposed, row.outer | (exposed & ~row.inner));
      });
    }
    // courtyard: a little garden reachable over the roofs
    const cx0 = x0 + D, cx1 = x1 - D, cz0 = z0 + D, cz1 = z1 - D;
    const cx = (cx0 + cx1) / 2, cz = (cz0 + cz1) / 2;
    this.B('stone', cx, cz).ground(cx0, cz0, cx1, cz1, 0.02, [0.55, 0.5, 0.45], 2.5);
    if (rng() < 0.5) this.makeTree(cx + (rng() - 0.5) * 3, cz + (rng() - 0.5) * 3);
    else this.makeWell(cx, cz);
    if (rng() < 0.55) this.chests.push({ x: cx0 + 1.2, y: 0, z: cz0 + 1.2, yaw: Math.PI * 0.25, where: 'courtyard' });
    this.hayCarts.push(this.makeHay(cx1 - 2, cz1 - 2, rng() * Math.PI));
  }

  makeLot(lot, district, exposed, outer = exposed) {
    const rng = this.rng;
    for (const r of this.reserved) if (rectsOverlap(lot, r, 0.2)) return;
    const w = lot.x1 - lot.x0, d = lot.z1 - lot.z0;
    if (w < 4 || d < 4) return;
    const floors = Math.round(lerp(district.minF, district.maxF, Math.pow(rng(), 0.9)));
    const canEnter = this.interiors.length < 18 && floors <= 3 && Math.max(w, d) >= 8 && Math.min(w, d) >= 6.5 && Math.max(w, d) <= 13 && exposed && rng() < 0.16;
    if (canEnter) this.makeEnterable(lot, floors, exposed, outer);
    else this.makeBuilding(lot, floors, exposed);
  }

  // -------------------------------------------------------------- buildings
  makeBuilding(lot, floors, exposed, opts = {}) {
    const rng = this.rng;
    const { x0, z0, x1, z1 } = lot;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const H = PLINTH + floors * FLOOR_H + (opts.extraH || 0);
    const color = opts.color || jitterColor(rng, rng.pick(PLASTER_COLORS));
    const roofType = opts.roof || (rng() < 0.58 ? 'gable' : 'flat');
    const w = x1 - x0, d = z1 - z0;

    // plinth (stone base band)
    this.B('stone', cx, cz).box(x0 - 0.06, 0, z0 - 0.06, x1 + 0.06, PLINTH, z1 + 0.06, [0.7, 0.65, 0.6], 2.5, 1 | 2 | 16 | 32);
    // main walls (top face only for flat roofs)
    this.B('plaster', cx, cz).box(x0, PLINTH, z0, x1, H, z1, color, 4, 1 | 2 | 16 | 32 | (roofType === 'flat' ? 4 : 0));
    const body = this.solid(x0, 0, z0, x1, H, z1, { kind: 'building' });
    const b = { x0, z0, x1, z1, H, floors, roof: roofType, color, exposed, collider: body, top: H };
    this.buildings.push(b);

    // cornices on exposed faces at each floor line + roof line
    for (let f = 1; f <= floors; f++) {
      const y = PLINTH + f * FLOOR_H - (f === floors ? 0.25 : 0.18);
      const big = f === floors;
      this.cornice(x0, z0, x1, z1, y, big ? 0.3 : 0.16, big ? 0.32 : 0.13, exposed, cx, cz);
    }
    // windows and doors
    this.facadeDetails(b);

    if (roofType === 'gable') {
      const axis = opts.ridge || (w >= d ? 'x' : 'z');
      const span = axis === 'x' ? d : w;
      const R = clamp(span * 0.24, 1.2, 3.2);
      this.B('roof', cx, cz).gableRoof(x0, z0, x1, z1, H, H + R, axis, jitterColor(rng, [1, 0.95, 0.92], 0.12), 2.6, 0.35, 0.16, this.B('plaster', cx, cz), color);
      this.addRoofColliders(x0, z0, x1, z1, H, R, axis);
      b.top = H + R;
      b.ridge = axis;
      b.R = R;
      if (rng() < 0.55) {
        const chx = axis === 'x' ? lerp(x0 + 1.5, x1 - 1.5, rng()) : cx + (rng() < 0.5 ? -1 : 1) * Math.min(1.2, w / 4);
        const chz = axis === 'z' ? lerp(z0 + 1.5, z1 - 1.5, rng()) : cz + (rng() < 0.5 ? -1 : 1) * Math.min(1.2, d / 4);
        this.block('stone', [0.6, 0.45, 0.38], chx - 0.35, H, chz - 0.35, chx + 0.35, H + R + 1.1, chz + 0.35, { kind: 'chimney' });
      }
      this.rooftopPoints.push({ x: cx, y: H + R, z: cz, b });
    } else {
      // terrace floor + parapets on exposed edges
      const pc = [0.72, 0.66, 0.6];
      const t = 0.28, ph = 0.65;
      const edges = [
        [1, x1 - t, z0, x1, z1], [2, x0, z0, x0 + t, z1], [16, x0, z1 - t, x1, z1], [32, x0, z0, x1, z0 + t],
      ];
      for (const [bit, ex0, ez0, ex1, ez1] of edges) {
        if (!(exposed & bit)) continue;
        this.block('plaster', color, ex0, H, ez0, ex1, H + ph, ez1, { kind: 'parapet', uv: 4, faces: 1 | 2 | 16 | 32 });
        this.B('stone', cx, cz).box(ex0 - 0.04, H + ph, ez0 - 0.04, ex1 + 0.04, H + ph + 0.1, ez1 + 0.04, pc, 2, 55);
      }
      b.top = H;
      // rooftop clutter
      if (rng() < 0.6) {
        const px = lerp(x0 + 1.2, x1 - 1.2, rng()), pz = lerp(z0 + 1.2, z1 - 1.2, rng());
        if (rng() < 0.5) this.crate(px, H, pz, 0.9);
        else this.barrel(px, H, pz);
      }
      if (rng() < 0.4) {
        const chx = lerp(x0 + 1, x1 - 1, rng()), chz = lerp(z0 + 1, z1 - 1, rng());
        this.block('stone', [0.6, 0.45, 0.38], chx - 0.35, H, chz - 0.35, chx + 0.35, H + 1.6, chz + 0.35, { kind: 'chimney' });
      }
      this.rooftopPoints.push({ x: cx, y: H, z: cz, b });
    }
    // occasional balcony on an exposed face
    if (floors >= 3 && rng() < 0.3) this.balcony(b);
    this.footprints.push({ x0, z0, x1, z1, h: b.top, kind: 'house' });
    return b;
  }

  cornice(x0, z0, x1, z1, y, h, out, exposed, cx, cz) {
    const c = [0.78, 0.72, 0.64];
    const B = this.B('stone', cx, cz);
    if (exposed & 16) B.box(x0 - (exposed & 2 ? out : 0), y, z1, x1 + (exposed & 1 ? out : 0), y + h, z1 + out, c, 2, 4 | 8 | 16 | 1 | 2);
    if (exposed & 32) B.box(x0 - (exposed & 2 ? out : 0), y, z0 - out, x1 + (exposed & 1 ? out : 0), y + h, z0, c, 2, 4 | 8 | 32 | 1 | 2);
    if (exposed & 1) B.box(x1, y, z0, x1 + out, y + h, z1, c, 2, 4 | 8 | 1);
    if (exposed & 2) B.box(x0 - out, y, z0, x0, y + h, z1, c, 2, 4 | 8 | 2);
  }

  /** Windows (instanced) on exposed faces, doors on the ground floor. */
  facadeDetails(b, skipDoor = false, openings = null) {
    const rng = this.rng;
    const faces = [
      { bit: 16, nx: 0, nz: 1, a0: b.x0, a1: b.x1, fixed: b.z1, yaw: 0 },
      { bit: 32, nx: 0, nz: -1, a0: b.x0, a1: b.x1, fixed: b.z0, yaw: Math.PI },
      { bit: 1, nx: 1, nz: 0, a0: b.z0, a1: b.z1, fixed: b.x1, yaw: Math.PI / 2 },
      { bit: 2, nx: -1, nz: 0, a0: b.z0, a1: b.z1, fixed: b.x0, yaw: -Math.PI / 2 },
    ];
    const shutter = rng.pick(SHUTTER_COLORS);
    let doorPlaced = skipDoor;
    for (const f of faces) {
      if (!(b.exposed & f.bit)) continue;
      const len = f.a1 - f.a0;
      const n = Math.max(1, Math.floor((len - 1.2) / 2.7));
      const spacing = len / n;
      for (let fl = 1; fl < b.floors; fl++) {
        const y = PLINTH + fl * FLOOR_H + 1.55;
        for (let k = 0; k < n; k++) {
          const a = f.a0 + spacing * (k + 0.5);
          if (openings && openings.some((o) => o.face === f.bit && o.floor === fl)) continue;
          const x = f.nx !== 0 ? f.fixed : a;
          const z = f.nz !== 0 ? f.fixed : a;
          const lit = rng() < 0.14;
          (lit ? this.windows.lit : this.windows.dark).push([x + f.nx * 0.03, y, z + f.nz * 0.03, f.yaw]);
          this.windows.frames.push([x + f.nx * 0.02, y, z + f.nz * 0.02, f.yaw, shutter]);
          this.windows.sills.push([x, y - 0.8, z, f.yaw]);
          if (lit && rng() < 0.3) this.addLight(x + f.nx * 1.2, y, z + f.nz * 1.2, 0xff8a3a, 0.9, 7, 0.4);
        }
      }
      // ground floor: one door per building + shop awning sometimes
      if (!doorPlaced) {
        const a = lerp(f.a0 + 1.2, f.a1 - 1.2, rng());
        const x = f.nx !== 0 ? f.fixed : a;
        const z = f.nz !== 0 ? f.fixed : a;
        this.doors.push([x + f.nx * 0.03, 0, z + f.nz * 0.03, f.yaw]);
        doorPlaced = true;
        if (rng() < 0.35) this.awning(x, z, f, len);
      }
    }
  }

  awning(x, z, f, len) {
    const rng = this.rng;
    const w = Math.min(3.2, len - 1), dep = 1.5, y0 = 3.0, y1 = 2.5;
    const c = rng.pick(FABRIC_COLORS);
    const B = this.B('fabric', x, z);
    // slanted fabric quad from the wall out over the street
    const tx = f.nz !== 0 ? 1 : 0, tz = f.nx !== 0 ? 1 : 0;
    const p0 = [x - tx * w / 2, y0, z - tz * w / 2];
    const p1 = [x + tx * w / 2, y0, z + tz * w / 2];
    const p2 = [p1[0] + f.nx * dep, y1, p1[2] + f.nz * dep];
    const p3 = [p0[0] + f.nx * dep, y1, p0[2] + f.nz * dep];
    const nrm = [f.nx * 0.3, 0.95, f.nz * 0.3];
    if (f.nz < 0 || f.nx > 0) B.quad(p0, p1, p2, p3, nrm, [0, 0, w / 2, 0, w / 2, 0.8, 0, 0.8], c);
    else B.quad(p1, p0, p3, p2, nrm, [0, 0, w / 2, 0, w / 2, 0.8, 0, 0.8], c);
    // walkable sloped collider so it can be used as a parkour step
    const minX = Math.min(p0[0], p1[0], p2[0], p3[0]), maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
    const minZ = Math.min(p0[2], p1[2], p2[2], p3[2]), maxZ = Math.max(p0[2], p1[2], p2[2], p3[2]);
    const axis = f.nx !== 0 ? 'x' : 'z';
    const rising = (f.nx > 0 || f.nz > 0) ? { y0, y1 } : { y0: y1, y1: y0 };
    this.solid(minX, y1 - 0.1, minZ, maxX, y0, maxZ, { kind: 'awning', climbable: false, slope: { axis, ...rising }, blocksSight: false, blocksCamera: false });
  }

  balcony(b) {
    const rng = this.rng;
    const faces = [16, 32, 1, 2].filter((bit) => b.exposed & bit);
    if (!faces.length) return;
    const bit = rng.pick(faces);
    const fl = 1 + Math.floor(rng() * (b.floors - 1));
    const y = PLINTH + fl * FLOOR_H;
    const w = 2.4, dep = 1.1;
    let x0, x1, z0, z1;
    if (bit === 16 || bit === 32) {
      const a = lerp(b.x0 + 1.6, b.x1 - 1.6, rng());
      x0 = a - w / 2; x1 = a + w / 2;
      if (bit === 16) { z0 = b.z1; z1 = b.z1 + dep; } else { z0 = b.z0 - dep; z1 = b.z0; }
    } else {
      const a = lerp(b.z0 + 1.6, b.z1 - 1.6, rng());
      z0 = a - w / 2; z1 = a + w / 2;
      if (bit === 1) { x0 = b.x1; x1 = b.x1 + dep; } else { x0 = b.x0 - dep; x1 = b.x0; }
    }
    this.block('stone', [0.75, 0.7, 0.62], x0, y - 0.2, z0, x1, y, z1, { kind: 'balcony', faces: 63 });
    // iron railing (visual) + low collider
    const rc = [0.25, 0.22, 0.2];
    const R = this.B('metal', (x0 + x1) / 2, (z0 + z1) / 2);
    if (bit === 16 || bit === 32) {
      const zz = bit === 16 ? z1 - 0.04 : z0 + 0.04;
      R.box(x0, y + 0.9, zz - 0.03, x1, y + 0.95, zz + 0.03, rc, 1, 55);
      for (let k = 0; k <= 8; k++) { const xx = x0 + (k / 8) * (x1 - x0); R.box(xx - 0.02, y, zz - 0.02, xx + 0.02, y + 0.9, zz + 0.02, rc, 1, 1 | 2 | 16 | 32); }
      this.solid(x0, y, zz - 0.05, x1, y + 0.95, zz + 0.05, { kind: 'railing', climbable: false, blocksSight: false, blocksCamera: false });
    } else {
      const xx = bit === 1 ? x1 - 0.04 : x0 + 0.04;
      R.box(xx - 0.03, y + 0.9, z0, xx + 0.03, y + 0.95, z1, rc, 1, 55);
      for (let k = 0; k <= 8; k++) { const zz = z0 + (k / 8) * (z1 - z0); R.box(xx - 0.02, y, zz - 0.02, xx + 0.02, y + 0.9, zz + 0.02, rc, 1, 1 | 2 | 16 | 32); }
      this.solid(xx - 0.05, y, z0, xx + 0.05, y + 0.95, z1, { kind: 'railing', climbable: false, blocksSight: false, blocksCamera: false });
    }
  }

  // -------------------------------------------------------------- interiors
  /**
   * Hollow house: thick outer walls with a door and real window openings,
   * wooden floors with switchback stairs and a roof hatch to the terrace.
   */
  makeEnterable(lot, floors, exposed, outer = exposed) {
    const rng = this.rng;
    const { x0, z0, x1, z1 } = lot;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const t = 0.35;
    const FH = FLOOR_H;
    const topY = floors * FH;
    const H = topY + 0.25;
    const color = jitterColor(rng, rng.pick(PLASTER_COLORS));
    const innerColor = [0.85, 0.8, 0.72];
    const stairAxis = x1 - x0 >= z1 - z0 ? 'x' : 'z';
    const L = 4.9; // stair run per floor
    const laneW = 1.15;

    // door face: first exposed face; window openings on exposed faces
    const faceBits = [16, 32, 1, 2].filter((bit) => exposed & bit);
    const doorBit = faceBits.find((bit) => outer & bit) || faceBits[0];
    const openings = []; // {face, a0, a1, y0, y1}
    const faceInfo = {
      16: { axis: 'x', fixed: z1, lo: x0, hi: x1, inward: -1 },
      32: { axis: 'x', fixed: z0, lo: x0, hi: x1, inward: 1 },
      1: { axis: 'z', fixed: x1, lo: z0, hi: z1, inward: -1 },
      2: { axis: 'z', fixed: x0, lo: z0, hi: z1, inward: 1 },
    };
    // stairs run along the wall opposite the door (or away from it)
    const di = faceInfo[doorBit];
    const doorOnLo = (doorBit === 32 && stairAxis === 'x') || (doorBit === 2 && stairAxis === 'z');
    const crossHiSide = doorOnLo;
    const doorA = di.axis === stairAxis
      ? lerp(di.lo, di.hi, 0.72)
      : (di.lo + di.hi) / 2 + (crossHiSide ? -1 : 1) * (di.hi - di.lo) * 0.18;
    openings.push({ face: doorBit, a0: doorA - 0.85, a1: doorA + 0.85, y0: 0, y1: 2.6, door: true });
    const winMarks = [];
    for (const bit of faceBits) {
      const fi = faceInfo[bit];
      const len = fi.hi - fi.lo;
      for (let fl = 1; fl < floors; fl++) {
        const n = len > 9 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const a = fi.lo + len * ((k + 0.5) / n);
          openings.push({ face: bit, a0: a - 0.62, a1: a + 0.62, y0: fl * FH + 0.8, y1: fl * FH + 2.55 });
          winMarks.push({ face: bit, a, floor: fl });
        }
      }
    }

    // outer walls with openings
    const wallSpecs = [
      { bit: 32, axis: 'x', a0: x0, a1: x1, c0: z0, c1: z0 + t },
      { bit: 16, axis: 'x', a0: x0, a1: x1, c0: z1 - t, c1: z1 },
      { bit: 2, axis: 'z', a0: z0 + t, a1: z1 - t, c0: x0, c1: x0 + t },
      { bit: 1, axis: 'z', a0: z0 + t, a1: z1 - t, c0: x1 - t, c1: x1 },
    ];
    for (const ws of wallSpecs) {
      const ops = openings.filter((o) => o.face === ws.bit).sort((a, b) => a.a0 - b.a0);
      this.wallWithOpenings(ws, 0, H, ops, color, cx, cz);
    }
    // plinth band + cornice outside
    this.B('stone', cx, cz).box(x0 - 0.06, 0, z0 - 0.06, x1 + 0.06, 0.5, z1 + 0.06, [0.7, 0.65, 0.6], 2.5, 1 | 2 | 16 | 32);
    this.cornice(x0, z0, x1, z1, H - 0.2, 0.3, 0.3, exposed, cx, cz);

    // stairs
    const lanes = [];
    const s0 = (stairAxis === 'x' ? x0 : z0) + t + 0.6;
    const c0 = stairAxis === 'x' ? z0 : x0, c1 = stairAxis === 'x' ? z1 : x1;
    if (!crossHiSide) lanes.push([c0 + t, c0 + t + laneW], [c0 + t + laneW, c0 + t + 2 * laneW]);
    else lanes.push([c1 - t - laneW, c1 - t], [c1 - t - 2 * laneW, c1 - t - laneW]);
    const wood = [0.75, 0.6, 0.48];
    for (let k = 0; k < floors; k++) {
      const lane = lanes[k % 2];
      const up = k % 2 === 0; // even flights rise toward +axis
      const ya = k * FH, yb = (k + 1) * FH;
      const steps = 14;
      for (let s = 0; s < steps; s++) {
        const u0 = s / steps, u1 = (s + 1) / steps;
        const a0 = up ? s0 + L * u0 : s0 + L * (1 - u1);
        const a1 = up ? s0 + L * u1 : s0 + L * (1 - u0);
        const y = ya + (yb - ya) * (s + 1) / steps;
        if (stairAxis === 'x') this.B('wood', cx, cz).box(a0, y - 0.18, lane[0], a1, y, lane[1], wood, 2, 55);
        else this.B('wood', cx, cz).box(lane[0], y - 0.18, a0, lane[1], y, a1, wood, 2, 55);
      }
      const slope = { axis: stairAxis, y0: up ? ya : yb, y1: up ? yb : ya };
      if (stairAxis === 'x') this.solid(s0, ya, lane[0], s0 + L, yb, lane[1], { kind: 'stairs', slope, climbable: false });
      else this.solid(lane[0], ya, s0, lane[1], yb, s0 + L, { kind: 'stairs', slope, climbable: false });
    }

    // floor slabs (with stair holes) and the roof slab with a hatch
    for (let k = 1; k <= floors; k++) {
      const y = k * FH;
      const lane = lanes[(k - 1) % 2];
      const up = (k - 1) % 2 === 0;
      const hole = stairAxis === 'x'
        ? { x0: up ? s0 + L * 0.3 : s0, x1: up ? s0 + L : s0 + L * 0.7, z0: lane[0], z1: lane[1] }
        : { x0: lane[0], x1: lane[1], z0: up ? s0 + L * 0.3 : s0, z1: up ? s0 + L : s0 + L * 0.7 };
      this.slabWithHole(x0 + t, z0 + t, x1 - t, z1 - t, y - 0.25, y, hole, k === floors, cx, cz);
    }
    // ground floor wooden boards
    this.B('wood', cx, cz).ground(x0 + t, z0 + t, x1 - t, z1 - t, 0.02, [0.6, 0.48, 0.38], 2);

    // parapet on the terrace
    const ph = 0.7;
    for (const [bit, ex0, ez0, ex1, ez1] of [[1, x1 - t, z0, x1, z1], [2, x0, z0, x0 + t, z1], [16, x0, z1 - t, x1, z1], [32, x0, z0, x1, z0 + t]]) {
      this.block('plaster', color, ex0, H, ez0, ex1, H + ph, ez1, { kind: 'parapet', uv: 4, faces: 1 | 2 | 16 | 32 });
      this.B('stone', cx, cz).box(ex0 - 0.04, H + ph, ez0 - 0.04, ex1 + 0.04, H + ph + 0.1, ez1 + 0.04, [0.72, 0.66, 0.6], 2, 55);
      void bit;
    }

    // furniture + candle light per floor
    const crossLo = crossHiSide ? c0 + t + 0.4 : c0 + t + 2 * laneW + 0.3;
    const crossHi = crossHiSide ? c1 - t - 2 * laneW - 0.3 : c1 - t - 0.4;
    for (let k = 0; k < floors; k++) {
      const y = k * FH + (k === 0 ? 0.02 : 0);
      if (crossHi - crossLo > 1.6) {
        const a = lerp(stairAxis === 'x' ? x0 + t + 1.2 : z0 + t + 1.2, stairAxis === 'x' ? x1 - t - 1.2 : z1 - t - 1.2, rng());
        const c = lerp(crossLo + 0.6, crossHi - 0.6, rng());
        const [tx, tz] = stairAxis === 'x' ? [a, c] : [c, a];
        this.table(tx, y, tz);
        this.addLight(tx, y + 1.3, tz, 0xffa050, 1.2, 8, 0.35);
        this.fires.push({ x: tx, y: y + 0.98, z: tz, size: 0.08, candle: true });
      }
      if (k >= 1 && k < floors - 1 && crossHi - crossLo > 1.2) {
        const freeC = crossHiSide ? crossLo + 0.3 : crossHi - 0.3;
        const [bx, bz] = stairAxis === 'x' ? [x1 - t - 0.6, freeC] : [freeC, z1 - t - 0.6];
        this.barrel(bx, y, bz);
      }
    }
    // a chest on the top floor
    const [chx, chz] = stairAxis === 'x' ? [x1 - t - 0.8, lerp(crossLo, crossHi, 0.5)] : [lerp(crossLo, crossHi, 0.5), z1 - t - 0.8];
    this.chests.push({ x: chx, y: (floors - 1) * FH, z: chz, yaw: stairAxis === 'x' ? -Math.PI / 2 : Math.PI, where: 'house' });

    const b = { x0, z0, x1, z1, H, floors, roof: 'flat', color, exposed, top: H, enterable: true };
    this.buildings.push(b);
    this.interiors.push({ ...lot, floors, door: { face: doorBit, a: doorA } });
    this.facadeDetails(b, true, winMarks);
    this.footprints.push({ x0, z0, x1, z1, h: H, kind: 'house', enterable: true });
    // door frame
    const dfi = faceInfo[doorBit];
    if (dfi.axis === 'x') this.B('stone', cx, cz).box(doorA - 1.0, 2.6, dfi.fixed - 0.1, doorA + 1.0, 2.95, dfi.fixed + 0.1, [0.75, 0.7, 0.62], 2, 55);
    else this.B('stone', cx, cz).box(dfi.fixed - 0.1, 2.6, doorA - 1.0, dfi.fixed + 0.1, 2.95, doorA + 1.0, [0.75, 0.7, 0.62], 2, 55);
  }

  wallWithOpenings(ws, y0, y1, ops, color, cx, cz) {
    const raw = [ws.a0, ws.a1];
    for (const o of ops) raw.push(Math.max(ws.a0, Math.min(ws.a1, o.a0)), Math.max(ws.a0, Math.min(ws.a1, o.a1)));
    raw.sort((a, b) => a - b);
    const pts = raw.filter((v, i) => i === 0 || v - raw[i - 1] > 1e-4);
    const box = (a0, a1, ya, yb) => {
      if (a1 - a0 < 0.01 || yb - ya < 0.01) return;
      if (ws.axis === 'x') this.block('plaster', color, a0, ya, ws.c0, a1, yb, ws.c1, { kind: 'building', uv: 4, faces: 63 });
      else this.block('plaster', color, ws.c0, ya, a0, ws.c1, yb, a1, { kind: 'building', uv: 4, faces: 63 });
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const a0 = pts[i], a1 = pts[i + 1];
      if (a1 <= a0) continue;
      const cover = ops.filter((op) => op.a0 <= a0 + 1e-6 && op.a1 >= a1 - 1e-6).sort((a, b) => a.y0 - b.y0);
      let y = y0;
      for (const o of cover) {
        box(a0, a1, y, o.y0);
        y = Math.max(y, o.y1);
      }
      box(a0, a1, y, y1);
    }
    void cx; void cz;
  }

  slabWithHole(x0, z0, x1, z1, ya, yb, h, isRoof, cx, cz) {
    const parts = [
      [x0, z0, h.x0, z1],
      [h.x1, z0, x1, z1],
      [h.x0, z0, h.x1, h.z0],
      [h.x0, h.z1, h.x1, z1],
    ];
    for (const [a, b, c, d] of parts) {
      if (c - a < 0.01 || d - b < 0.01) continue;
      this.solid(a, ya, b, c, yb, d, { kind: isRoof ? 'roof' : 'floor', climbable: false });
      this.B(isRoof ? 'stone' : 'wood', cx, cz).box(a, ya, b, c, yb, d, isRoof ? [0.62, 0.58, 0.54] : [0.62, 0.5, 0.4], 2, 4 | 8);
    }
  }

  table(x, y, z) {
    const B = this.B('wood', x, z);
    const c = [0.55, 0.42, 0.32];
    B.box(x - 0.8, y + 0.78, z - 0.5, x + 0.8, y + 0.86, z + 0.5, c, 1.5, 63);
    for (const [dx, dz] of [[-0.7, -0.4], [0.7, -0.4], [-0.7, 0.4], [0.7, 0.4]]) B.box(x + dx - 0.05, y, z + dz - 0.05, x + dx + 0.05, y + 0.78, z + dz + 0.05, c, 1.5, 1 | 2 | 16 | 32);
    this.solid(x - 0.8, y, z - 0.5, x + 0.8, y + 0.86, z + 0.5, { kind: 'furniture', blocksSight: false });
    // candle
    this.B('ember', x, z).cylinder(x + 0.2, z, y + 0.86, y + 0.98, 0.03, 0.03, 6, [1, 1, 1], 1, true);
  }

  // -------------------------------------------------------------- props
  crate(x, y, z, s = 1) {
    const rng = this.rng;
    const c = jitterColor(rng, [0.7, 0.58, 0.45], 0.1);
    const yaw = 0;
    void yaw;
    return this.block('wood', c, x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, { kind: 'crate', uv: 1.5, faces: 63 });
  }

  barrel(x, y, z) {
    const B = this.B('wood', x, z);
    B.cylinder(x, z, y, y + 1.0, 0.38, 0.38, 10, [0.55, 0.42, 0.3], 1.2, true);
    this.B('metal', x, z).cylinder(x, z, y + 0.2, y + 0.26, 0.4, 0.4, 10, [0.4, 0.38, 0.35], 1, false);
    this.B('metal', x, z).cylinder(x, z, y + 0.74, y + 0.8, 0.4, 0.4, 10, [0.4, 0.38, 0.35], 1, false);
    this.solid(x - 0.38, y, z - 0.38, x + 0.38, y + 1.0, z + 0.38, { kind: 'barrel', blocksSight: false });
  }

  makeHay(x, z, yaw) {
    const B = this.B('wood', x, z);
    const H = this.B('hay', x, z);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // axis-aligned approximation (choose dominant axis for the collider)
    const alongX = Math.abs(c) > Math.abs(s);
    const hx = alongX ? 1.3 : 0.75, hz = alongX ? 0.75 : 1.3;
    B.box(x - hx, 0.45, z - hz, x + hx, 0.7, z + hz, [0.55, 0.42, 0.3], 1.5, 63);
    B.box(x - hx, 0.7, z - hz, x + hx, 1.0, z - hz + 0.08, [0.5, 0.38, 0.28], 1.5, 63);
    B.box(x - hx, 0.7, z + hz - 0.08, x + hx, 1.0, z + hz, [0.5, 0.38, 0.28], 1.5, 63);
    // wheels
    const W = this.B('wood', x, z);
    const wheel = (wx, wz) => {
      const geo = new THREE.CylinderGeometry(0.45, 0.45, 0.12, 12);
      const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(alongX ? Math.PI / 2 : 0, 0, alongX ? 0 : Math.PI / 2));
      m.setPosition(wx, 0.45, wz);
      W.addGeometry(geo, m, [0.4, 0.3, 0.22]);
    };
    if (alongX) { wheel(x - 0.6, z - hz - 0.08); wheel(x - 0.6, z + hz + 0.08); }
    else { wheel(x - hx - 0.08, z - 0.6); wheel(x + hx + 0.08, z - 0.6); }
    // hay mound
    const geo = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0.7, z), new THREE.Quaternion(), new THREE.Vector3(hx * 0.95, 0.75, hz * 0.95));
    H.addGeometry(geo, m, [1, 0.92, 0.75]);
    const col = this.solid(x - hx, 0, z - hz, x + hx, 0.7, z + hz, { kind: 'haycart', blocksSight: false, blocksCamera: false });
    const hay = { x, z, yaw, hx, hz, collider: col, top: 0.7 };
    this.footprints.push({ x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz, h: 1, kind: 'hay' });
    return hay;
  }

  makeWell(x, z) {
    this.B('stone', x, z).cylinder(x, z, 0, 0.9, 1.1, 1.1, 14, [0.65, 0.6, 0.55], 2, false);
    this.B('windowDark', x, z).cylinder(x, z, 0.85, 0.86, 0.95, 0.95, 14, [1, 1, 1], 2, true);
    const W = this.B('wood', x, z);
    W.box(x - 1.0, 0.9, z - 0.08, x - 0.85, 2.6, z + 0.08, [0.5, 0.38, 0.28], 1, 55);
    W.box(x + 0.85, 0.9, z - 0.08, x + 1.0, 2.6, z + 0.08, [0.5, 0.38, 0.28], 1, 55);
    W.box(x - 1.1, 2.5, z - 0.1, x + 1.1, 2.7, z + 0.1, [0.5, 0.38, 0.28], 1, 63);
    this.solid(x - 1.1, 0, z - 1.1, x + 1.1, 0.9, z + 1.1, { kind: 'well', blocksSight: false });
  }

  makeTree(x, z) {
    const rng = this.rng;
    const W = this.B('wood', x, z);
    const c = [0.32, 0.24, 0.2];
    W.cylinder(x, z, 0, 4.5, 0.32, 0.18, 8, c, 1, false);
    for (let k = 0; k < 6; k++) {
      const a = rng() * Math.PI * 2, y = 2.6 + rng() * 1.8, l = 1.4 + rng() * 1.6;
      const geo = new THREE.CylinderGeometry(0.03, 0.11, l, 5);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x + Math.cos(a) * l * 0.4, y + l * 0.35, z + Math.sin(a) * l * 0.4),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9)),
        new THREE.Vector3(1, 1, 1),
      );
      W.addGeometry(geo, m, c);
    }
    this.solid(x - 0.35, 0, z - 0.35, x + 0.35, 4.5, z + 0.35, { kind: 'tree' });
  }

  brazier(x, z, y = 0) {
    const M = this.B('metal', x, z);
    M.cylinder(x, z, y, y + 1.0, 0.08, 0.08, 6, [0.3, 0.28, 0.26], 1, false);
    M.cylinder(x, z, y + 1.0, y + 1.35, 0.25, 0.5, 10, [0.3, 0.28, 0.26], 1, false);
    this.B('ember', x, z).cylinder(x, z, y + 1.25, y + 1.3, 0.45, 0.45, 10, [1, 1, 1], 1, true);
    this.solid(x - 0.4, y, z - 0.4, x + 0.4, y + 1.35, z + 0.4, { kind: 'brazier', blocksSight: false });
    this.addLight(x, y + 2.0, z, 0xff7a30, 3.0, 16, 0.3);
    this.fires.push({ x, y: y + 1.35, z, size: 0.55 });
  }

  stall(x, z, alongX) {
    const rng = this.rng;
    const c = rng.pick(FABRIC_COLORS);
    const W = this.B('wood', x, z);
    const wc = [0.5, 0.38, 0.28];
    const hx = alongX ? 1.5 : 1.0, hz = alongX ? 1.0 : 1.5;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      W.box(x + sx * hx - 0.07, 0, z + sz * hz - 0.07, x + sx * hx + 0.07, 2.4, z + sz * hz + 0.07, wc, 1, 1 | 2 | 16 | 32);
    }
    W.box(x - hx, 0, z - hz * 0.6, x + hx, 0.95, z + hz * 0.6, wc, 1.5, 63);
    this.solid(x - hx, 0, z - hz * 0.6, x + hx, 0.95, z + hz * 0.6, { kind: 'stall', blocksSight: false });
    // tilted fabric roof (walkable slope)
    const F = this.B('fabric', x, z);
    if (alongX) {
      F.quad([x - hx - 0.2, 2.2, z + hz + 0.3], [x + hx + 0.2, 2.2, z + hz + 0.3], [x + hx + 0.2, 2.75, z - hz - 0.3], [x - hx - 0.2, 2.75, z - hz - 0.3], [0, 0.97, 0.24], [0, 0, 2, 0, 2, 1.5, 0, 1.5], c);
      this.solid(x - hx - 0.2, 2.1, z - hz - 0.3, x + hx + 0.2, 2.75, z + hz + 0.3, { kind: 'awning', climbable: false, slope: { axis: 'z', y0: 2.75, y1: 2.2 }, blocksSight: false, blocksCamera: false });
    } else {
      F.quad([x + hx + 0.3, 2.2, z + hz + 0.2], [x + hx + 0.3, 2.2, z - hz - 0.2], [x - hx - 0.3, 2.75, z - hz - 0.2], [x - hx - 0.3, 2.75, z + hz + 0.2], [0.24, 0.97, 0], [0, 0, 2, 0, 2, 1.5, 0, 1.5], c);
      this.solid(x - hx - 0.3, 2.1, z - hz - 0.2, x + hx + 0.3, 2.75, z + hz + 0.2, { kind: 'awning', climbable: false, slope: { axis: 'x', y0: 2.75, y1: 2.2 }, blocksSight: false, blocksCamera: false });
    }
    // goods on the counter
    for (let k = 0; k < 3; k++) {
      const gx = x + (alongX ? (k - 1) * 0.8 : 0), gz = z + (alongX ? 0 : (k - 1) * 0.8);
      this.B('fabric', gx, gz).box(gx - 0.25, 0.95, gz - 0.2, gx + 0.25, 1.2, gz + 0.2, rng.pick(FABRIC_COLORS), 1, 55);
    }
  }

  // -------------------------------------------------------------- landmarks
  makeTower(def) {
    const s = def.size / 2;
    const { x, z, h } = def;
    const x0 = x - s, x1 = x + s, z0 = z - s, z1 = z + s;
    const stoneC = def.campanile ? [0.86, 0.8, 0.72] : [0.66, 0.58, 0.5];
    if (!def.campanile) {
      this.block('stone', stoneC, x0, 0, z0, x1, h, z1, { kind: 'tower', uv: 3 });
    } else {
      // banded marble campanile
      const bands = 6;
      for (let k = 0; k < bands; k++) {
        const ya = (h / bands) * k, yb = (h / bands) * (k + 1);
        const c = k % 2 === 0 ? [0.9, 0.86, 0.8] : [0.62, 0.7, 0.62];
        this.block('stone', c, x0, ya, z0, x1, yb, z1, { kind: 'tower', uv: 2.5 });
      }
    }
    // ledges every 5m (visual climbing cues)
    for (let y = 5; y < h - 1; y += 5) {
      this.B('stone', x, z).box(x0 - 0.2, y, z0 - 0.2, x1 + 0.2, y + 0.22, z1 + 0.2, [0.75, 0.7, 0.62], 2, 63);
    }
    // crown: parapet + pyramid roof on corner pillars
    const ph = 1.0, roofBase = h + 3.2;
    for (const [ex0, ez0, ex1, ez1] of [[x0, z0, x1, z0 + 0.3], [x0, z1 - 0.3, x1, z1], [x0, z0 + 0.3, x0 + 0.3, z1 - 0.3], [x1 - 0.3, z0 + 0.3, x1, z1 - 0.3]]) {
      this.block('stone', stoneC, ex0, h, ez0, ex1, h + ph, ez1, { kind: 'parapet', uv: 2 });
    }
    for (const [px, pz] of [[x0, z0], [x1 - 0.5, z0], [x0, z1 - 0.5], [x1 - 0.5, z1 - 0.5]]) {
      this.block('stone', stoneC, px, h + ph, pz, px + 0.5, roofBase, pz + 0.5, { kind: 'pillar', uv: 2 });
    }
    this.B('roof', x, z).pyramid(x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5, roofBase, roofBase + (def.campanile ? 9 : 5), WHITE, 2.5);
    this.solid(x0 - 0.5, roofBase, z0 - 0.5, x1 + 0.5, roofBase + 0.6, z1 + 0.5, { kind: 'roof', climbable: false });
    // the perch: a wooden beam sticking out over the street
    const beamLen = 2.6;
    const pz0 = def.dir > 0 ? z1 - 0.3 : z0 - beamLen;
    const pz1 = def.dir > 0 ? z1 + beamLen : z0 + 0.3;
    this.block('wood', [0.55, 0.42, 0.3], x - 0.18, h + ph - 0.3, pz0, x + 0.18, h + ph, pz1, { kind: 'beam', climbable: false, uv: 1.5, faces: 63 });
    const perch = { x, y: h + ph, z: def.dir > 0 ? z1 + beamLen - 0.35 : z0 - beamLen + 0.35 };
    // hay cart for the leap of faith
    const hay = this.makeHay(x, def.dir > 0 ? z1 + 5 : z0 - 5, Math.PI / 2);
    hay.leap = true;
    this.hayCarts.push(hay);
    this.viewpoints.push({ id: def.id, name: def.name, x, z, h, perch, hay, dir: def.dir, synced: false });
    this.footprints.push({ x0, z0, x1, z1, h, kind: 'tower' });
    // torches on the tower
    this.addLight(x, h + 2, z + def.dir * (s + 0.6), 0xff8040, 2.2, 14, 0.3);
    this.fires.push({ x: x + 0.8, y: h + ph + 0.3, z: z + def.dir * (s + 0.15), size: 0.25 });
  }

  makeCathedralQuarter() {
    const marble = [0.92, 0.88, 0.8];
    const green = [0.55, 0.64, 0.56];
    // piazza paving
    this.B('stone', 0, 18).ground(-36.5, -1, 36.5, 36.5, 0.02, [0.7, 0.65, 0.6], 4);
    this.B('stone', 0, -20).ground(-36.5, -36.5, 36.5, -1, 0.02, [0.62, 0.58, 0.54], 4);
    this.piazzas.push({ name: 'Piazza del Duomo', x0: -36.5, z0: -1, x1: 36.5, z1: 36.5, center: { x: 0, z: 18 } });

    // nave (runs north-south), facade faces south at z = -6
    const naveH = 22;
    this.block('stone', marble, -10, 0, -36, 10, naveH, -6, { kind: 'cathedral', uv: 3 });
    this.B('roof', 0, -21).gableRoof(-10, -36, 10, -6, naveH, naveH + 6, 'z', WHITE, 3, 0.4, 0.2, this.B('stone', 0, -21), marble);
    this.addRoofColliders(-10, -36, 10, -6, naveH, 6, 'z');
    // aisles
    for (const sx of [-1, 1]) {
      const ax0 = sx < 0 ? -16 : 10, ax1 = sx < 0 ? -10 : 16;
      this.block('stone', green, ax0, 0, -33, ax1, 13, -8, { kind: 'cathedral', uv: 3 });
      // lean-to roof rising toward the nave
      const slope = sx < 0 ? { axis: 'x', y0: 13, y1: 16 } : { axis: 'x', y0: 16, y1: 13 };
      this.solid(ax0, 13, -33, ax1, 16, -8, { kind: 'roof', slope });
      const R = this.B('roof', sx * 13, -20);
      if (sx < 0) R.quad([ax0 - 0.3, 12.9, -7.7], [ax1, 16, -7.7], [ax1, 16, -33.3], [ax0 - 0.3, 12.9, -33.3], [-0.45, 0.89, 0], [0, 0, 2, 0, 2, 8, 0, 8], WHITE);
      else R.quad([ax0, 16, -7.7], [ax1 + 0.3, 12.9, -7.7], [ax1 + 0.3, 12.9, -33.3], [ax0, 16, -33.3], [0.45, 0.89, 0], [0, 0, 2, 0, 2, 8, 0, 8], WHITE);
    }
    // transept
    this.block('stone', marble, -21, 0, -29, 21, naveH, -17, { kind: 'cathedral', uv: 3 });
    this.B('roof', 0, -23).gableRoof(-21, -29, 21, -17, naveH, naveH + 5, 'x', WHITE, 3, 0.4, 0.2, this.B('stone', 0, -23), marble);
    this.addRoofColliders(-21, -29, -10, -17, naveH, 5, 'x');
    this.addRoofColliders(10, -29, 21, -17, naveH, 5, 'x');
    // dome over the crossing: octagonal drum + stepped colliders
    const dx = 0, dz = -23;
    this.B('stone', dx, dz).cylinder(dx, dz, naveH, naveH + 6, 9.2, 9.2, 8, marble, 3, false);
    this.solid(-8.5, naveH, dz - 8.5, 8.5, naveH + 6, dz + 8.5, { kind: 'dome' });
    this.B('roof', dx, dz).dome(dx, naveH + 6, dz, 9.2, 24, 10, [0.95, 0.75, 0.65], 3, 1.15);
    const steps = 5;
    for (let k = 0; k < steps; k++) {
      const phi0 = (k / steps) * Math.PI / 2;
      const r = 9.2 * Math.cos(phi0) * 0.92;
      const ytop = naveH + 6 + 9.2 * 1.15 * Math.sin(((k + 1) / steps) * Math.PI / 2);
      this.solid(dx - r, naveH + 6, dz - r, dx + r, ytop, dz + r, { kind: 'dome' });
    }
    // lantern on top
    const ly = naveH + 6 + 9.2 * 1.15;
    this.B('stone', dx, dz).cylinder(dx, dz, ly - 0.3, ly + 3, 1.6, 1.6, 8, marble, 2, true);
    this.B('gold', dx, dz).cylinder(dx, dz, ly + 3, ly + 5.5, 1.7, 0.05, 8, WHITE, 2, false);
    this.solid(dx - 1.6, ly - 0.3, dz - 1.6, dx + 1.6, ly + 3, dz + 1.6, { kind: 'lantern' });
    this.relics.push({ x: dx, y: ly + 3.6, z: dz });

    // grand facade
    this.block('stone', marble, -12, 0, -6.8, 12, 27, -6, { kind: 'cathedral', uv: 3 });
    this.B('stone', 0, -6).box(-12.5, 27, -6.9, 12.5, 27.6, -5.9, [0.8, 0.75, 0.68], 3, 63);
    // pediment triangle
    this.B('stone', 0, -6).tri([-12, 27.6, -5.95], [12, 27.6, -5.95], [0, 33, -5.95], [0, 0, 1], [0, 0, 8, 0, 4, 2], marble);
    this.solid(-8, 27.6, -6.8, 8, 30.5, -6, { kind: 'cathedral' });
    // rose window + portal (glowing, the rift light pours out)
    const rose = new MeshBuilder();
    rose.cylinder(0, 0, -0.15, 0.15, 3.2, 3.2, 24, [1, 1, 1], 1, true);
    const roseMesh = new THREE.Mesh(rose.toGeometry(), new THREE.MeshBasicMaterial({ color: 0xff3a1a, toneMapped: false }));
    roseMesh.rotation.x = Math.PI / 2;
    roseMesh.position.set(0, 19, -5.98);
    this.group.add(roseMesh);
    this.roseWindow = roseMesh;
    this.B('windowDark', 0, -6).box(-3, 0, -5.98, 3, 7.5, -5.9, WHITE, 1, 16);
    this.cathedralDoor = { x: 0, z: -5.5 };
    // steps
    for (let k = 0; k < 3; k++) {
      const z0 = -6 + k * 1.0;
      this.block('stone', [0.82, 0.78, 0.72], -14, 0, z0, 14, 0.9 - k * 0.3, z0 + 1.0, { kind: 'steps', uv: 2 });
    }
    // facade side pilasters
    for (const px of [-11.5, -6, 6, 11.5]) this.block('stone', [0.8, 0.76, 0.7], px - 0.5, 0, -6.2, px + 0.5, 26, -5.6, { kind: 'pilaster', uv: 2 });
    this.footprints.push({ x0: -10, z0: -36, x1: 10, z1: -6, h: naveH + 6, kind: 'cathedral' });
    this.footprints.push({ x0: -21, z0: -29, x1: 21, z1: -17, h: naveH + 5, kind: 'cathedral' });
    this.footprints.push({ x0: -16, z0: -33, x1: 16, z1: -8, h: 13, kind: 'cathedral' });

    // loggia on the west side of the piazza: arcade with a walkable roof
    const lx0 = -35, lx1 = -28, lz0 = 4, lz1 = 30;
    for (let zc = lz0; zc <= lz1 + 0.01; zc += 3.25) {
      this.block('stone', marble, lx1 - 0.7, 0, zc - 0.35, lx1, 6, zc + 0.35, { kind: 'column', uv: 2 });
    }
    this.block('stone', marble, lx0, 0, lz0 - 0.35, lx1, 6, lz1 + 0.35, { kind: 'building', uv: 3, collide: false, faces: 2 | 16 | 32 });
    this.solid(lx0, 0, lz0 - 0.35, lx0 + 0.6, 6, lz1 + 0.35, { kind: 'building' });
    this.block('stone', marble, lx0, 6, lz0 - 0.35, lx1, 7.2, lz1 + 0.35, { kind: 'building', uv: 3 });
    this.B('roof', -31.5, 17).gableRoof(lx0, lz0 - 0.35, lx1, lz1 + 0.35, 7.2, 9.0, 'z', WHITE, 2.6, 0.4, 0.16, this.B('stone', -31.5, 17), marble);
    this.addRoofColliders(lx0, lz0 - 0.35, lx1, lz1 + 0.35, 7.2, 1.8, 'z');
    this.footprints.push({ x0: lx0, z0: lz0, x1: lx1, z1: lz1, h: 9, kind: 'house' });
    this.chests.push({ x: lx0 + 2.0, y: 0, z: lz1 - 1.5, yaw: Math.PI / 2, where: 'loggia' });

    // palazzo on the east side (tall, flat roof, good vantage over the arena)
    this.makeBuilding({ x0: 27, z0: 3, x1: 36.5, z1: 16 }, 4, 2 | 16 | 32, { roof: 'flat', color: [0.85, 0.6, 0.45] });
    this.makeBuilding({ x0: 27, z0: 20, x1: 36.5, z1: 33 }, 3, 2 | 16 | 32, { roof: 'gable', color: [0.92, 0.82, 0.62], ridge: 'z' });
    // cloister buildings north-west and north-east of the cathedral
    this.makeBuilding({ x0: -36.5, z0: -36.5, x1: -22, z1: -31 }, 3, 1 | 2 | 16 | 32, { roof: 'gable', color: [0.85, 0.75, 0.6] });
    this.makeBuilding({ x0: 24, z0: -36.5, x1: 36.5, z1: -28 }, 3, 1 | 2 | 16 | 32, { roof: 'gable', color: [0.88, 0.7, 0.55] });
    this.makeBuilding({ x0: -36.5, z0: -26, x1: -26, z1: -12 }, 2, 1 | 2 | 16 | 32, { roof: 'flat', color: [0.82, 0.68, 0.55] });

    // fountain
    const fx = 0, fz = 17;
    this.B('stone', fx, fz).cylinder(fx, fz, 0, 0.8, 4.2, 4.2, 20, [0.85, 0.82, 0.78], 2, false);
    this.B('stone', fx, fz).cylinder(fx, fz, 0.8, 0.95, 4.4, 4.4, 20, [0.75, 0.72, 0.68], 2, true);
    this.B('flesh', fx, fz).cylinder(fx, fz, 0.6, 0.7, 4.0, 4.0, 20, [0.6, 0.05, 0.03], 2, true); // blood water
    this.B('stone', fx, fz).cylinder(fx, fz, 0.7, 3.6, 0.6, 0.5, 10, [0.85, 0.82, 0.78], 2, true);
    this.B('stone', fx, fz).cylinder(fx, fz, 3.6, 4.0, 1.6, 1.8, 14, [0.85, 0.82, 0.78], 2, true);
    this.solid(fx - 4.2, 0, fz - 4.2, fx + 4.2, 0.95, fz + 4.2, { kind: 'fountain', blocksSight: false });
    this.solid(fx - 0.6, 0.95, fz - 0.6, fx + 0.6, 3.6, fz + 0.6, { kind: 'fountain' });
    this.solid(fx - 1.7, 3.6, fz - 1.7, fx + 1.7, 4.0, fz + 1.7, { kind: 'fountain' });
    this.footprints.push({ x0: fx - 4.2, z0: fz - 4.2, x1: fx + 4.2, z1: fz + 4.2, h: 1, kind: 'fountain' });
    // stalls and braziers around the piazza
    this.stall(-20, 30, true);
    this.stall(-12, 31, true);
    this.stall(14, 31, true);
    this.stall(22, 26, false);
    this.brazier(-14, 6);
    this.brazier(14, 6);
    this.brazier(-18, 24);
    this.brazier(18, 18);
    this.hayCarts.push(this.makeHay(-22, 12, 0));
    this.hayCarts.push(this.makeHay(24, 36.5 - 3, Math.PI / 2));
    this.cathedral = {
      arena: { x: 0, z: 17, r: 26 },
      bossSpawn: { x: 0, z: 6 },
      door: { x: 0, z: -5 },
    };
    // reserve so blocks don't overlap (the quarter is skipped anyway)
    this.reserved.push({ x0: -36.5, z0: -36.5, x1: 36.5, z1: 36.5 });
  }

  makeRiftPiazza(def, x0, z0, x1, z1) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    this.B('stone', cx, cz).ground(x0, z0, x1, z1, 0.02, [0.5, 0.45, 0.42], 3);
    // hellrock corruption decal around the rift
    const dgeo = new THREE.CircleGeometry(15, 40);
    const uvs = dgeo.attributes.uv;
    for (let k = 0; k < uvs.count; k++) uvs.setXY(k, uvs.getX(k) * 6, uvs.getY(k) * 6);
    const decal = new THREE.Mesh(dgeo, this.mats.hellrockDecal);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(cx, 0.05, cz);
    decal.receiveShadow = true;
    this.group.add(decal);
    const rng = this.rng;
    const r = Math.min(x1 - x0, z1 - z0) / 2 - 1.2;
    // flesh pillars and spikes
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + rng() * 0.4;
      const d = r * (0.62 + rng() * 0.25);
      const px = cx + Math.cos(a) * d, pz = cz + Math.sin(a) * d;
      const hgt = 1.5 + rng() * 3.5;
      this.B('flesh', px, pz).cylinder(px, pz, 0, hgt, 0.45 + rng() * 0.35, 0.05, 7, jitterColor(rng, [0.85, 0.4, 0.35], 0.2), 1.5, false);
      if (hgt > 2.5) this.solid(px - 0.35, 0, pz - 0.35, px + 0.35, hgt * 0.7, pz + 0.35, { kind: 'spike', climbable: false, blocksSight: false });
    }
    // bone piles + overturned braziers burning
    for (let k = 0; k < 3; k++) {
      const a = rng() * Math.PI * 2, d = r * 0.85;
      const bx = cx + Math.cos(a) * d, bz = cz + Math.sin(a) * d;
      this.fires.push({ x: bx, y: 0.1, z: bz, size: 0.9 });
      this.addLight(bx, 1.2, bz, 0xff5a20, 2.6, 12, 0.45);
    }
    // the central mound
    this.B('hellrock', cx, cz).cylinder(cx, cz, 0, 1.2, 4.2, 3.0, 12, [0.9, 0.85, 0.85], 3, true);
    this.solid(cx - 3.2, 0, cz - 3.2, cx + 3.2, 1.2, cz + 3.2, { kind: 'mound', climbable: true, blocksSight: false });
    const rift = {
      id: def.id, name: def.name, x: cx, z: cz,
      bounds: { x0, z0, x1, z1 },
      radius: r,
      heart: { x: cx, y: 1.2, z: cz + 2.2 },
      closed: false,
    };
    this.rifts.push(rift);
    this.piazzas.push({ name: def.name, x0, z0, x1, z1, center: { x: cx, z: cz }, rift: def.id });
    this.footprints.push({ x0, z0, x1, z1, h: 0, kind: 'rift' });
    this.addLight(cx, 5, cz, 0xff3010, 5, 26, 0.2);
    // a chest tucked in a corner of the piazza
    this.chests.push({ x: x0 + 1.4, y: 0, z: z1 - 1.4, yaw: Math.PI * 0.75, where: 'rift' });
    this.hayCarts.push(this.makeHay(x1 - 2.2, z0 + 2.2, 0));
  }

  makeHideout() {
    const h = this.hideout;
    const b = this.makeBuilding(h, 3, 1 | 2 | 16 | 32, { roof: 'flat', color: [0.75, 0.68, 0.6] });
    // creed banner on the hideout roof
    const cx = (h.x0 + h.x1) / 2, cz = (h.z0 + h.z1) / 2;
    this.spawn = { x: cx - 1.5, y: b.H, z: cz - 1.5, yaw: Math.atan2(-60 - cx, 47 - cz) };
    this.B('wood', cx + 2, cz).box(cx + 2.5, b.H, cz - 2.2, cx + 2.62, b.H + 3.2, cz - 2.08, [0.4, 0.3, 0.22], 1, 55);
    this.B('fabric', cx + 2.5, cz - 2.2).quad([cx + 2.6, b.H + 1.6, cz - 2.14], [cx + 4.0, b.H + 1.6, cz - 2.14], [cx + 4.0, b.H + 3.1, cz - 2.14], [cx + 2.6, b.H + 3.1, cz - 2.14], [0, 0, 1], [0, 0, 1, 0, 1, 1, 0, 1], [0.7, 0.05, 0.05]);
    this.brazier(cx + 2.5, cz + 2.5, b.H);
    this.chests.push({ x: cx - 2.8, y: b.H, z: cz + 2.8, yaw: 0, where: 'hideout', starter: true });
  }

  // -------------------------------------------------------------- beams
  /** Wooden beams across roads/alleys connecting facing buildings at roof height. */
  makeBeams() {
    const rng = this.rng;
    const bs = this.buildings;
    let count = 0;
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i];
      for (let j = 0; j < bs.length; j++) {
        if (i === j) continue;
        const b = bs[j];
        // a's east face to b's west face across an x gap
        const gapX = b.x0 - a.x1;
        if (gapX > 2.2 && gapX < 7.6) {
          const lo = Math.max(a.z0, b.z0) + 0.8, hi = Math.min(a.z1, b.z1) - 0.8;
          if (hi - lo > 1 && rng() < 0.34) {
            const z = lerp(lo, hi, rng());
            const y = Math.min(a.H, b.H) - (rng() < 0.4 ? FLOOR_H * 0.5 : 0);
            this.beam(a.x1 - 0.2, y, z, b.x0 + 0.2, y, z, 'x');
            count++;
          }
        }
        const gapZ = b.z0 - a.z1;
        if (gapZ > 2.2 && gapZ < 7.6) {
          const lo = Math.max(a.x0, b.x0) + 0.8, hi = Math.min(a.x1, b.x1) - 0.8;
          if (hi - lo > 1 && rng() < 0.34) {
            const x = lerp(lo, hi, rng());
            const y = Math.min(a.H, b.H) - (rng() < 0.4 ? FLOOR_H * 0.5 : 0);
            this.beam(x, y, a.z1 - 0.2, x, y, b.z0 + 0.2, 'z');
            count++;
          }
        }
      }
    }
    this.beamCount = count;
  }

  beam(ax, y, az, bx, by, bz, axis) {
    const w = 0.32;
    const c = [0.5, 0.38, 0.28];
    if (axis === 'x') this.block('wood', c, ax, y - 0.28, az - w / 2, bx, y, az + w / 2, { kind: 'beam', climbable: false, uv: 1.5, faces: 63, blocksSight: false, blocksCamera: false });
    else this.block('wood', c, ax - w / 2, y - 0.28, az, ax + w / 2, y, bz, { kind: 'beam', climbable: false, uv: 1.5, faces: 63, blocksSight: false, blocksCamera: false });
    // rope/lantern sometimes
    void by;
  }

  // -------------------------------------------------------------- street props
  makeStreetProps() {
    const rng = this.rng;
    const inBuilding = (x, z, m = 1.2) => !this.col.isFree(x, z, m, 0.2, 2.5);
    // walk along every road and drop props next to the facades
    const roadPts = [];
    for (const r of ROADS) {
      for (let a = -108; a <= 108; a += 2) {
        roadPts.push({ x: r.c, z: a, w: r.w, axis: 'z' });
        roadPts.push({ x: a, z: r.c, w: r.w, axis: 'x' });
      }
    }
    // perimeter ring road
    for (let a = -108; a <= 108; a += 2) {
      roadPts.push({ x: a, z: -113, w: 6, axis: 'x' }, { x: a, z: 113, w: 6, axis: 'x' }, { x: -113, z: a, w: 6, axis: 'z' }, { x: 113, z: a, w: 6, axis: 'z' });
    }
    const inCenter = (x, z) => Math.abs(x) < 37 && Math.abs(z) < 37;
    for (const p of roadPts) {
      if (inCenter(p.x, p.z)) continue;
      // street points for wanderers
      if (rng() < 0.12 && !inBuilding(p.x, p.z, 0.8)) this.streetPoints.push({ x: p.x, z: p.z });
      if (rng() > 0.1) continue;
      const side = rng() < 0.5 ? -1 : 1;
      const off = p.w / 2 - 0.9;
      const x = p.axis === 'z' ? p.x + side * off : p.x;
      const z = p.axis === 'x' ? p.z + side * off : p.z;
      if (inBuilding(x, z, 1.1)) continue;
      // keep intersections clear
      if (ROADS.some((r) => Math.abs((p.axis === 'z' ? z : x) - r.c) < r.w / 2 + 2)) continue;
      const roll = rng();
      if (roll < 0.3) {
        this.crate(x, 0, z, 1.0);
        if (rng() < 0.5) this.crate(x + (p.axis === 'z' ? 0 : 1.05), 0, z + (p.axis === 'z' ? 1.05 : 0), 1.0);
        if (rng() < 0.4) this.crate(x, 1.0, z, 0.9);
      } else if (roll < 0.5) {
        this.barrel(x, 0, z);
        if (rng() < 0.5) this.barrel(x + (p.axis === 'z' ? 0 : 0.85), 0, z + (p.axis === 'z' ? 0.85 : 0));
      } else if (roll < 0.66 && this.hayCarts.length < 34) {
        this.hayCarts.push(this.makeHay(x, z, p.axis === 'x' ? 0 : Math.PI / 2));
      } else if (roll < 0.76) {
        this.brazier(x, z);
      } else if (roll < 0.86) {
        // burning debris
        this.fires.push({ x, y: 0.1, z, size: 0.7 });
        this.addLight(x, 1.0, z, 0xff6a20, 2.2, 11, 0.45);
        this.B('wood', x, z).box(x - 0.9, 0, z - 0.15, x + 0.9, 0.3, z + 0.15, [0.2, 0.15, 0.12], 1, 55);
        this.B('wood', x, z).box(x - 0.15, 0, z - 0.8, x + 0.15, 0.25, z + 0.8, [0.2, 0.15, 0.12], 1, 55);
      }
    }
  }

  makePatrols() {
    // loops around blocks along road centrelines
    const xs = [-113, ...ROADS.map((r) => r.c), 113];
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < xs.length - 1; j++) {
        const x0 = xs[i], x1 = xs[i + 1], z0 = xs[j], z1 = xs[j + 1];
        if (Math.abs((x0 + x1) / 2) < 30 && Math.abs((z0 + z1) / 2) < 30) continue;
        this.patrolLoops.push([{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]);
      }
    }
  }

  // -------------------------------------------------------------- finalize
  finalize() {
    this.meshes = this.cb.build(this.mats, this.group);
    this.buildInstanced();
    this.nav = new NavGrid(-CITY_HALF, -CITY_HALF, CITY_HALF * 2, 1);
    this.nav.build(this.col);
    // keep only walkable street points
    this.streetPoints = this.streetPoints.filter((p) => this.nav.walkable(p.x, p.z));
    // relics: secrets on high rooftops
    const rng = this.rng;
    const tall = this.rooftopPoints.filter((p) => p.y > 13).sort(() => rng() - 0.5);
    for (let k = 0; k < tall.length && this.relics.length < 10; k++) {
      const p = tall[k];
      if (this.relics.some((r) => Math.hypot(r.x - p.x, r.z - p.z) < 30)) continue;
      this.relics.push({ x: p.x, y: p.y + 0.9, z: p.z });
    }
    this.buildMap();
  }

  buildInstanced() {
    const mats = this.mats;
    const add = (geo, mat, list, colorFn) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const col = new THREE.Color();
      list.forEach((it, i) => {
        p.set(it[0], it[1], it[2]);
        q.setFromAxisAngle(up, it[3]);
        m.compose(p, q, s);
        im.setMatrixAt(i, m);
        if (colorFn) { colorFn(it, col); im.setColorAt(i, col); }
      });
      im.castShadow = false;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.group.add(im);
      return im;
    };
    // pane: 1.0 x 1.5 facing +z
    const pane = new THREE.PlaneGeometry(1.0, 1.5);
    add(pane, mats.windowDark, this.windows.dark);
    add(pane, mats.windowLit, this.windows.lit);
    // frame + open shutters as one geometry (wood)
    const fb = new MeshBuilder();
    const c = [1, 1, 1];
    fb.box(-0.58, -0.8, 0, 0.58, -0.72, 0.08, c, 1, 63);
    fb.box(-0.58, 0.72, 0, 0.58, 0.82, 0.08, c, 1, 63);
    fb.box(-0.58, -0.72, 0, -0.5, 0.72, 0.08, c, 1, 63);
    fb.box(0.5, -0.72, 0, 0.58, 0.72, 0.08, c, 1, 63);
    fb.box(-1.1, -0.72, 0, -0.6, 0.72, 0.05, c, 0.5, 63);
    fb.box(0.6, -0.72, 0, 1.1, 0.72, 0.05, c, 0.5, 63);
    const shutterCol = new THREE.Color();
    add(fb.toGeometry(), mats.wood, this.windows.frames, (it, col) => col.copy(shutterCol.setHex(it[4]).convertSRGBToLinear()).multiplyScalar(2.2));
    const sill = new MeshBuilder();
    sill.box(-0.68, -0.08, -0.02, 0.68, 0.06, 0.18, [0.8, 0.75, 0.68], 1, 63);
    add(sill.toGeometry(), mats.stone, this.windows.sills);
    // doors: plank door + stone frame
    const door = new MeshBuilder();
    door.box(-0.7, 0, 0, 0.7, 2.4, 0.06, [0.45, 0.32, 0.24], 1.2, 63);
    add(door.toGeometry(), mats.wood, this.doors);
    const frame = new MeshBuilder();
    frame.box(-0.9, 2.4, -0.02, 0.9, 2.7, 0.14, [0.78, 0.72, 0.64], 1, 63);
    frame.box(-0.9, 0, -0.02, -0.7, 2.4, 0.14, [0.78, 0.72, 0.64], 1, 63);
    frame.box(0.7, 0, -0.02, 0.9, 2.4, 0.14, [0.78, 0.72, 0.64], 1, 63);
    add(frame.toGeometry(), mats.stone, this.doors);
  }

  /** Top-down parchment map drawn once; HUD overlays icons on top. */
  buildMap() {
    const S = 2; // px per metre
    const size = WALL_OUT * 2 * S;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const tx = (x) => (x + WALL_OUT) * S;
    g.fillStyle = '#2a1c14';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#5a4634';
    g.fillRect(tx(-CITY_HALF), tx(-CITY_HALF), CITY_HALF * 2 * S, CITY_HALF * 2 * S);
    for (const p of this.piazzas) {
      g.fillStyle = p.rift ? '#6a2a1c' : '#6e5a44';
      g.fillRect(tx(p.x0), tx(p.z0), (p.x1 - p.x0) * S, (p.z1 - p.z0) * S);
    }
    const sorted = [...this.footprints].sort((a, b) => a.h - b.h);
    for (const f of sorted) {
      if (f.kind === 'rift') continue;
      let col;
      if (f.kind === 'wall') col = '#1c120c';
      else if (f.kind === 'cathedral') col = '#c9b79a';
      else if (f.kind === 'tower') col = '#e0c890';
      else if (f.kind === 'hay') col = '#c9a040';
      else if (f.kind === 'fountain') col = '#8a8a90';
      else {
        const l = clamp(0.35 + f.h / 40, 0.35, 0.8);
        col = `rgb(${Math.round(140 * l + 40)},${Math.round(110 * l + 30)},${Math.round(80 * l + 20)})`;
      }
      g.fillStyle = col;
      g.fillRect(tx(f.x0), tx(f.z0), Math.max(1, (f.x1 - f.x0) * S), Math.max(1, (f.z1 - f.z0) * S));
      if (f.kind === 'house' || f.kind === 'cathedral' || f.kind === 'tower') {
        g.strokeStyle = 'rgba(30,18,10,0.6)';
        g.lineWidth = 1;
        g.strokeRect(tx(f.x0) + 0.5, tx(f.z0) + 0.5, (f.x1 - f.x0) * S - 1, (f.z1 - f.z0) * S - 1);
      }
    }
    this.mapCanvas = c;
    this.mapScale = S;
    this.mapOrigin = -WALL_OUT;
  }

  /** Closest viewpoint/hay/etc helpers */
  nearestHay(x, z, maxD = 2.2) {
    let best = null, bd = maxD;
    for (const h of this.hayCarts) {
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
}
