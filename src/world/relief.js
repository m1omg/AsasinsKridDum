// The relief of the facades: decorations that stand out from the walls without colliding
// (window frames, shutters and sills, door frames, cornices, plinths, ledges, the cathedral's
// bands and tracery). Only the climbing animation reads it: hands and feet rest on these
// surfaces and the climbing body is held clear of them. Axis-aligned boxes in a grid on the
// XZ plane, stored flat; queries are short rays.

const CELL = 4;
const ORIGIN = -192;
const DIM = 96; // covers [-192, 192)

const cell = (v) => {
  const i = Math.floor((v - ORIGIN) / CELL);
  return i < 0 ? 0 : i >= DIM ? DIM - 1 : i;
};

export class ReliefMap {
  constructor() {
    this.list = []; // minX, minY, minZ, maxX, maxY, maxZ per box
    this.box = null; // the same, packed once built
    this.start = null; // per cell: first index into `items`
    this.items = null; // box indices, cell by cell
    this.stamp = null;
    this.mark = 0;
  }

  get count() { return this.list.length / 6; }

  add(x0, y0, z0, x1, y1, z1) {
    this.list.push(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
    this.box = null;
  }

  /**
   * A box given in a facade's frame: origin (x, y, z), turned by `yaw` (a multiple of a right
   * angle) the way the instanced decorations are, so local +z points out of the wall.
   */
  addLocal(x, y, z, yaw, lx0, ly0, lz0, lx1, ly1, lz1) {
    const c = Math.round(Math.cos(yaw)), s = Math.round(Math.sin(yaw));
    this.add(x + lx0 * c + lz0 * s, y + ly0, z - lx0 * s + lz0 * c, x + lx1 * c + lz1 * s, y + ly1, z - lx1 * s + lz1 * c);
  }

  build() {
    const n = this.count;
    const box = (this.box = new Float32Array(this.list));
    const counts = new Int32Array(DIM * DIM + 1);
    const span = (i, f) => {
      const x0 = cell(box[i * 6]), x1 = cell(box[i * 6 + 3]);
      const z0 = cell(box[i * 6 + 2]), z1 = cell(box[i * 6 + 5]);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) f(iz * DIM + ix);
    };
    for (let i = 0; i < n; i++) span(i, (c) => counts[c + 1]++);
    for (let c = 0; c < DIM * DIM; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[DIM * DIM]);
    const fill = counts.slice(0, DIM * DIM);
    for (let i = 0; i < n; i++) span(i, (c) => { items[fill[c]++] = i; });
    this.start = counts;
    this.items = items;
    this.stamp = new Uint32Array(n);
    this.mark = 0;
    return this;
  }

  /** fn(minX, minY, minZ, maxX, maxY, maxZ) for every box whose footprint overlaps the rectangle. */
  each(minX, minZ, maxX, maxZ, fn) {
    if (!this.box) this.build();
    const box = this.box;
    if (this.mark >= 0xfffffff0) { this.stamp.fill(0); this.mark = 0; }
    const m = ++this.mark;
    for (let iz = cell(minZ), z1 = cell(maxZ); iz <= z1; iz++) {
      for (let ix = cell(minX), x1 = cell(maxX); ix <= x1; ix++) {
        const c = iz * DIM + ix;
        for (let k = this.start[c], end = this.start[c + 1]; k < end; k++) {
          const i = this.items[k];
          if (this.stamp[i] === m) continue;
          this.stamp[i] = m;
          const b = i * 6;
          if (box[b + 3] < minX || box[b] > maxX || box[b + 5] < minZ || box[b + 2] > maxZ) continue;
          fn(box[b], box[b + 1], box[b + 2], box[b + 3], box[b + 4], box[b + 5]);
        }
      }
    }
  }

  /**
   * First box surface the ray (o + d t, 0 <= t <= maxT) enters, or null. Boxes the ray starts
   * inside are passed through. res: { t, x, y, z, nx, ny, nz }.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxT, res = {}) {
    if (!this.box) this.build();
    const box = this.box;
    const ex = ox + dx * maxT, ez = oz + dz * maxT;
    const x0 = cell(Math.min(ox, ex)), x1 = cell(Math.max(ox, ex));
    const z0 = cell(Math.min(oz, ez)), z1 = cell(Math.max(oz, ez));
    if (this.mark >= 0xfffffff0) { this.stamp.fill(0); this.mark = 0; }
    const m = ++this.mark;
    let best = maxT, hit = false, bnx = 0, bny = 0, bnz = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const c = iz * DIM + ix;
        for (let k = this.start[c], end = this.start[c + 1]; k < end; k++) {
          const i = this.items[k];
          if (this.stamp[i] === m) continue;
          this.stamp[i] = m;
          const b = i * 6;
          let t0 = 0, t1 = best, nx = 0, ny = 0, nz = 0;
          // slabs: x, y, z
          if (Math.abs(dx) < 1e-9) { if (ox < box[b] || ox > box[b + 3]) continue; }
          else {
            let a = (box[b] - ox) / dx, e = (box[b + 3] - ox) / dx, s = -1;
            if (a > e) { const q = a; a = e; e = q; s = 1; }
            if (a > t0) { t0 = a; nx = s; }
            if (e < t1) t1 = e;
            if (t0 > t1) continue;
          }
          if (Math.abs(dy) < 1e-9) { if (oy < box[b + 1] || oy > box[b + 4]) continue; }
          else {
            let a = (box[b + 1] - oy) / dy, e = (box[b + 4] - oy) / dy, s = -1;
            if (a > e) { const q = a; a = e; e = q; s = 1; }
            if (a > t0) { t0 = a; nx = 0; ny = s; }
            if (e < t1) t1 = e;
            if (t0 > t1) continue;
          }
          if (Math.abs(dz) < 1e-9) { if (oz < box[b + 2] || oz > box[b + 5]) continue; }
          else {
            let a = (box[b + 2] - oz) / dz, e = (box[b + 5] - oz) / dz, s = -1;
            if (a > e) { const q = a; a = e; e = q; s = 1; }
            if (a > t0) { t0 = a; nx = 0; ny = 0; nz = s; }
            if (e < t1) t1 = e;
            if (t0 > t1) continue;
          }
          if (nx === 0 && ny === 0 && nz === 0) continue; // starts inside this box: look past it
          if (t0 < best || (!hit && t0 <= best)) { best = t0; hit = true; bnx = nx; bny = ny; bnz = nz; }
        }
      }
    }
    if (!hit) return null;
    res.t = best;
    res.x = ox + dx * best; res.y = oy + dy * best; res.z = oz + dz * best;
    res.nx = bnx; res.ny = bny; res.nz = bnz;
    return res;
  }
}
