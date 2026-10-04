// Small math helpers. Every smoothing helper takes dt so behaviour is identical
// at any frame rate / display refresh rate.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap01 = (a, b, v) => clamp01(invLerp(a, b, v));
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const sign = (v) => (v < 0 ? -1 : 1);

/** Exponential smoothing factor for a rate (1/s) over dt seconds. */
export const dampFactor = (lambda, dt) => 1 - Math.exp(-lambda * dt);
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDiff = (from, to) => wrapAngle(to - from);
export const dampAngle = (a, b, lambda, dt) => a + angleDiff(a, b) * (1 - Math.exp(-lambda * dt));
export const lerpAngle = (a, b, t) => a + angleDiff(a, b) * t;

/** Move value toward target by at most maxDelta. */
export function approach(v, target, maxDelta) {
  if (v < target) return Math.min(v + maxDelta, target);
  return Math.max(v - maxDelta, target);
}
export function approachAngle(a, b, maxDelta) {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

export const dist2 = (ax, az, bx, bz) => {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};
export const dist3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};
/** Yaw (radians) that faces from a toward b. yaw 0 faces +Z. */
export const yawTo = (ax, az, bx, bz) => Math.atan2(bx - ax, bz - az);

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (a, b) => a + (b - a) * rng();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * rng());
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

export const rand = (a = 0, b = 1) => a + (b - a) * Math.random();
export const randInt = (a, b) => Math.floor(a + (b - a + 1) * Math.random());
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Cheap 2D value noise in [0,1] (for procedural decoration, not gameplay). */
export function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
