import * as THREE from 'three';

// Accumulates static geometry (positions, normals, uvs, colours) so the whole
// city can be merged into a handful of draw calls per chunk and material.
// UVs are generated in world units divided by a per-call texture scale.

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.vcount = 0;
  }

  get empty() { return this.vcount === 0; }

  _v(x, y, z, nx, ny, nz, u, v, c) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return this.vcount++;
  }

  /** Quad from 4 corners (counter-clockwise when seen from the front). */
  quad(p0, p1, p2, p3, n, uvs, c) {
    const a = this._v(p0[0], p0[1], p0[2], n[0], n[1], n[2], uvs[0], uvs[1], c);
    const b = this._v(p1[0], p1[1], p1[2], n[0], n[1], n[2], uvs[2], uvs[3], c);
    const d = this._v(p2[0], p2[1], p2[2], n[0], n[1], n[2], uvs[4], uvs[5], c);
    const e = this._v(p3[0], p3[1], p3[2], n[0], n[1], n[2], uvs[6], uvs[7], c);
    this.idx.push(a, b, d, a, d, e);
  }

  tri(p0, p1, p2, n, uvs, c) {
    const a = this._v(p0[0], p0[1], p0[2], n[0], n[1], n[2], uvs[0], uvs[1], c);
    const b = this._v(p1[0], p1[1], p1[2], n[0], n[1], n[2], uvs[2], uvs[3], c);
    const d = this._v(p2[0], p2[1], p2[2], n[0], n[1], n[2], uvs[4], uvs[5], c);
    this.idx.push(a, b, d);
  }

  /**
   * Axis aligned box with world-space UVs. faces: bitmask
   * 1=+x 2=-x 4=+y 8=-y 16=+z 32=-z (default all but bottom).
   */
  box(x0, y0, z0, x1, y1, z1, c, s = 3, faces = 55, uo = 0, vo = 0) {
    if (faces & 1) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [z1 / s + uo, y0 / s + vo, z0 / s + uo, y0 / s + vo, z0 / s + uo, y1 / s + vo, z1 / s + uo, y1 / s + vo].map((v, i) => (i % 2 === 0 ? -v : v)), c);
    if (faces & 2) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [z0 / s + uo, y0 / s + vo, z1 / s + uo, y0 / s + vo, z1 / s + uo, y1 / s + vo, z0 / s + uo, y1 / s + vo], c);
    if (faces & 4) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [x0 / s, -z1 / s, x1 / s, -z1 / s, x1 / s, -z0 / s, x0 / s, -z0 / s], c);
    if (faces & 8) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [x0 / s, z0 / s, x1 / s, z0 / s, x1 / s, z1 / s, x0 / s, z1 / s], c);
    if (faces & 16) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [x0 / s + uo, y0 / s + vo, x1 / s + uo, y0 / s + vo, x1 / s + uo, y1 / s + vo, x0 / s + uo, y1 / s + vo], c);
    if (faces & 32) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [-x1 / s + uo, y0 / s + vo, -x0 / s + uo, y0 / s + vo, -x0 / s + uo, y1 / s + vo, -x1 / s + uo, y1 / s + vo], c);
  }

  /** Horizontal ground rectangle at height y. */
  ground(x0, z0, x1, z1, y, c, s = 3) {
    this.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [x0 / s, -z1 / s, x1 / s, -z1 / s, x1 / s, -z0 / s, x0 / s, -z0 / s], c);
  }

  /**
   * Gable roof: ridge along `axis` ('x' or 'z'), eaves at height y0, ridge at y1.
   * Includes the two triangular gable ends (wall material is separate: pass
   * gableBuilder to put them elsewhere).
   */
  gableRoof(x0, z0, x1, z1, y0, y1, axis, c, s = 3, overhang = 0.35, thick = 0.18, gableBuilder = null, gableColor = null) {
    const gb = gableBuilder || this;
    const gc = gableColor || c;
    if (axis === 'x') {
      const zm = (z0 + z1) / 2;
      const half = (z1 - z0) / 2 + overhang;
      const run = Math.hypot(half, y1 - y0);
      const drop = (y1 - y0) * overhang / ((z1 - z0) / 2);
      const ex0 = x0 - overhang, ex1 = x1 + overhang;
      const ny = half / run, nz = (y1 - y0) / run;
      const ey = y0 - drop;
      // south slope (+z)
      this.quad([ex0, ey, z1 + overhang], [ex1, ey, z1 + overhang], [ex1, y1, zm], [ex0, y1, zm], [0, ny, nz], [ex0 / s, 0, ex1 / s, 0, ex1 / s, run / s, ex0 / s, run / s], c);
      // north slope (-z)
      this.quad([ex1, ey, z0 - overhang], [ex0, ey, z0 - overhang], [ex0, y1, zm], [ex1, y1, zm], [0, ny, -nz], [ex1 / s, 0, ex0 / s, 0, ex0 / s, run / s, ex1 / s, run / s], c);
      // underside / edge thickness
      this.quad([ex0, ey - thick, z1 + overhang], [ex1, ey - thick, z1 + overhang], [ex1, ey, z1 + overhang], [ex0, ey, z1 + overhang], [0, 0, 1], [0, 0, 1, 0, 1, 0.05, 0, 0.05], c);
      this.quad([ex1, ey - thick, z0 - overhang], [ex0, ey - thick, z0 - overhang], [ex0, ey, z0 - overhang], [ex1, ey, z0 - overhang], [0, 0, -1], [0, 0, 1, 0, 1, 0.05, 0, 0.05], c);
      // gable triangles
      gb.tri([x1, y0, z1], [x1, y0, z0], [x1, y1, zm], [1, 0, 0], [-z1 / 4, y0 / 4, -z0 / 4, y0 / 4, -zm / 4, y1 / 4], gc);
      gb.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zm], [-1, 0, 0], [z0 / 4, y0 / 4, z1 / 4, y0 / 4, zm / 4, y1 / 4], gc);
    } else {
      const xm = (x0 + x1) / 2;
      const half = (x1 - x0) / 2 + overhang;
      const run = Math.hypot(half, y1 - y0);
      const drop = (y1 - y0) * overhang / ((x1 - x0) / 2);
      const ez0 = z0 - overhang, ez1 = z1 + overhang;
      const ny = half / run, nx = (y1 - y0) / run;
      const ey = y0 - drop;
      this.quad([x1 + overhang, ey, ez1], [x1 + overhang, ey, ez0], [xm, y1, ez0], [xm, y1, ez1], [nx, ny, 0], [ez1 / s, 0, ez0 / s, 0, ez0 / s, run / s, ez1 / s, run / s], c);
      this.quad([x0 - overhang, ey, ez0], [x0 - overhang, ey, ez1], [xm, y1, ez1], [xm, y1, ez0], [-nx, ny, 0], [ez0 / s, 0, ez1 / s, 0, ez1 / s, run / s, ez0 / s, run / s], c);
      this.quad([x1 + overhang, ey - thick, ez1], [x1 + overhang, ey - thick, ez0], [x1 + overhang, ey, ez0], [x1 + overhang, ey, ez1], [1, 0, 0], [0, 0, 1, 0, 1, 0.05, 0, 0.05], c);
      this.quad([x0 - overhang, ey - thick, ez0], [x0 - overhang, ey - thick, ez1], [x0 - overhang, ey, ez1], [x0 - overhang, ey, ez0], [-1, 0, 0], [0, 0, 1, 0, 1, 0.05, 0, 0.05], c);
      gb.tri([x0, y0, z1], [x1, y0, z1], [xm, y1, z1], [0, 0, 1], [x0 / 4, y0 / 4, x1 / 4, y0 / 4, xm / 4, y1 / 4], gc);
      gb.tri([x1, y0, z0], [x0, y0, z0], [xm, y1, z0], [0, 0, -1], [-x1 / 4, y0 / 4, -x0 / 4, y0 / 4, -xm / 4, y1 / 4], gc);
    }
  }

  /** Hip-less pyramid roof (for towers). */
  pyramid(x0, z0, x1, z1, y0, y1, c, s = 3) {
    const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
    const sides = [
      [[x0, y0, z1], [x1, y0, z1]],
      [[x1, y0, z1], [x1, y0, z0]],
      [[x1, y0, z0], [x0, y0, z0]],
      [[x0, y0, z0], [x0, y0, z1]],
    ];
    const apex = [xm, y1, zm];
    for (const [a, b] of sides) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      const len = Math.hypot(e1[0], e1[2]);
      const h = Math.hypot(xm - (a[0] + b[0]) / 2, y1 - y0, zm - (a[2] + b[2]) / 2);
      this.tri(a, b, apex, [n[0] / l, n[1] / l, n[2] / l], [0, 0, len / s, 0, len / s / 2, h / s], c);
    }
  }

  /** Vertical cylinder / cone (open ended unless caps). */
  cylinder(cx, cz, y0, y1, r0, r1, seg, c, s = 3, caps = true, uScale = 1) {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const slope = (r0 - r1) / (y1 - y0);
      const nl = Math.hypot(1, slope);
      const u0 = (i / seg) * circ / s * uScale, u1 = ((i + 1) / seg) * circ / s * uScale;
      const a = this._v(cx + c0 * r0, y0, cz + s0 * r0, c0 / nl, slope / nl, s0 / nl, u0, y0 / s, c);
      const b = this._v(cx + c1 * r0, y0, cz + s1 * r0, c1 / nl, slope / nl, s1 / nl, u1, y0 / s, c);
      const d = this._v(cx + c1 * r1, y1, cz + s1 * r1, c1 / nl, slope / nl, s1 / nl, u1, y1 / s, c);
      const e = this._v(cx + c0 * r1, y1, cz + s0 * r1, c0 / nl, slope / nl, s0 / nl, u0, y1 / s, c);
      this.idx.push(a, d, b, a, e, d);
      if (caps && r1 > 0.001) {
        const t0 = this._v(cx, y1, cz, 0, 1, 0, 0.5, 0.5, c);
        const t1 = this._v(cx + c0 * r1, y1, cz + s0 * r1, 0, 1, 0, 0.5 + c0 * 0.5, 0.5 + s0 * 0.5, c);
        const t2 = this._v(cx + c1 * r1, y1, cz + s1 * r1, 0, 1, 0, 0.5 + c1 * 0.5, 0.5 + s1 * 0.5, c);
        this.idx.push(t0, t2, t1);
      }
    }
  }

  /** Hemisphere / dome (upper half sphere) of radius r at base height y. */
  dome(cx, y, cz, r, seg, rings, c, s = 3, squash = 1) {
    const base = this.vcount;
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI / 2;
      const cy = Math.cos(phi), sy = Math.sin(phi);
      for (let i = 0; i <= seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const nx = Math.cos(th) * cy, nz = Math.sin(th) * cy, ny = sy;
        this._v(cx + nx * r, y + ny * r * squash, cz + nz * r, nx, ny, nz, (i / seg) * (2 * Math.PI * r) / s, (j / rings) * (Math.PI * r / 2) / s, c);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i;
        const b = a + seg + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Append an arbitrary THREE.BufferGeometry transformed by matrix (uv kept). */
  addGeometry(geo, matrix, c) {
    const g = geo.index ? geo : geo;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const base = this.vcount;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      nn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this._v(v.x, v.y, v.z, nn.x, nn.y, nn.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, c);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** One MeshBuilder per (chunk, material) so the static world can be culled. */
export class ChunkedBuilder {
  constructor(chunkSize = 48) {
    this.size = chunkSize;
    this.map = new Map();
  }

  get(material, x, z) {
    const cx = Math.floor(x / this.size), cz = Math.floor(z / this.size);
    const key = material + '|' + cx + '|' + cz;
    let b = this.map.get(key);
    if (!b) { b = new MeshBuilder(); b.material = material; this.map.set(key, b); }
    return b;
  }

  build(materials, parent, { castShadow = true, receiveShadow = true } = {}) {
    const meshes = [];
    for (const b of this.map.values()) {
      if (b.empty) continue;
      const mesh = new THREE.Mesh(b.toGeometry(), materials[b.material]);
      mesh.castShadow = castShadow && b.material !== 'cobble' && b.material !== 'hellrockDecal';
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }
}
