// Static + dynamic collision world made of axis-aligned boxes and "slopes"
// (boxes whose top surface rises linearly along X or Z: roofs, ramps, stairs).
// Spatial hash on the XZ plane; supports ground/ceiling queries, character
// circle push-out, raycasts and free-space checks.

const CELL = 6;
const ORIGIN = -192;
const DIM = 64; // covers [-192, 192)

let nextId = 1;

export class Collider {
  constructor(minX, minY, minZ, maxX, maxY, maxZ, opts = {}) {
    this.id = nextId++;
    this.minX = Math.min(minX, maxX); this.maxX = Math.max(minX, maxX);
    this.minY = Math.min(minY, maxY); this.maxY = Math.max(minY, maxY);
    this.minZ = Math.min(minZ, maxZ); this.maxZ = Math.max(minZ, maxZ);
    this.kind = opts.kind || 'solid';
    this.climbable = opts.climbable !== false;
    this.walkable = opts.walkable !== false;
    this.blocksSight = opts.blocksSight !== false;
    this.blocksCamera = opts.blocksCamera !== false;
    this.data = opts.data || null;
    // slope: { axis: 'x' | 'z', y0: height at min edge, y1: height at max edge }
    this.slope = opts.slope || null;
    if (this.slope) {
      this.maxY = Math.max(this.slope.y0, this.slope.y1);
      const lo = this.slope.axis === 'x' ? this.minX : this.minZ;
      const hi = this.slope.axis === 'x' ? this.maxX : this.maxZ;
      this.slope.lo = lo;
      this.slope.k = (this.slope.y1 - this.slope.y0) / (hi - lo);
    }
    this.stamp = 0;
    this.cells = null;
  }

  /** Height of the top surface at (x, z) (clamped into the footprint). */
  topAt(x, z) {
    const s = this.slope;
    if (!s) return this.maxY;
    const c = s.axis === 'x' ? Math.min(Math.max(x, this.minX), this.maxX) : Math.min(Math.max(z, this.minZ), this.maxZ);
    return s.y0 + s.k * (c - s.lo);
  }

  /** Slope angle (rad) of the top surface. */
  steepness() {
    return this.slope ? Math.atan(Math.abs(this.slope.k)) : 0;
  }

  get width() { return this.maxX - this.minX; }
  get depth() { return this.maxZ - this.minZ; }
}

function circleRectDist(x, z, c) {
  const qx = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  const qz = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  const dx = x - qx, dz = z - qz;
  return dx * dx + dz * dz;
}

export class CollisionWorld {
  constructor() {
    this.grid = new Array(DIM * DIM);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = [];
    this.all = new Set();
    this.stamp = 1;
    this._tmp = [];
    this.groundLevel = 0;
  }

  add(c) {
    const x0 = this._cell(c.minX), x1 = this._cell(c.maxX);
    const z0 = this._cell(c.minZ), z1 = this._cell(c.maxZ);
    c.cells = [];
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const idx = iz * DIM + ix;
        this.grid[idx].push(c);
        c.cells.push(idx);
      }
    }
    this.all.add(c);
    return c;
  }

  box(minX, minY, minZ, maxX, maxY, maxZ, opts) {
    return this.add(new Collider(minX, minY, minZ, maxX, maxY, maxZ, opts));
  }

  remove(c) {
    if (!c.cells) return;
    for (const idx of c.cells) {
      const arr = this.grid[idx];
      const i = arr.indexOf(c);
      if (i >= 0) arr.splice(i, 1);
    }
    c.cells = null;
    this.all.delete(c);
  }

  _cell(v) {
    const i = Math.floor((v - ORIGIN) / CELL);
    return i < 0 ? 0 : i >= DIM ? DIM - 1 : i;
  }

  /** Collect unique colliders whose cells overlap the XZ rectangle. */
  query(minX, minZ, maxX, maxZ, out = this._tmp) {
    out.length = 0;
    const s = ++this.stamp;
    const x0 = this._cell(minX), x1 = this._cell(maxX);
    const z0 = this._cell(minZ), z1 = this._cell(maxZ);
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const arr = this.grid[iz * DIM + ix];
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          if (c.stamp === s) continue;
          c.stamp = s;
          if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Highest walkable surface under the circle (x,z,r) whose top is <= maxY.
   * Returns {y, c} (c = null for the ground plane).
   */
  groundAt(x, z, r, maxY, res = { y: 0, c: null }) {
    res.y = this.groundLevel;
    res.c = null;
    const list = this.query(x - r, z - r, x + r, z + r);
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.walkable) continue;
      if (circleRectDist(x, z, c) > r2) continue;
      const top = c.topAt(x, z);
      if (top <= maxY && top > res.y) {
        res.y = top;
        res.c = c;
      }
    }
    return res;
  }

  /** Lowest collider bottom above minY over the circle (for head bumps). */
  ceilingAt(x, z, r, minY) {
    let best = Infinity;
    const list = this.query(x - r, z - r, x + r, z + r);
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.minY < minY) continue;
      if (circleRectDist(x, z, c) > r2) continue;
      if (c.minY < best) best = c.minY;
    }
    return best;
  }

  _blocks(c, x, z, yLo, yHi) {
    if (c.minY >= yHi) return false;
    const top = c.slope ? c.topAt(x, z) : c.maxY;
    return top > yLo;
  }

  /**
   * Push the circle (pos.x, pos.z, r) out of colliders that occupy the vertical
   * span [yLo, yHi]. Mutates pos. Returns number of contacts and fills
   * this.contacts with {nx, nz, c}.
   */
  pushOut(pos, r, yLo, yHi, contacts = null, filter = null) {
    let count = 0;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r);
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (filter && !filter(c)) continue;
        if (!this._blocks(c, pos.x, pos.z, yLo, yHi)) continue;
        const qx = pos.x < c.minX ? c.minX : pos.x > c.maxX ? c.maxX : pos.x;
        const qz = pos.z < c.minZ ? c.minZ : pos.z > c.maxZ ? c.maxZ : pos.z;
        let dx = pos.x - qx, dz = pos.z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let nx, nz, push;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          nx = dx / d; nz = dz / d;
          push = r - d;
        } else {
          // centre inside the rectangle: exit through the nearest side
          const l = pos.x - c.minX, rr = c.maxX - pos.x, b = pos.z - c.minZ, f = c.maxZ - pos.z;
          const m = Math.min(l, rr, b, f);
          if (m === l) { nx = -1; nz = 0; push = l + r; }
          else if (m === rr) { nx = 1; nz = 0; push = rr + r; }
          else if (m === b) { nx = 0; nz = -1; push = b + r; }
          else { nx = 0; nz = 1; push = f + r; }
        }
        pos.x += nx * push;
        pos.z += nz * push;
        moved = true;
        count++;
        if (contacts) contacts.push({ nx, nz, c });
      }
      if (!moved) break;
    }
    return count;
  }

  /** True if no collider occupies the cylinder. */
  isFree(x, z, r, yLo, yHi, filter = null) {
    const list = this.query(x - r, z - r, x + r, z + r);
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (filter && !filter(c)) continue;
      if (circleRectDist(x, z, c) >= r2) continue;
      if (this._blocks(c, x, z, yLo, yHi)) return false;
    }
    return true;
  }

  /**
   * Raycast. dir need not be normalized; t is in units of |dir| * maxT.
   * Returns null or { t, x, y, z, nx, ny, nz, c } with t in world units when dir is normalized.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, filter = null, res = null) {
    let bestT = maxT, best = null, bnx = 0, bny = 0, bnz = 0;
    const s = ++this.stamp;
    // DDA over the XZ grid
    let ix = this._cell(ox), iz = this._cell(oz);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    const cellX0 = ORIGIN + ix * CELL, cellZ0 = ORIGIN + iz * CELL;
    let tMaxX = dx !== 0 ? ((dx > 0 ? cellX0 + CELL : cellX0) - ox) / dx : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? cellZ0 + CELL : cellZ0) - oz) / dz : Infinity;
    let tCell = 0;
    for (let guard = 0; guard < 256; guard++) {
      if (ix >= 0 && ix < DIM && iz >= 0 && iz < DIM) {
        const arr = this.grid[iz * DIM + ix];
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          if (c.stamp === s) continue;
          c.stamp = s;
          if (filter && !filter(c)) continue;
          const h = c.slope ? this._rayWedge(c, ox, oy, oz, dx, dy, dz, bestT) : this._rayBox(c, ox, oy, oz, dx, dy, dz, bestT);
          if (h !== null && h.t < bestT) {
            bestT = h.t; best = c; bnx = h.nx; bny = h.ny; bnz = h.nz;
          }
        }
      }
      // next cell
      if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDeltaX; ix += stepX; }
      else { tCell = tMaxZ; tMaxZ += tDeltaZ; iz += stepZ; }
      if (tCell > bestT) break;
      if (ix < -1 || ix > DIM || iz < -1 || iz > DIM) break;
    }
    // ground plane
    if (dy < 0) {
      const tg = (this.groundLevel - oy) / dy;
      if (tg >= 0 && tg < bestT) { bestT = tg; best = 'ground'; bnx = 0; bny = 1; bnz = 0; }
    }
    if (!best) return null;
    res = res || {};
    res.t = bestT;
    res.x = ox + dx * bestT; res.y = oy + dy * bestT; res.z = oz + dz * bestT;
    res.nx = bnx; res.ny = bny; res.nz = bnz;
    res.c = best === 'ground' ? null : best;
    return res;
  }

  _rayBox(c, ox, oy, oz, dx, dy, dz, maxT) {
    let tmin = 0, tmax = maxT, nx = 0, ny = 0, nz = 0;
    // X
    if (Math.abs(dx) < 1e-12) { if (ox < c.minX || ox > c.maxX) return null; }
    else {
      let t1 = (c.minX - ox) / dx, t2 = (c.maxX - ox) / dx, n = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
      if (t1 > tmin) { tmin = t1; nx = n; ny = 0; nz = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (Math.abs(dy) < 1e-12) { if (oy < c.minY || oy > c.maxY) return null; }
    else {
      let t1 = (c.minY - oy) / dy, t2 = (c.maxY - oy) / dy, n = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
      if (t1 > tmin) { tmin = t1; nx = 0; ny = n; nz = 0; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (Math.abs(dz) < 1e-12) { if (oz < c.minZ || oz > c.maxZ) return null; }
    else {
      let t1 = (c.minZ - oz) / dz, t2 = (c.maxZ - oz) / dz, n = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; n = 1; }
      if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = n; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    return { t: tmin, nx, ny, nz };
  }

  _rayWedge(c, ox, oy, oz, dx, dy, dz, maxT) {
    // convex polyhedron of half-spaces n.p <= d
    const s = c.slope;
    const planes = [
      [-1, 0, 0, -c.minX], [1, 0, 0, c.maxX],
      [0, 0, -1, -c.minZ], [0, 0, 1, c.maxZ],
      [0, -1, 0, -c.minY],
      s.axis === 'x' ? [-s.k, 1, 0, s.y0 - s.k * s.lo] : [0, 1, -s.k, s.y0 - s.k * s.lo],
    ];
    let tEnter = 0, tExit = maxT, en = null;
    for (const p of planes) {
      const denom = p[0] * dx + p[1] * dy + p[2] * dz;
      const dist = p[3] - (p[0] * ox + p[1] * oy + p[2] * oz);
      if (Math.abs(denom) < 1e-12) {
        if (dist < 0) return null;
        continue;
      }
      const t = dist / denom;
      if (denom < 0) { if (t > tEnter) { tEnter = t; en = p; } }
      else if (t < tExit) tExit = t;
      if (tEnter > tExit) return null;
    }
    if (!en) return { t: 0, nx: 0, ny: 1, nz: 0 };
    const l = Math.hypot(en[0], en[1], en[2]);
    return { t: tEnter, nx: en[0] / l, ny: en[1] / l, nz: en[2] / l };
  }

  /** Line of sight between two points (true = clear). */
  lineClear(ax, ay, az, bx, by, bz, filter = sightFilter) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    return this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.05, filter) === null;
  }
}

export const sightFilter = (c) => c.blocksSight;
export const cameraFilter = (c) => c.blocksCamera;
