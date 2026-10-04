// Ground-level navigation grid for demons: A* for patrols / investigation and
// a Dijkstra flow field toward the player for combat chasing.

export class NavGrid {
  constructor(minX, minZ, size, cell = 1) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.w = Math.ceil(size / cell);
    this.h = this.w;
    this.walk = new Uint8Array(this.w * this.h);
    this.flow = new Float32Array(this.w * this.h).fill(Infinity);
    this.flowStamp = 0;
    this.flowTarget = -1;
    // A* scratch
    this.g = new Float32Array(this.w * this.h);
    this.f = new Float32Array(this.w * this.h);
    this.parent = new Int32Array(this.w * this.h);
    this.seen = new Uint32Array(this.w * this.h);
    this.closed = new Uint32Array(this.w * this.h);
    this.searchId = 0;
    this.heap = new Int32Array(this.w * this.h * 4);
    this.heapKey = new Float32Array(this.w * this.h * 4);
  }

  // binary heap of (key, node) pairs; keys are copied at push time so lazy
  // re-insertion with a smaller key keeps the heap valid
  _hpush(k, key) {
    const heap = this.heap, hk = this.heapKey;
    if (this.hs >= heap.length) return;
    let i = this.hs++;
    heap[i] = k; hk[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p] <= hk[i]) break;
      let t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
      i = p;
    }
  }

  _hpop() {
    const heap = this.heap, hk = this.heapKey;
    const top = heap[0];
    this.hs--;
    heap[0] = heap[this.hs]; hk[0] = hk[this.hs];
    let i = 0;
    const n = this.hs;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && hk[l] < hk[m]) m = l;
      if (r < n && hk[r] < hk[m]) m = r;
      if (m === i) break;
      let t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
      i = m;
    }
    return top;
  }

  build(collision) {
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = this.minX + (i + 0.5) * this.cell;
        const z = this.minZ + (j + 0.5) * this.cell;
        this.walk[j * this.w + i] = collision.isFree(x, z, 0.42, 0.3, 1.8) ? 1 : 0;
      }
    }
  }

  idx(x, z) {
    const i = Math.floor((x - this.minX) / this.cell);
    const j = Math.floor((z - this.minZ) / this.cell);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  cx(idx) { return this.minX + ((idx % this.w) + 0.5) * this.cell; }
  cz(idx) { return this.minZ + (Math.floor(idx / this.w) + 0.5) * this.cell; }

  walkable(x, z) {
    const k = this.idx(x, z);
    return k >= 0 && this.walk[k] === 1;
  }

  /** Nearest walkable cell index to (x,z) within radius cells. */
  nearestWalkable(x, z, radius = 6) {
    const k0 = this.idx(x, z);
    if (k0 >= 0 && this.walk[k0]) return k0;
    const i0 = Math.floor((x - this.minX) / this.cell), j0 = Math.floor((z - this.minZ) / this.cell);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= radius; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di, j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          const k = j * this.w + i;
          if (!this.walk[k]) continue;
          const d = di * di + dj * dj;
          if (d < bd) { bd = d; best = k; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Bresenham-ish walkability check between two points (for path smoothing). */
  lineWalkable(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const steps = Math.ceil(len / (this.cell * 0.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + dx * t, z = az + dz * t;
      if (!this.walkable(x, z)) return false;
      // keep a margin from walls
      const ox = -dz / (len || 1) * 0.35, oz = dx / (len || 1) * 0.35;
      if (!this.walkable(x + ox, z + oz) || !this.walkable(x - ox, z - oz)) return false;
    }
    return true;
  }

  /** A* path between world points. Returns array of {x,z} or null. */
  findPath(sx, sz, tx, tz, maxNodes = 9000) {
    const start = this.nearestWalkable(sx, sz, 4);
    const goal = this.nearestWalkable(tx, tz, 6);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [{ x: tx, z: tz }];
    const W = this.w, H = this.h;
    const id = ++this.searchId;
    const g = this.g, f = this.f, parent = this.parent, seen = this.seen, closed = this.closed;
    this.hs = 0;
    const gx = goal % W, gz = Math.floor(goal / W);
    const heur = (k) => {
      const dx = Math.abs((k % W) - gx), dz = Math.abs(Math.floor(k / W) - gz);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    g[start] = 0;
    f[start] = heur(start);
    seen[start] = id;
    parent[start] = -1;
    this._hpush(start, f[start]);
    let expanded = 0, found = false;
    while (this.hs > 0) {
      const cur = this._hpop();
      if (closed[cur] === id) continue;
      closed[cur] = id;
      if (cur === goal) { found = true; break; }
      if (++expanded > maxNodes) break;
      const ci = cur % W, cj = Math.floor(cur / W);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nk = nj * W + ni;
          if (!this.walk[nk] || closed[nk] === id) continue;
          if (di && dj && (!this.walk[cj * W + ni] || !this.walk[nj * W + ci])) continue;
          const ng = g[cur] + (di && dj ? Math.SQRT2 : 1);
          if (seen[nk] !== id || ng < g[nk]) {
            seen[nk] = id;
            g[nk] = ng;
            f[nk] = ng + heur(nk);
            parent[nk] = cur;
            this._hpush(nk, f[nk]);
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let k = goal; k !== -1; k = parent[k]) cells.push(k);
    cells.reverse();
    // string pulling
    const pts = cells.map((k) => ({ x: this.cx(k), z: this.cz(k) }));
    pts[pts.length - 1] = { x: tx, z: tz };
    const out = [];
    let anchor = { x: sx, z: sz };
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.lineWalkable(anchor.x, anchor.z, pts[j].x, pts[j].z)) j--;
      out.push(pts[j]);
      anchor = pts[j];
      i = j + 1;
    }
    return out;
  }

  /** Dijkstra flow field from (tx,tz) out to maxDist (in cells). */
  buildFlow(tx, tz, maxDist = 70) {
    const goal = this.nearestWalkable(tx, tz, 8);
    if (goal < 0) return false;
    if (goal === this.flowTarget) return true;
    this.flowTarget = goal;
    const W = this.w, H = this.h;
    const dist = this.flow;
    dist.fill(Infinity);
    this.hs = 0;
    dist[goal] = 0;
    this._hpush(goal, 0);
    while (this.hs > 0) {
      const cur = this._hpop();
      const dc = dist[cur];
      if (dc > maxDist) continue;
      const ci = cur % W, cj = Math.floor(cur / W);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const nk = nj * W + ni;
          if (!this.walk[nk]) continue;
          if (di && dj && (!this.walk[cj * W + ni] || !this.walk[nj * W + ci])) continue;
          const nd = dc + (di && dj ? Math.SQRT2 : 1);
          if (nd < dist[nk]) { dist[nk] = nd; this._hpush(nk, nd); }
        }
      }
    }
    return true;
  }

  /** Direction (unit) down the flow field from (x,z), or null when unreachable. */
  flowDir(x, z, out) {
    const k = this.idx(x, z);
    if (k < 0) return null;
    const W = this.w, H = this.h;
    const ci = k % W, cj = Math.floor(k / W);
    let best = this.walk[k] ? this.flow[k] : Infinity, bi = 0, bj = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni;
        if (!this.walk[nk]) continue;
        if (di && dj && (!this.walk[cj * W + ni] || !this.walk[nj * W + ci])) continue;
        const d = this.flow[nk] + (di && dj ? 0.0001 : 0);
        if (d < best) { best = d; bi = di; bj = dj; }
      }
    }
    if (best === Infinity || (!bi && !bj)) return null;
    // aim at the neighbour cell centre for smoother motion
    const tx = this.minX + (ci + bi + 0.5) * this.cell;
    const tz = this.minZ + (cj + bj + 0.5) * this.cell;
    const dx = tx - x, dz = tz - z;
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l;
    out.z = dz / l;
    out.d = this.flow[k];
    return out;
  }

  flowDist(x, z) {
    const k = this.idx(x, z);
    return k < 0 ? Infinity : this.flow[k];
  }
}
