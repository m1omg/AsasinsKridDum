// =============================================================================
//  HELLCREED - procedural audio engine (Web Audio API, zero asset files)
// =============================================================================
//  Every sound effect and all music is synthesized at runtime:
//
//  * One-shot SFX are small synthesis graphs (oscillators, looping noise
//    buffers, biquads, wave shapers, JS-generated grain textures). Each one is
//    pre-rendered once into a few AudioBuffer variants with OfflineAudioContext
//    (the render itself runs off the main thread) and is then played through
//    cheap AudioBufferSourceNodes. Until a sound's buffers exist it is
//    synthesized live with the very same graph code, so a first play is never
//    silent.
//  * Loops are tiny live graphs or seamless pre-rendered buffers.
//  * Music is sequenced on the AudioContext clock by a lookahead scheduler
//    (setInterval ~25 ms, events scheduled ~0.15 s ahead). Nothing depends on
//    requestAnimationFrame, frame counts or the display refresh rate.
//
//  Bus layout
//    sfx voices ---> sfxBus ----\
//    music tracks -> musicBus ---+-> pauseFilter -\
//    sfxSend + musicSend -> convolver -> revReturn -+-> masterIn
//    ui sounds ----> uiBus (never ducked by pause) --> masterIn
//    masterIn -> compressor -> limiter -> masterGain -> destination
// =============================================================================

// -----------------------------------------------------------------------------
// Environment & constants
// -----------------------------------------------------------------------------
const GLOBAL = typeof globalThis !== 'undefined' ? globalThis : {};
const AudioCtx = GLOBAL.AudioContext || GLOBAL.webkitAudioContext || null;
const OfflineCtx = GLOBAL.OfflineAudioContext || GLOBAL.webkitOfflineAudioContext || null;

const MAX_VOICES = 40; // concurrent one-shot voices
const REPEAT_GUARD = 0.03; // same name re-triggered within this window is dropped
const LOOKAHEAD = 0.15; // music scheduling horizon (s)
const LOOKAHEAD_HIDDEN = 1.3; // background tabs throttle timers to ~1 s
const TICK_MS = 25; // scheduler period
const EPS = 1e-4;
const MUSIC_MODES = ['none', 'title', 'explore', 'stealth', 'combat', 'boss', 'victory'];
const MUSIC_LEVEL = 0.62; // music sits below sfx in the mix

// -----------------------------------------------------------------------------
// Small math helpers
// -----------------------------------------------------------------------------
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const st = (semis) => Math.pow(2, semis / 12);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

// Inverse distance model (same formula the PannerNode uses) for voice priority.
const PAN_REF = 3, PAN_ROLL = 1.1, PAN_MAX = 90;
function distGain(d) {
  const dd = clamp(d, PAN_REF, PAN_MAX);
  return PAN_REF / (PAN_REF + PAN_ROLL * (dd - PAN_REF));
}

// Ramp an AudioParam from its current value without clicks.
function rampTo(param, v, t, tau = 0.05) {
  try {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else { const cur = param.value; param.cancelScheduledValues(t); param.setValueAtTime(cur, t); }
    param.setTargetAtTime(v, t, tau);
  } catch (e) { param.value = v; }
}

// -----------------------------------------------------------------------------
// Wave-shaper curves (cached, shared by every context)
// -----------------------------------------------------------------------------
const curveCache = new Map();
/** tanh soft clipper; asym > 0 adds even harmonics (tube-like). */
function driveCurve(k = 3, asym = 0) {
  const key = k + ':' + asym;
  let c = curveCache.get(key);
  if (c) return c;
  const n = 4096;
  c = new Float32Array(n);
  const off = Math.tanh(k * asym);
  const norm = Math.max(Math.abs(Math.tanh(k * (1 + asym)) - off), Math.abs(Math.tanh(k * (-1 + asym)) - off)) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(k * (x + asym)) - off) / norm;
  }
  curveCache.set(key, c);
  return c;
}

// -----------------------------------------------------------------------------
// Buffer generation: noise, reverb impulse, JS DSP grains
// -----------------------------------------------------------------------------
function makeBuffer(ctx, channels, length, sr) {
  return ctx.createBuffer(channels, Math.max(1, length), sr || ctx.sampleRate);
}

function fillNoise(d, kind) {
  const n = d.length;
  if (kind === 'pink') {
    // Paul Kellet's refined pink filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (kind === 'brown') {
    let l = 0;
    for (let i = 0; i < n; i++) {
      l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = l * 3.5;
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
}

/** Equal-power crossfade of a signal's tail into its head -> seamless loop of length n. */
function seamless(src, n, x) {
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < x; i++) {
    const t = i / x;
    out[i] = src[i] * Math.sin(t * Math.PI * 0.5) + src[n + i] * Math.cos(t * Math.PI * 0.5);
  }
  return out;
}

/** Seamless looping noise buffer. */
function makeNoise(ctx, kind, seconds) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds), x = Math.floor(sr * 0.05);
  const raw = new Float32Array(n + x);
  fillNoise(raw, kind);
  const b = makeBuffer(ctx, 1, n, sr);
  b.getChannelData(0).set(seamless(raw, n, x));
  return b;
}

/**
 * One channel of a generated ~2.3 s dark stone-hall impulse: sparse early reflections and a
 * noise tail whose low-pass closes as it decays. Returns the channel energy.
 */
function fillImpulse(d, sr) {
  const n = d.length, pre = Math.floor(sr * 0.014), m = n - pre, block = 64;
  let lp = 0, lp2 = 0, energy = 0;
  for (let i0 = 0; i0 < m; i0 += block) {
    const t = i0 / m;
    // envelope and darkening filter are updated per 64-sample block (cheap)
    const env = Math.pow(1 - t, 1.6) * Math.exp(-t * 3.2) * (1 + 2.5 * t);
    const a = Math.exp((-2 * Math.PI * 6500 * Math.pow(0.07, t)) / sr), ia = 1 - a;
    const end = Math.min(m, i0 + block);
    for (let i = i0; i < end; i++) {
      lp = lp * a + (Math.random() * 2 - 1) * ia;
      lp2 = lp2 * a + lp * ia;
      d[pre + i] = lp2 * env;
    }
  }
  for (let r = 0; r < 9; r++) d[pre + Math.floor(sr * rand(0.004, 0.075))] += rand(-1, 1) * 0.35 * (1 - r / 12);
  for (let i = 0; i < n; i++) energy += d[i] * d[i];
  return energy;
}

/** Scale an array so its absolute peak equals `peak`. */
function normalize(d, peak = 1) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
  if (m > 1e-9) { const s = peak / m; for (let i = 0; i < d.length; i++) d[i] *= s; }
  return d;
}

/**
 * Resonant noise grain: a short decaying noise burst through a 2-pole resonator.
 * The building block for crackles, straw, gravel, gore and creaks.
 */
function grain(d, sr, t, dur, f, q, amp) {
  const i0 = Math.floor(t * sr);
  if (i0 < 0 || i0 >= d.length) return;
  const fc = Math.min(f, sr * 0.45), bw = fc / q;
  const r = Math.exp((-Math.PI * bw) / sr);
  const b1 = 2 * r * Math.cos((2 * Math.PI * fc) / sr), b2 = -r * r;
  const len = Math.max(2, Math.floor(dur * sr));
  const end = Math.min(d.length - i0, len + Math.floor((sr * 4) / (Math.PI * bw)));
  const k = Math.exp(-5 / len);
  let e = (1 - r) * 3 * amp, y1 = 0, y2 = 0;
  for (let j = 0; j < end; j++) {
    const x = j < len ? (Math.random() * 2 - 1) * e : 0;
    e *= k;
    const y = x + b1 * y1 + b2 * y2;
    y2 = y1; y1 = y;
    d[i0 + j] += y;
  }
}

/** Decaying sine partial (glass shards, coins, sparkles). Recursive oscillator: no per-sample trig. */
function partial(d, sr, t, f, decay, amp) {
  const i0 = Math.floor(t * sr);
  if (i0 < 0 || i0 >= d.length || f >= sr * 0.48) return;
  const len = Math.min(d.length - i0, Math.floor(decay * 5.5 * sr));
  const w = (2 * Math.PI * f) / sr, c2 = 2 * Math.cos(w), k = Math.exp(-1 / (decay * sr));
  const att = Math.max(1, Math.floor(sr * 0.0015));
  const ph = Math.random() * Math.PI * 2;
  let s1 = Math.sin(ph - w), s0 = Math.sin(ph - 2 * w), e = amp;
  for (let j = 0; j < len; j++) {
    const s = c2 * s1 - s0;
    s0 = s1; s1 = s;
    d[i0 + j] += (j < att ? (e * j) / att : e) * s;
    e *= k;
  }
}

/** Random crackle / debris field. density shapes how front-loaded the grains are. */
function crackles(d, sr, count, span, fLo, fHi, durLo, durHi, qLo = 3, qHi = 9, front = 1.6) {
  for (let i = 0; i < count; i++) {
    const t = Math.pow(Math.random(), front) * span;
    const fade = Math.max(0, 1 - t / (span * 1.15));
    grain(d, sr, t, rand(durLo, durHi), rand(fLo, fHi), rand(qLo, qHi), rand(0.25, 1) * fade);
  }
}

/** Final stage of every SFX graph: 25 Hz high-pass (removes inaudible sub-bass / DC). */
function sfxOut(ctx, dest) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 25;
  hp.Q.value = 0.6;
  hp.connect(dest);
  return hp;
}

/** OfflineAudioContext render that works with both promise and event APIs. */
function renderOffline(oc) {
  return new Promise((resolve, reject) => {
    try {
      oc.oncomplete = (e) => resolve(e.renderedBuffer);
      const p = oc.startRendering();
      if (p && p.then) p.then(resolve, reject);
    } catch (e) { reject(e); }
  });
}

// =============================================================================
// Synthesis kit
// -----------------------------------------------------------------------------
// Builds Web Audio graphs on ANY BaseAudioContext: an OfflineAudioContext for
// pre-rendering, or the realtime context for the live fallback. Every `dt`
// argument is a time offset (s) from the kit's start time t0.
// =============================================================================
class Kit {
  constructor(ctx, out, t0, res) {
    this.c = ctx;
    this.out = out;
    this.t0 = t0;
    this.res = res; // shared resources: { noise: { white, pink, brown } }
    this.sr = ctx.sampleRate;
  }
  at(dt) { return Math.max(0, this.t0 + (dt || 0)); }

  // ---- node factories -------------------------------------------------------
  gain(v = 1, dest = this.out) {
    const g = this.c.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  filter(type, f = 1000, q = 0.707, dest = this.out, db = 0) {
    const n = this.c.createBiquadFilter();
    n.type = type;
    n.frequency.value = Math.min(f, this.sr * 0.45);
    n.Q.value = q;
    if (db) n.gain.value = db;
    if (dest) n.connect(dest);
    return n;
  }
  drive(k = 3, dest = this.out, asym = 0) {
    const n = this.c.createWaveShaper();
    n.curve = driveCurve(k, asym);
    n.oversample = '4x';
    if (dest) n.connect(dest);
    return n;
  }
  osc(type, f, dt, dur, dest) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (dest) o.connect(dest);
    const t = this.at(dt);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }
  noise(kind, dt, dur, dest, rate = 1) {
    const b = this.res.noise[kind] || this.res.noise.white;
    const s = this.c.createBufferSource();
    s.buffer = b;
    s.loop = true;
    s.playbackRate.value = rate;
    if (dest) s.connect(dest);
    const t = this.at(dt);
    s.start(t, Math.random() * b.duration * 0.9);
    s.stop(t + dur + 0.05);
    return s;
  }
  lfo(rate, depth, dt, dur, param, type = 'sine') {
    const g = this.gain(depth, null);
    g.connect(param);
    return this.osc(type, rate, dt, dur, g);
  }

  // ---- automation -----------------------------------------------------------
  /** Linear attack -> hold -> exponential decay to -60 dB (click free). */
  env(param, dt, a, h, d, peak = 1) {
    const t = this.at(dt);
    a = Math.max(a, 0.0005);
    d = Math.max(d, 0.005);
    peak = Math.max(peak, EPS * 2);
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    if (h > 0) param.setValueAtTime(peak, t + a + h);
    param.exponentialRampToValueAtTime(peak * 0.001, t + a + h + d);
    return a + h + d;
  }
  /** Breakpoints [[t, v], ...] joined by exponential (default) or linear ramps. */
  path(param, dt, pts, lin = false) {
    const t = this.at(dt);
    param.setValueAtTime(pts[0][1], t + pts[0][0]);
    for (let i = 1; i < pts.length; i++) {
      const [pt, v] = pts[i];
      if (lin) param.linearRampToValueAtTime(v, t + pt);
      else param.exponentialRampToValueAtTime(Math.max(v, EPS), t + pt);
    }
  }
  /** Number or breakpoint path. */
  fp(param, dt, f) {
    if (Array.isArray(f)) this.path(param, dt, f);
    else param.setValueAtTime(f, this.at(dt));
  }

  // ---- generic voices -------------------------------------------------------
  /** Filter chain feeding `dest`: source -> drive -> hp -> bp -> lp -> dest. Returns the input. */
  chain(dest, o, dt) {
    let head = dest;
    if (o.lp) { const f = this.filter('lowpass', 1000, o.lq ?? 0.7, head); this.fp(f.frequency, dt, o.lp); head = f; }
    if (o.bp) { const f = this.filter('bandpass', 1000, o.bq ?? 1, head); this.fp(f.frequency, dt, o.bp); head = f; }
    if (o.hp) { const f = this.filter('highpass', 1000, o.hq ?? 0.7, head); this.fp(f.frequency, dt, o.hp); head = f; }
    if (o.drive) head = this.drive(o.drive, head);
    return head;
  }
  /** Tremolo / flutter gain stage in front of `dest`. am = [rate, depth(0..1), rateEnd?]. */
  trem(dest, am, dt, dur) {
    const [rate, depth, rate2] = am;
    const g = this.gain(1 - depth * 0.5, dest);
    const o = this.lfo(rate, depth * 0.5, dt, dur, g.gain);
    if (rate2) this.path(o.frequency, dt, [[0, rate], [dur, rate2]]);
    return g;
  }
  /**
   * Oscillator voice.
   * o: { type, f (Hz | path), dt, a, h, d, g, det, vib:[rate, cents], am:[rate, depth, rateEnd],
   *      lp/bp/hp (Hz | path), lq/bq/hq, drive, dest }
   */
  tone(o) {
    const dt = o.dt || 0, a = o.a ?? 0.004, h = o.h ?? 0, d = o.d ?? 0.2, dur = a + h + d;
    const amp = this.gain(0, o.dest || this.out);
    this.env(amp.gain, dt, a, h, d, o.g ?? 0.3);
    let head = this.chain(amp, o, dt);
    if (o.am) head = this.trem(head, o.am, dt, dur);
    const osc = this.osc(o.type || 'sine', Array.isArray(o.f) ? o.f[0][1] : o.f, dt, dur, head);
    this.fp(osc.frequency, dt, o.f);
    if (o.det) osc.detune.value = o.det;
    if (o.vib) this.lfo(o.vib[0], o.vib[1], dt, dur, osc.detune);
    return amp;
  }
  /**
   * Filtered noise burst.
   * o: { n:'white'|'pink'|'brown', dt, a, h, d, g, ft (filter type), f (Hz | path), q,
   *      lp/bp/hp, drive, am, rate, dest }
   */
  nz(o) {
    const dt = o.dt || 0, a = o.a ?? 0.002, h = o.h ?? 0, d = o.d ?? 0.1, dur = a + h + d;
    const amp = this.gain(0, o.dest || this.out);
    this.env(amp.gain, dt, a, h, d, o.g ?? 0.5);
    let head = this.chain(amp, o, dt);
    if (o.f) { const f = this.filter(o.ft || 'bandpass', 1000, o.q ?? 1, head); this.fp(f.frequency, dt, o.f); head = f; }
    if (o.am) head = this.trem(head, o.am, dt, dur);
    const src = this.noise(o.n || 'white', dt, dur, head, o.rate || 1);
    if (o.wob) this.lfo(rand(0.13, 0.31), o.wob, dt, dur, src.playbackRate); // de-correlates noise repeats
    return amp;
  }
  /** JS-synthesized texture (grains, partials) played from a buffer. */
  tex(dt, dur, fn, g = 1, dest = this.out, peak = 1) {
    const n = Math.max(1, Math.ceil(dur * this.sr));
    const d = new Float32Array(n);
    fn(d, this.sr);
    normalize(d, peak);
    const b = makeBuffer(this.c, 1, n, this.sr);
    b.getChannelData(0).set(d);
    const s = this.c.createBufferSource();
    s.buffer = b;
    s.connect(this.gain(g, dest));
    s.start(this.at(dt));
    return s;
  }

  // ---- higher level instruments --------------------------------------------
  /** Band-passed air rush whose centre sweeps f0 -> f1 (at 45%) -> f2. */
  whoosh(dt, dur, f0, f1, f2, q, g, n = 'pink') {
    return this.nz({ n, dt, a: dur * 0.42, d: dur * 0.58, g, f: [[0, f0], [dur * 0.45, f1], [dur, f2]], q });
  }
  /** Pitch-dropping sine thud (body impacts, footfalls, kick-like hits). */
  thump(dt, f0, f1, d, g, type = 'sine') {
    return this.tone({ type, dt, a: 0.0015, d, g, f: [[0, f0], [d * 0.7, f1]] });
  }
  /** Struck metal: inharmonic sine partials with their own decays + a bright tick. */
  metal(dt, base, ratios, decays, g, pair = false) {
    ratios.forEach((r, i) => {
      const amp = g / Math.pow(i + 1, 0.6);
      const f = base * r * rand(0.997, 1.003);
      const d = decays[i] ?? 0.1;
      this.tone({ type: 'sine', f, dt, a: 0.0012, d, g: amp });
      if (pair && i < 3) this.tone({ type: 'sine', f: f * 1.0035 + 1.3, dt, a: 0.0012, d: d * 0.9, g: amp * 0.6 });
    });
    this.nz({ n: 'white', dt, a: 0.0006, d: 0.02, g: g * 0.6, ft: 'highpass', f: Math.min(base * 2, 6000) });
  }
  /** Glassy sine chime. */
  chime(dt, f, d, g) {
    this.tone({ type: 'sine', f, dt, a: 0.002, d, g });
    this.tone({ type: 'sine', f: f * 2.76, dt, a: 0.002, d: d * 0.45, g: g * 0.25 });
    this.tone({ type: 'sine', f: f * 5.4, dt, a: 0.002, d: d * 0.2, g: g * 0.08 });
  }
  /** Church bell: hum, prime, minor-third tierce, quint, nominal... with slow beating pairs. */
  bell(dt, f, dur, g, bright = 1) {
    const P = [[0.5, 0.9, 1], [1, 0.75, 0.7], [1.19, 0.55, 0.5], [1.5, 0.35, 0.42], [2, 0.6, 0.36],
      [2.51, 0.28, 0.25], [2.66, 0.22, 0.2], [3.01, 0.22 * bright, 0.15], [4.17, 0.15 * bright, 0.1], [5.43, 0.1 * bright, 0.07]];
    for (const [r, a, k] of P) {
      const fr = f * r;
      if (fr > this.sr * 0.45) continue;
      this.tone({ type: 'sine', f: fr, dt, a: 0.002, d: dur * k, g: g * a * 0.3 });
      if (r <= 2) this.tone({ type: 'sine', f: fr + rand(0.6, 1.6), dt, a: 0.002, d: dur * k * 0.85, g: g * a * 0.18 });
    }
    this.nz({ n: 'white', dt, a: 0.001, d: 0.08, g: g * 0.25, ft: 'bandpass', f: Math.min(f * 7, 8000), q: 0.8 });
  }
  /** Low impact: sub drop + driven low-passed rumble + short crack. */
  boom(dt, dur, g, f0 = 90, f1 = 30) {
    this.tone({ type: 'sine', f: [[0, f0], [dur * 0.45, f1]], dt, a: 0.002, h: 0.03, d: dur * 0.75, g });
    this.nz({ n: 'brown', dt, a: 0.003, h: 0.04, d: dur, g: g * 0.9, ft: 'lowpass', f: [[0, 1100], [dur, 90]], q: 0.6, drive: 2 });
    this.nz({ n: 'white', dt, a: 0.0006, d: 0.1, g: g * 0.35, ft: 'lowpass', f: 3500 });
  }
  /** Rubble / gravel debris tail. */
  debris(dt, dur, g, fLo = 900, fHi = 4500, count = 40) {
    this.tex(dt, dur, (d, sr) => crackles(d, sr, count, dur * 0.85, fLo, fHi, 0.002, 0.008, 3, 10, 2.2), g);
  }
  /** Brassy horn: detuned saw stack, pitch scoop, opening low-pass and delayed vibrato. */
  brass(dt, f, dur, g) {
    const amp = this.gain(0);
    this.env(amp.gain, dt, 0.06, Math.max(0, dur - 0.55), 0.45, g);
    const lp = this.filter('lowpass', 300, 1.1, amp);
    this.path(lp.frequency, dt, [[0, 250], [0.09, 2600], [0.35, 1400], [dur, 800]]);
    const sh = this.drive(1.8, lp);
    const vib = this.gain(0, null);
    vib.gain.setValueAtTime(0, this.at(dt + 0.25));
    vib.gain.linearRampToValueAtTime(14, this.at(dt + 0.7));
    this.osc('sine', 5.2, dt, dur, vib);
    for (const [r, gg] of [[1, 0.5], [2, 0.3], [1.5, 0.18], [0.5, 0.25]]) {
      for (const det of [-7, 6]) {
        const o = this.osc('sawtooth', f * r, dt, dur, this.gain(gg * 0.5, sh));
        this.path(o.frequency, dt, [[0, f * r * 0.94], [0.1, f * r]]);
        o.detune.value = det;
        vib.connect(o.detune);
      }
    }
  }
  /** Parallel formant bank ("aah"), returns its input node. */
  formants(dest, low = false) {
    const inp = this.gain(1, null);
    const F = low ? [[650, 5, 1], [1080, 6, 0.55], [2450, 8, 0.22]]
      : [[800, 5, 1], [1150, 6, 0.6], [2900, 8, 0.25], [3900, 9, 0.1]];
    for (const [f, q, g] of F) inp.connect(this.filter('bandpass', f, q, this.gain(g * 2.2, dest)));
    return inp;
  }
  /** Choir "aah" chord (formant-filtered detuned saws). glide = semitones risen over the note. */
  choir(dt, freqs, dur, g, a = 0.3, r = 0.6, glide = 0) {
    const amp = this.gain(0);
    this.env(amp.gain, dt, a, Math.max(0, dur - a - r), r, g);
    const bank = this.formants(this.filter('lowpass', 5000, 0.7, amp), freqs[0] < 200);
    const vib = this.gain(11, null);
    this.osc('sine', 5.1, dt, dur, vib);
    for (const f of freqs) {
      for (const det of [-10, 8]) {
        const o = this.osc('sawtooth', f, dt, dur, this.gain(0.25, bank));
        o.detune.value = det + rand(-4, 4);
        vib.connect(o.detune);
        if (glide) this.path(o.frequency, dt, [[0, f], [dur * 0.75, f * st(glide)]]);
      }
    }
    this.nz({ n: 'pink', dt, a, h: Math.max(0, dur - a - r), d: r, g: g * 0.05, ft: 'bandpass', f: 2600, q: 0.8 });
  }
  /**
   * Creature vocal: saws (+sub) -> growl AM -> overdrive -> formant bank, plus breath noise.
   * o: { dt, dur, f: path, g, form: [[Hz, Q, gain]...], drive, growl:[rate, depth, rateEnd],
   *      jit (cents of random pitch wobble), breath, sub, saws, det, a, r, lp, dest }
   */
  voice(o) {
    const dt = o.dt || 0, dur = o.dur, a = o.a ?? 0.03, r = o.r ?? dur * 0.4;
    const h = Math.max(0, dur - a - r), g = o.g ?? 0.6;
    const amp = this.gain(0, o.dest || this.out);
    this.env(amp.gain, dt, a, h, r, g);
    const hp = this.filter('highpass', 32, 0.7, amp); // blocks the shaper's DC offset
    const post = o.lp ? this.filter('lowpass', o.lp, 0.7, hp) : hp;
    const bank = this.gain(1, null);
    for (const [f, q, fg] of o.form) bank.connect(this.filter('bandpass', f, q, this.gain(fg * 2, post)));
    bank.connect(this.filter('lowpass', o.form[0][0] * 0.7, 0.7, this.gain(0.35, post))); // chest
    let head = this.drive(o.drive ?? 3, bank, 0.1);
    if (o.growl) head = this.trem(head, o.growl, dt, dur);
    const pre = this.gain(0.6, head);
    const jit = o.jit ? this.gain(o.jit, null) : null;
    if (jit) this.noise('brown', dt, dur, jit, rand(0.5, 1.5));
    const n = o.saws ?? 2;
    for (let i = 0; i < n; i++) {
      const os = this.osc('sawtooth', o.f[0][1], dt, dur, pre);
      this.path(os.frequency, dt, o.f);
      os.detune.value = (i - (n - 1) / 2) * (o.det ?? 14);
      if (jit) jit.connect(os.detune);
    }
    if (o.sub) {
      const s = this.osc('sine', o.f[0][1] * 0.5, dt, dur, this.gain(o.sub, post));
      this.path(s.frequency, dt, o.f.map(([t, v]) => [t, v * 0.5]));
    }
    if (o.breath) {
      this.nz({ n: 'pink', dt, a, h, d: r, g: g * o.breath, ft: 'bandpass', f: o.form[0][0] * 1.4, q: 1.2, dest: post, am: o.growl });
    }
  }
}

// =============================================================================
// One-shot sound definitions
// -----------------------------------------------------------------------------
//   d    render length (s)              v    variants pre-rendered
//   vol  mix level (peak after calibration, at volume 1)
//   rev  reverb send                    pv   random pitch spread (+-)
//   lo   render at 22.05 kHz (bass-heavy sounds, saves memory)
//   ui   routed to the UI bus (dry, not ducked while paused)
//   r(k) synthesis recipe built with a Kit
// =============================================================================
const SFX = {
  // ------------------------------------------------------------- movement
  step: { d: 0.13, v: 6, vol: 0.26, rev: 0.03, pv: 0.07, r(k) {
    k.thump(0, rand(95, 130), 50, 0.06, 0.55);
    k.nz({ n: 'pink', a: 0.002, d: rand(0.04, 0.07), g: 0.9, ft: 'bandpass', f: rand(1100, 2000), q: 0.8 });
    k.nz({ n: 'white', dt: 0.003, a: 0.0008, d: 0.018, g: 0.3, ft: 'highpass', f: rand(4000, 6500) });
    if (chance(0.6)) k.nz({ n: 'pink', dt: rand(0.025, 0.045), a: 0.003, d: 0.035, g: 0.4, ft: 'bandpass', f: rand(1500, 2600), q: 1.1 });
  } },
  jump: { d: 0.3, v: 3, vol: 0.32, rev: 0.05, pv: 0.06, r(k) {
    k.nz({ n: 'pink', a: 0.002, d: 0.06, g: 0.8, ft: 'bandpass', f: rand(1200, 1800), q: 0.9 });
    k.thump(0, 120, 60, 0.05, 0.4);
    k.whoosh(0.02, 0.24, 350, rand(1100, 1500), 700, 0.9, 0.7);
  } },
  land: { d: 0.3, v: 4, vol: 0.42, rev: 0.05, pv: 0.06, r(k) {
    k.thump(0, rand(90, 110), 40, 0.14, 0.9);
    k.nz({ n: 'pink', a: 0.002, h: 0.01, d: 0.12, g: 0.8, ft: 'bandpass', f: rand(700, 1100), q: 0.7 });
    k.nz({ n: 'white', dt: 0.002, a: 0.001, d: 0.03, g: 0.3, ft: 'highpass', f: 4000 });
    k.nz({ n: 'pink', dt: 0.02, a: 0.01, d: 0.12, g: 0.25, ft: 'bandpass', f: 2500, q: 0.8 });
  } },
  landHeavy: { d: 0.6, v: 3, vol: 0.58, rev: 0.1, pv: 0.05, r(k) {
    k.thump(0, rand(80, 95), 32, 0.3, 1);
    k.nz({ n: 'brown', a: 0.002, h: 0.02, d: 0.25, g: 0.9, ft: 'lowpass', f: [[0, 1400], [0.2, 250]], q: 0.6 });
    k.nz({ n: 'pink', a: 0.002, d: 0.08, g: 0.6, ft: 'bandpass', f: 1500, q: 0.7 });
    k.debris(0.01, 0.5, 0.3, 1500, 5000, 26);
  } },
  climb: { d: 0.1, v: 4, vol: 0.3, rev: 0.04, pv: 0.08, r(k) {
    k.nz({ n: 'white', a: 0.0008, d: rand(0.03, 0.05), g: 1, ft: 'bandpass', f: rand(1600, 2600), q: 1.1 });
    k.nz({ n: 'pink', a: 0.001, d: 0.025, g: 0.6, ft: 'lowpass', f: 900 });
    k.thump(0, 220, 120, 0.03, 0.3);
  } },
  grab: { d: 0.2, v: 3, vol: 0.36, rev: 0.04, pv: 0.07, r(k) {
    const slap = (dt, g) => {
      k.nz({ n: 'white', dt, a: 0.0008, d: 0.04, g, ft: 'bandpass', f: rand(1500, 2400), q: 1 });
      k.thump(dt, 200, 110, 0.035, g * 0.35);
    };
    slap(0, 1);
    slap(rand(0.035, 0.06), 0.75);
    k.nz({ n: 'pink', dt: 0.01, a: 0.02, d: 0.1, g: 0.25, ft: 'bandpass', f: 3000, q: 0.7 });
  } },
  mantle: { d: 0.48, v: 3, vol: 0.36, rev: 0.04, pv: 0.06, r(k) {
    k.nz({ n: 'white', a: 0.001, d: 0.04, g: 0.8, ft: 'bandpass', f: 2000, q: 1 });
    k.nz({ n: 'pink', dt: 0.05, a: 0.12, h: 0.05, d: 0.18, g: 0.45, ft: 'bandpass', f: [[0, 900], [0.3, 1500]], q: 1.4, am: [rand(18, 26), 0.6] });
    k.whoosh(0.06, 0.3, 300, 800, 400, 0.8, 0.4);
    k.thump(0.36, 110, 55, 0.06, 0.5);
    k.nz({ n: 'pink', dt: 0.36, a: 0.002, d: 0.06, g: 0.5, ft: 'bandpass', f: 1500, q: 0.9 });
  } },
  vault: { d: 0.38, v: 3, vol: 0.38, rev: 0.04, pv: 0.06, r(k) {
    k.nz({ n: 'white', a: 0.001, d: 0.04, g: 0.8, ft: 'bandpass', f: 2100, q: 1 });
    k.thump(0, 180, 100, 0.04, 0.3);
    k.whoosh(0.02, 0.32, 300, 1300, 600, 1, 0.8);
  } },
  climbLeap: { d: 0.45, v: 3, vol: 0.4, rev: 0.05, pv: 0.06, r(k) {
    k.whoosh(0, 0.34, 250, 1100, 500, 0.9, 0.9);
    k.nz({ n: 'pink', a: 0.004, d: 0.06, g: 0.4, ft: 'bandpass', f: 1400, q: 1 });
    const t = rand(0.3, 0.36);
    k.nz({ n: 'white', dt: t, a: 0.0008, d: 0.045, g: 1, ft: 'bandpass', f: rand(1700, 2400), q: 1.1 });
    k.thump(t, 200, 110, 0.035, 0.35);
  } },
  hay: { d: 0.9, v: 3, vol: 0.45, rev: 0.03, pv: 0.06, r(k) {
    k.nz({ n: 'brown', a: 0.01, d: 0.3, g: 0.8, ft: 'lowpass', f: 500 });
    k.tex(0, 0.85, (d, sr) => crackles(d, sr, 260, 0.75, 2500, 8000, 0.0015, 0.005, 2, 6, 1.6), 0.8);
    k.nz({ n: 'white', a: 0.01, d: 0.45, g: 0.25, ft: 'highpass', f: 3500 });
  } },
  leap: { d: 1.7, v: 2, vol: 0.45, rev: 0.06, pv: 0.04, r(k) {
    k.nz({ n: 'pink', a: 1.1, h: 0.25, d: 0.3, g: 0.9, ft: 'bandpass', f: [[0, 300], [1.4, 1500]], q: 0.7, am: [rand(5, 9), 0.25] });
    k.nz({ n: 'brown', a: 0.9, h: 0.4, d: 0.35, g: 0.7, ft: 'lowpass', f: [[0, 200], [1.4, 600]] });
    k.tone({ type: 'sine', f: [[0, 700], [1.5, 1400]], a: 1, h: 0.3, d: 0.3, g: 0.03, vib: [7, 40] });
  } },
  dodge: { d: 0.33, v: 4, vol: 0.38, rev: 0.04, pv: 0.07, r(k) {
    k.nz({ n: 'pink', a: 0.07, d: 0.22, g: 0.9, ft: 'bandpass', f: [[0, 350], [0.1, rand(900, 1200)], [0.3, 450]], q: 0.8, am: [rand(22, 30), 0.35] });
    k.nz({ n: 'pink', dt: 0.005, a: 0.002, d: 0.05, g: 0.4, ft: 'bandpass', f: 1500, q: 0.9 });
  } },
  roll: { d: 0.55, v: 3, vol: 0.42, rev: 0.05, pv: 0.06, r(k) {
    k.thump(0.02, 100, 45, 0.12, 0.8);
    k.nz({ n: 'pink', a: 0.06, h: 0.1, d: 0.25, g: 0.7, ft: 'bandpass', f: [[0, 500], [0.2, 900], [0.45, 400]], q: 0.7, am: [rand(14, 20), 0.5] });
    k.thump(0.3, 90, 50, 0.09, 0.5);
    k.nz({ n: 'pink', dt: 0.3, a: 0.002, d: 0.07, g: 0.4, ft: 'bandpass', f: 1300, q: 0.8 });
  } },

  // --------------------------------------------------------- sword combat
  swing: { d: 0.28, v: 4, vol: 0.5, rev: 0.05, pv: 0.06, r(k) {
    const pk = rand(2200, 3200);
    k.nz({ n: 'white', a: 0.06, d: 0.17, g: 0.8, ft: 'bandpass', f: [[0, 700], [0.07, pk], [0.24, 900]], q: 2.2 });
    k.nz({ n: 'pink', a: 0.05, d: 0.16, g: 0.7, ft: 'bandpass', f: [[0, 300], [0.07, 900], [0.22, 350]], q: 0.9 });
  } },
  swingHeavy: { d: 0.5, v: 3, vol: 0.6, rev: 0.07, pv: 0.05, r(k) {
    k.nz({ n: 'white', a: 0.13, d: 0.3, g: 0.8, ft: 'bandpass', f: [[0, 400], [0.14, rand(1500, 2000)], [0.42, 500]], q: 1.8 });
    k.nz({ n: 'pink', a: 0.12, d: 0.3, g: 0.9, ft: 'bandpass', f: [[0, 160], [0.14, 500], [0.42, 180]], q: 0.8 });
    k.nz({ n: 'brown', a: 0.1, d: 0.3, g: 0.6, ft: 'lowpass', f: 300 });
  } },
  hitFlesh: { d: 0.36, v: 4, vol: 0.66, rev: 0.05, pv: 0.07, r(k) {
    k.thump(0, rand(130, 160), 50, 0.12, 0.9);
    k.nz({ n: 'pink', a: 0.002, h: 0.02, d: 0.16, g: 1, ft: 'bandpass', f: [[0, rand(800, 1100)], [0.15, 350]], q: 1.2, am: [rand(35, 55), 0.6] });
    k.nz({ n: 'white', a: 0.001, d: 0.05, g: 0.5, ft: 'highpass', f: 3500 });
    k.tex(0.01, 0.3, (d, sr) => crackles(d, sr, 9, 0.18, 300, 1200, 0.006, 0.02, 2, 5, 1), 0.5);
  } },
  hitArmor: { d: 0.5, v: 4, vol: 0.62, rev: 0.09, pv: 0.06, r(k) {
    k.metal(0, rand(380, 520), [1, 1.47, 2.09, 2.56, 3.37, 4.18], [0.32, 0.25, 0.2, 0.16, 0.12, 0.09], 0.5);
    k.thump(0, 160, 70, 0.08, 0.6);
    k.nz({ n: 'white', a: 0.0008, d: 0.05, g: 0.6, ft: 'bandpass', f: 3000, q: 0.8 });
  } },
  parry: { d: 1.1, v: 4, vol: 0.66, rev: 0.18, pv: 0.05, r(k) {
    const b = rand(1150, 1450);
    k.metal(0, b, [1, 2.756, 5.404, 8.933], [0.9, 0.55, 0.3, 0.18], 0.55, true);
    k.metal(0, b * 0.71, [1, 2.756], [0.5, 0.25], 0.25);
    k.nz({ n: 'white', a: 0.0005, d: 0.05, g: 0.9, ft: 'highpass', f: 2500 });
    k.nz({ n: 'white', dt: 0.004, a: 0.002, d: 0.09, g: 0.3, ft: 'bandpass', f: [[0, 6000], [0.08, 2500]], q: 3 });
  } },
  block: { d: 0.42, v: 4, vol: 0.56, rev: 0.07, pv: 0.06, r(k) {
    k.metal(0, rand(480, 600), [1, 1.93, 2.86, 4.1], [0.22, 0.16, 0.1, 0.07], 0.45);
    k.thump(0, 180, 80, 0.07, 0.6);
    k.nz({ n: 'pink', a: 0.001, d: 0.06, g: 0.6, ft: 'lowpass', f: 2200 });
  } },
  counter: { d: 0.65, v: 3, vol: 0.7, rev: 0.1, pv: 0.05, r(k) {
    k.metal(0, rand(1000, 1250), [1, 2.756, 5.404], [0.5, 0.3, 0.15], 0.5);
    k.nz({ n: 'white', a: 0.0005, d: 0.04, g: 0.8, ft: 'highpass', f: 2500 });
    k.nz({ n: 'white', dt: 0.07, a: 0.04, d: 0.12, g: 0.6, ft: 'bandpass', f: [[0, 900], [0.05, 2800], [0.16, 1000]], q: 2 });
    k.thump(0.13, 150, 55, 0.12, 0.8);
    k.nz({ n: 'pink', dt: 0.13, a: 0.002, h: 0.02, d: 0.14, g: 0.8, ft: 'bandpass', f: [[0, 950], [0.14, 380]], q: 1.2, am: [45, 0.6] });
  } },
  hiddenBlade: { d: 0.32, v: 3, vol: 0.46, rev: 0.05, pv: 0.05, r(k) {
    k.nz({ n: 'white', a: 0.0005, d: 0.012, g: 0.5, ft: 'bandpass', f: 1800, q: 2 });
    k.nz({ n: 'white', dt: 0.01, a: 0.015, d: 0.08, g: 0.8, ft: 'bandpass', f: [[0, 2800], [0.07, 7200]], q: 4 });
    k.metal(0.06, rand(3000, 3400), [1, 1.52, 2.27], [0.18, 0.12, 0.08], 0.22);
  } },
  assassinate: { d: 0.85, v: 3, vol: 0.7, rev: 0.09, pv: 0.05, r(k) {
    k.nz({ n: 'white', a: 0.02, d: 0.05, g: 0.5, ft: 'bandpass', f: [[0, 1500], [0.04, 3500]], q: 2.5 });
    k.thump(0.03, 140, 45, 0.15, 1);
    k.nz({ n: 'pink', dt: 0.03, a: 0.002, h: 0.03, d: 0.2, g: 1, ft: 'bandpass', f: [[0, 700], [0.2, 260]], q: 1.4, am: [38, 0.7] });
    k.voice({ dt: 0.12, dur: 0.6, f: [[0, 210], [0.12, 150], [0.6, 95]], g: 0.55, form: [[550, 4, 1], [1000, 5, 0.5]],
      drive: 4, growl: [24, 0.6], jit: 40, breath: 0.6, lp: 1300, a: 0.04 });
  } },
  gloryKill: { d: 0.75, v: 3, vol: 0.85, rev: 0.1, pv: 0.05, r(k) {
    k.tone({ type: 'sine', f: [[0, 120], [0.18, 38]], a: 0.002, h: 0.03, d: 0.3, g: 1 });
    k.tone({ type: 'triangle', f: [[0, 220], [0.08, 90]], a: 0.001, d: 0.12, g: 0.6, drive: 6, lp: 1800 });
    k.tex(0.015, 0.25, (d, sr) => crackles(d, sr, 40, 0.18, 1200, 4500, 0.0008, 0.003, 3, 9, 1.3), 0.9);
    k.nz({ n: 'pink', dt: 0.04, a: 0.01, h: 0.06, d: 0.3, g: 0.9, ft: 'bandpass', f: [[0, 1400], [0.35, 300]], q: 1.1, am: [rand(28, 40), 0.75] });
    k.tex(0.08, 0.6, (d, sr) => crackles(d, sr, 30, 0.45, 250, 1400, 0.008, 0.03, 2, 6, 1.5), 0.8);
  } },
  gore: { d: 0.48, v: 4, vol: 0.5, rev: 0.05, pv: 0.08, r(k) {
    k.thump(0, 110, 45, 0.1, 0.6);
    k.nz({ n: 'pink', a: 0.004, h: 0.02, d: 0.2, g: 0.8, ft: 'bandpass', f: [[0, 1100], [0.25, 300]], q: 1.1, am: [rand(30, 45), 0.7] });
    k.tex(0.01, 0.45, (d, sr) => crackles(d, sr, 22, 0.35, 250, 1300, 0.008, 0.025, 2, 6, 1.4), 0.8);
  } },
  // crossbow: string snap + wooden stock thunk + the bolt hissing away
  crossbow: { d: 0.4, v: 3, vol: 0.5, rev: 0.06, pv: 0.05, r(k) {
    k.thump(0, rand(210, 240), 85, 0.07, 0.8);
    k.tone({ type: 'triangle', f: [[0, rand(420, 470)], [0.18, rand(330, 370)]], a: 0.001, d: 0.22, g: 0.32, lp: 2400 });
    k.nz({ n: 'white', a: 0.001, d: 0.035, g: 0.6, ft: 'highpass', f: 2200 });
    k.nz({ n: 'pink', dt: 0.02, a: 0.02, d: 0.2, g: 0.35, ft: 'bandpass', f: [[0, 2600], [0.2, 900]], q: 2.5 });
  } },
  // a bolt striking a demon: wet thud and a short crack
  boltHit: { d: 0.26, v: 3, vol: 0.5, rev: 0.05, pv: 0.07, r(k) {
    k.thump(0, rand(240, 290), 90, 0.08, 0.9);
    k.nz({ n: 'pink', a: 0.001, d: 0.06, g: 0.6, ft: 'bandpass', f: [[0, 1800], [0.06, 500]], q: 1.2 });
    k.nz({ n: 'white', a: 0.0005, d: 0.02, g: 0.5, ft: 'highpass', f: 3000 });
  } },

  // ---------------------------------------------------------- magic signs
  sigilFire: { d: 1, v: 3, vol: 0.75, rev: 0.1, pv: 0.05, r(k) {
    k.nz({ n: 'brown', a: 0.04, h: 0.25, d: 0.6, g: 1, ft: 'lowpass', f: [[0, 150], [0.08, 1600], [0.85, 400]], q: 0.9 });
    k.nz({ n: 'pink', a: 0.06, h: 0.25, d: 0.5, g: 0.6, ft: 'bandpass', f: [[0, 500], [0.1, 1500], [0.8, 700]], q: 0.8, am: [rand(9, 14), 0.4] });
    k.tone({ type: 'sine', f: [[0, 65], [0.3, 45]], a: 0.01, h: 0.1, d: 0.35, g: 0.6 });
    k.tex(0.05, 0.85, (d, sr) => crackles(d, sr, 70, 0.75, 1500, 6000, 0.0008, 0.0025, 3, 8, 1), 0.35);
  } },
  sigilWind: { d: 0.9, v: 3, vol: 0.7, rev: 0.1, pv: 0.05, r(k) {
    k.nz({ n: 'brown', a: 0.03, h: 0.1, d: 0.6, g: 1, ft: 'lowpass', f: [[0, 200], [0.1, 900], [0.7, 180]], q: 1 });
    k.nz({ n: 'pink', a: 0.04, h: 0.05, d: 0.5, g: 0.6, ft: 'bandpass', f: [[0, 250], [0.12, 1200], [0.6, 300]], q: 0.9 });
    k.tone({ type: 'sine', f: [[0, 70], [0.4, 38]], a: 0.005, h: 0.05, d: 0.4, g: 0.8 });
    k.nz({ n: 'white', a: 0.01, d: 0.3, g: 0.25, ft: 'highpass', f: 3000 });
  } },
  sigilShield: { d: 1.6, v: 2, vol: 0.5, rev: 0.22, pv: 0.02, r(k) {
    for (const [f, g] of [[110, 0.35], [165, 0.25], [220, 0.25], [330, 0.15]]) {
      k.tone({ type: 'sine', f, a: 0.05, h: 0.4, d: 1, g, vib: [5.5, 6] });
      k.tone({ type: 'sine', f: f * 1.006, a: 0.05, h: 0.4, d: 1, g: g * 0.7 });
    }
    k.chime(0.01, 1760, 0.9, 0.18);
    k.chime(0.03, 2637, 0.7, 0.1);
    k.nz({ n: 'white', a: 0.02, d: 0.4, g: 0.15, ft: 'bandpass', f: [[0, 2000], [0.4, 6000]], q: 2 });
  } },
  sigilShieldBreak: { d: 1, v: 3, vol: 0.65, rev: 0.16, pv: 0.05, r(k) {
    k.nz({ n: 'white', a: 0.001, h: 0.01, d: 0.35, g: 0.7, ft: 'highpass', f: 2500 });
    k.thump(0, 140, 60, 0.12, 0.5);
    k.tex(0, 0.95, (d, sr) => {
      for (let i = 0; i < 45; i++) {
        const t = Math.pow(Math.random(), 2) * 0.6;
        partial(d, sr, t, rand(2200, 7500), rand(0.03, 0.15), rand(0.3, 1) * (1 - t / 0.7));
      }
    }, 0.8);
  } },
  sigilTrap: { d: 1.3, v: 2, vol: 0.55, rev: 0.18, pv: 0.03, r(k) {
    k.tone({ type: 'sine', f: 55, a: 0.04, h: 0.4, d: 0.8, g: 0.7, am: [8, 0.8] });
    k.tone({ type: 'triangle', f: 110, a: 0.04, h: 0.4, d: 0.8, g: 0.35, am: [8, 0.8], lp: 600 });
    const notes = [1760, 2093, 2637, 3136, 3520];
    for (let i = 0; i < 12; i++) {
      k.tone({ type: 'sine', f: pick(notes) * rand(0.998, 1.002), dt: 0.05 + i * 0.07 + rand(0, 0.02), a: 0.005, d: 0.25, g: 0.08 * (1 - i / 14) });
    }
  } },
  sigilHex: { d: 1.3, v: 2, vol: 0.5, rev: 0.22, pv: 0.03, r(k) {
    k.tone({ type: 'triangle', f: [[0, 466], [0.9, 440], [1.2, 330]], a: 0.08, h: 0.5, d: 0.6, g: 0.4, vib: [6.5, 45], am: [37, 0.5] });
    k.tone({ type: 'sine', f: [[0, 494], [0.9, 470], [1.2, 350]], a: 0.1, h: 0.5, d: 0.6, g: 0.35, vib: [5.1, 60] });
    k.tone({ type: 'sine', f: 233, a: 0.1, h: 0.4, d: 0.6, g: 0.25, vib: [3, 80] });
    k.nz({ n: 'pink', a: 0.2, h: 0.3, d: 0.5, g: 0.15, ft: 'bandpass', f: [[0, 800], [1, 2400]], q: 6 });
  } },
  noStamina: { d: 0.13, v: 2, vol: 0.3, rev: 0.02, pv: 0.04, r(k) {
    k.tone({ type: 'sine', f: [[0, 190], [0.05, 140]], a: 0.002, d: 0.07, g: 0.7 });
    k.nz({ n: 'pink', a: 0.001, d: 0.03, g: 0.5, ft: 'lowpass', f: 1200 });
  } },

  // ------------------------------------------------------------ items / UI
  tonic: { d: 1, v: 2, vol: 0.45, rev: 0.04, pv: 0.04, r(k) {
    k.chime(0, 2400, 0.25, 0.1);
    for (let i = 0; i < 4; i++) {
      const t = 0.12 + i * rand(0.15, 0.19);
      k.tone({ type: 'sine', f: [[0, rand(170, 220)], [0.05, rand(420, 520)]], dt: t, a: 0.004, d: 0.07, g: 0.6, lp: 900 });
      k.nz({ n: 'pink', dt: t, a: 0.005, d: 0.06, g: 0.35, ft: 'bandpass', f: 600, q: 2 });
      k.thump(t + 0.02, 120, 70, 0.05, 0.3);
    }
    k.nz({ n: 'pink', dt: 0.82, a: 0.01, d: 0.12, g: 0.2, ft: 'bandpass', f: 1200, q: 1 });
  } },
  chestOpen: { d: 1.3, v: 2, vol: 0.55, rev: 0.08, pv: 0.04, r(k) {
    // wooden creak: stick-slip pulse train ringing woody resonances
    k.tex(0, 0.75, (d, sr) => {
      const res = [rand(500, 650), rand(1100, 1300), rand(2300, 2600)];
      let t = 0;
      while (t < 0.62) {
        const amp = Math.sin((Math.PI * t) / 0.62);
        for (const f of res) grain(d, sr, t, 0.0006, f, 18, amp);
        t += (1 / rand(55, 95)) * (1 + 0.6 * Math.sin(t * 9));
      }
    }, 0.7, k.filter('highpass', 180));
    k.thump(0.6, 140, 70, 0.08, 0.45);
    k.tex(0.64, 0.66, (d, sr) => {
      for (let i = 0; i < 10; i++) {
        const t = Math.pow(Math.random(), 1.3) * 0.42, f = rand(2400, 3400);
        for (const r of [1, 2.41, 3.93]) partial(d, sr, t, f * r, 0.12 / r, 0.5 / r);
      }
    }, 0.55);
  } },
  pickupHealth: { d: 0.75, v: 1, vol: 0.42, rev: 0.18, pv: 0, r(k) {
    [74, 78, 81, 86].forEach((m, i) => {
      k.tone({ type: 'sine', f: hz(m), dt: i * 0.06, a: 0.01, d: 0.45, g: 0.3 });
      k.tone({ type: 'triangle', f: hz(m) * 2, dt: i * 0.06, a: 0.01, d: 0.25, g: 0.06 });
    });
  } },
  pickupArmor: { d: 0.6, v: 2, vol: 0.42, rev: 0.1, pv: 0.03, r(k) {
    k.metal(0, rand(1900, 2100), [1, 2.32, 4.25], [0.45, 0.3, 0.15], 0.4);
    k.metal(0.05, 2900, [1, 2.1], [0.3, 0.15], 0.2);
  } },
  pickupKnife: { d: 0.22, v: 2, vol: 0.36, rev: 0.04, pv: 0.05, r(k) {
    k.nz({ n: 'white', a: 0.0005, d: 0.015, g: 0.6, ft: 'bandpass', f: 3000, q: 1.5 });
    k.metal(0.005, rand(3300, 3700), [1, 1.8], [0.1, 0.06], 0.25);
  } },
  pickupRune: { d: 1.15, v: 1, vol: 0.46, rev: 0.28, pv: 0, r(k) {
    [69, 73, 76, 81, 85].forEach((m, i) => {
      k.tone({ type: 'triangle', f: hz(m), dt: i * 0.045, a: 0.01, d: 0.9, g: 0.13 });
      k.tone({ type: 'sine', f: hz(m) * 2, dt: i * 0.045, a: 0.01, d: 0.5, g: 0.05 });
    });
    k.tex(0, 1.1, (d, sr) => { for (let i = 0; i < 18; i++) partial(d, sr, rand(0, 0.8), rand(3000, 7000), rand(0.03, 0.1), rand(0.3, 1)); }, 0.35);
  } },
  relic: { d: 1.9, v: 1, vol: 0.5, rev: 0.32, pv: 0, r(k) {
    k.choir(0, [62, 66, 69, 74].map(hz), 1.8, 0.5, 0.35, 0.9);
    k.tex(0.1, 1.7, (d, sr) => { for (let i = 0; i < 22; i++) partial(d, sr, rand(0, 1.4), rand(2500, 6500), rand(0.04, 0.12), rand(0.2, 1)); }, 0.3);
    k.chime(0.02, hz(86), 1.4, 0.12);
  } },
  sync: { d: 3.3, v: 1, vol: 0.55, rev: 0.38, pv: 0, r(k) {
    k.choir(0, [50, 57, 62, 66, 69].map(hz), 3.2, 0.5, 0.8, 1.2, 2);
    k.tex(0.3, 2.8, (d, sr) => { for (let i = 0; i < 24; i++) partial(d, sr, rand(0, 2.3), rand(2500, 7000), rand(0.05, 0.14), rand(0.2, 1)); }, 0.25);
    const screech = (dt, g) => { // raptor cry: "kee-eeeer"
      k.tone({ type: 'sawtooth', f: [[0, 2300], [0.06, 3300], [0.2, 3000], [0.65, 2000]], dt, a: 0.02, h: 0.12, d: 0.5, g, bp: 3000, bq: 1.6, lp: 6000, vib: [26, 70] });
      k.tone({ type: 'sine', f: [[0, 2300], [0.06, 3300], [0.2, 3000], [0.65, 2000]], dt, a: 0.02, h: 0.12, d: 0.5, g: g * 0.5, vib: [26, 70] });
      k.nz({ n: 'white', dt, a: 0.02, h: 0.1, d: 0.4, g: g * 0.35, ft: 'bandpass', f: [[0, 2600], [0.2, 3200], [0.6, 2200]], q: 4 });
    };
    screech(0.9, 0.3);
    screech(1.5, 0.22);
  } },
  uiHover: { d: 0.04, v: 1, vol: 0.14, rev: 0, pv: 0.02, ui: true, r(k) {
    k.tone({ type: 'sine', f: 2100, a: 0.001, d: 0.025, g: 0.6 });
  } },
  uiClick: { d: 0.08, v: 1, vol: 0.28, rev: 0, pv: 0.02, ui: true, r(k) {
    k.nz({ n: 'white', a: 0.0005, d: 0.012, g: 0.5, ft: 'bandpass', f: 2500, q: 1 });
    k.tone({ type: 'sine', f: [[0, 900], [0.04, 600]], a: 0.001, d: 0.05, g: 0.5 });
  } },
  uiBack: { d: 0.12, v: 1, vol: 0.26, rev: 0, pv: 0.02, ui: true, r(k) {
    k.nz({ n: 'white', a: 0.0005, d: 0.012, g: 0.4, ft: 'bandpass', f: 2000, q: 1 });
    k.tone({ type: 'sine', f: [[0, 700], [0.08, 420]], a: 0.002, d: 0.09, g: 0.5 });
  } },
  objective: { d: 2.2, v: 1, vol: 0.55, rev: 0.28, pv: 0, r(k) {
    k.brass(0, hz(45), 0.6, 0.45);
    k.brass(0.55, hz(50), 1.5, 0.55);
    k.boom(0, 0.6, 0.45, 90, 45);
    k.boom(0.55, 1, 0.55, 80, 40);
  } },
  checkpoint: { d: 2, v: 1, vol: 0.36, rev: 0.28, pv: 0, r(k) {
    k.bell(0, hz(74), 1.8, 0.5, 0.6);
  } },

  // ---------------------------------------------------------------- demons
  impScreech: { d: 0.6, v: 3, vol: 0.5, rev: 0.1, pv: 0.08, r(k) {
    const f0 = rand(650, 800);
    k.voice({ dur: 0.55, f: [[0, f0 * 0.8], [0.08, f0 * 1.35], [0.55, f0 * 0.7]], g: 0.6,
      form: [[350, 3, 0.6], [2300, 6, 1], [3100, 7, 0.6]], drive: 3, growl: [rand(45, 60), 0.5], jit: 60, breath: 0.4, det: 18, a: 0.02 });
  } },
  thrallGroan: { d: 1.25, v: 3, vol: 0.46, rev: 0.1, pv: 0.07, r(k) {
    const f0 = rand(80, 100);
    k.voice({ dur: 1.2, f: [[0, f0], [0.5, f0 * 1.12], [1.2, f0 * 0.8]], g: 0.6,
      form: [[450, 5, 1], [850, 6, 0.6], [2400, 8, 0.2]], drive: 2.2, growl: [rand(9, 14), 0.35], jit: 70, breath: 0.35, a: 0.15 });
  } },
  houndGrowl: { d: 1, v: 3, vol: 0.5, rev: 0.07, pv: 0.07, r(k) {
    k.voice({ dur: 0.95, f: [[0, 75], [0.3, 92], [0.95, 70]], g: 0.65, form: [[600, 4, 1], [1200, 5, 0.5]],
      drive: 4, growl: [rand(24, 32), 0.85], jit: 50, breath: 0.8, a: 0.08 });
  } },
  houndBark: { d: 0.32, v: 3, vol: 0.56, rev: 0.09, pv: 0.08, r(k) {
    k.voice({ dur: 0.28, f: [[0, 230], [0.04, 260], [0.28, 120]], g: 0.8, form: [[700, 4, 1], [1150, 5, 0.6], [2600, 7, 0.25]],
      drive: 5, growl: [38, 0.4], jit: 40, breath: 0.7, a: 0.008, r: 0.18 });
  } },
  bruteRoar: { d: 1.9, v: 2, vol: 0.78, rev: 0.18, pv: 0.05, r(k) {
    k.voice({ dur: 1.8, f: [[0, 50], [0.3, 72], [1.3, 62], [1.8, 42]], g: 0.8, form: [[500, 3, 1], [900, 4, 0.7], [2000, 6, 0.25]],
      drive: 6, growl: [rand(18, 24), 0.6], jit: 60, breath: 0.6, sub: 0.6, saws: 3, det: 20, a: 0.12 });
  } },
  bruteSlam: { d: 1.3, v: 2, vol: 0.82, rev: 0.16, pv: 0.05, r(k) {
    k.boom(0, 1, 1, 75, 26);
    k.debris(0.02, 1.2, 0.4, 600, 3500, 45);
  } },
  bruteCharge: { d: 1.6, v: 2, vol: 0.66, rev: 0.1, pv: 0.05, r(k) {
    for (let i = 0; i < 8; i++) {
      const t = i * 0.17 + rand(0, 0.025);
      k.thump(t, 85, 35, 0.15, 0.6 + 0.3 * (i / 8));
      k.nz({ n: 'brown', dt: t, a: 0.003, d: 0.15, g: 0.6, ft: 'lowpass', f: 500 });
    }
    k.nz({ n: 'brown', a: 0.4, h: 0.6, d: 0.5, g: 0.6, ft: 'lowpass', f: 250 });
    k.voice({ dt: 0.05, dur: 0.6, f: [[0, 90], [0.6, 70]], g: 0.4, form: [[500, 3, 1], [1100, 4, 0.5]],
      drive: 5, growl: [20, 0.6], jit: 50, breath: 0.9, a: 0.05 });
  } },
  demonPain: { d: 0.42, v: 4, vol: 0.52, rev: 0.08, pv: 0.08, r(k) {
    const f0 = rand(200, 280);
    k.voice({ dur: 0.38, f: [[0, f0], [0.06, f0 * 1.4], [0.38, f0 * 0.8]], g: 0.7, form: [[600, 4, 1], [1700, 6, 0.6], [2600, 8, 0.3]],
      drive: 4, growl: [rand(30, 45), 0.5], jit: 60, breath: 0.4, a: 0.01, r: 0.2 });
  } },
  demonDeath: { d: 1.25, v: 3, vol: 0.6, rev: 0.13, pv: 0.07, r(k) {
    const f0 = rand(170, 210);
    k.voice({ dur: 1.15, f: [[0, f0 * 1.2], [0.15, f0], [1.15, f0 * 0.35]], g: 0.7, form: [[650, 4, 1], [1100, 5, 0.6], [2500, 7, 0.2]],
      drive: 4.5, growl: [30, 0.6, 9], jit: 90, breath: 0.6, a: 0.02, r: 0.6 });
    k.tex(0.05, 0.4, (d, sr) => crackles(d, sr, 12, 0.3, 250, 1100, 0.008, 0.025, 2, 6, 1.4), 0.4);
  } },
  fireballCast: { d: 0.7, v: 3, vol: 0.56, rev: 0.1, pv: 0.06, r(k) {
    k.nz({ n: 'brown', a: 0.06, h: 0.08, d: 0.45, g: 1, ft: 'lowpass', f: [[0, 200], [0.1, 2200], [0.55, 300]], q: 1.2 });
    k.tone({ type: 'sine', f: [[0, 90], [0.25, 50]], a: 0.01, h: 0.05, d: 0.3, g: 0.6 });
    k.tex(0.04, 0.5, (d, sr) => crackles(d, sr, 30, 0.4, 1500, 6000, 0.0008, 0.0025, 3, 8, 1), 0.25);
  } },
  explosion: { d: 2.3, v: 3, vol: 0.95, rev: 0.22, pv: 0.06, r(k) {
    k.boom(0, 1.6, 1, 95, 28);
    k.nz({ n: 'pink', a: 0.002, h: 0.05, d: 0.9, g: 0.7, ft: 'lowpass', f: [[0, 5000], [0.8, 600]], q: 0.7 });
    k.nz({ n: 'white', a: 0.0005, d: 0.08, g: 0.4, ft: 'highpass', f: 1500 });
    k.nz({ n: 'brown', dt: 0.1, a: 0.2, h: 0.3, d: 1.5, g: 0.5, ft: 'bandpass', f: 400, q: 0.6, am: [11, 0.4] });
    k.debris(0.08, 2.1, 0.35, 900, 5000, 70);
  } },
  orbShoot: { d: 0.42, v: 3, vol: 0.46, rev: 0.13, pv: 0.06, r(k) {
    k.tone({ type: 'square', f: [[0, 260], [0.12, 900], [0.35, 600]], a: 0.005, h: 0.05, d: 0.25, g: 0.3, lp: 2500, am: [rand(55, 70), 0.7] });
    k.tone({ type: 'sine', f: [[0, 520], [0.12, 1800]], a: 0.005, d: 0.25, g: 0.25 });
    k.nz({ n: 'white', a: 0.002, d: 0.12, g: 0.3, ft: 'bandpass', f: [[0, 3000], [0.1, 6000]], q: 2 });
  } },
  beamCharge: { d: 1.35, v: 2, vol: 0.5, rev: 0.13, pv: 0.03, r(k) {
    k.tone({ type: 'sawtooth', f: [[0, 160], [1.2, 1300]], a: 1, h: 0.15, d: 0.15, g: 0.3, bp: [[0, 500], [1.2, 2600]], bq: 2, am: [4, 0.6, 32] });
    k.tone({ type: 'sine', f: [[0, 320], [1.2, 2600]], a: 1, h: 0.15, d: 0.15, g: 0.15 });
    k.nz({ n: 'white', a: 1.1, h: 0.05, d: 0.15, g: 0.25, ft: 'bandpass', f: [[0, 800], [1.2, 5000]], q: 3 });
  } },
  bossRoar: { d: 2.8, v: 1, vol: 0.95, rev: 0.28, pv: 0.03, r(k) {
    k.voice({ dur: 2.6, f: [[0, 38], [0.4, 55], [1.8, 48], [2.6, 30]], g: 0.75, form: [[400, 3, 1], [800, 4, 0.8], [1800, 5, 0.3]],
      drive: 7, growl: [16, 0.65], jit: 50, breath: 0.8, sub: 0.8, saws: 3, det: 25, a: 0.25 });
    k.voice({ dt: 0.1, dur: 2.3, f: [[0, 110], [0.5, 150], [1.7, 130], [2.3, 80]], g: 0.4, form: [[700, 4, 1], [1300, 5, 0.6], [2900, 7, 0.3]],
      drive: 5, growl: [27, 0.5], jit: 70, breath: 0.5, a: 0.3 });
    k.nz({ n: 'brown', a: 0.4, h: 1.2, d: 1, g: 0.6, ft: 'lowpass', f: 160 });
  } },
  bossStomp: { d: 1.8, v: 2, vol: 0.95, rev: 0.22, pv: 0.04, r(k) {
    k.boom(0, 1.4, 1, 65, 22);
    k.thump(0, 140, 50, 0.1, 0.5, 'triangle');
    k.debris(0.03, 1.7, 0.4, 500, 3000, 55);
  } },

  // --------------------------------------------------------- stealth/state
  alert: { d: 1.3, v: 1, vol: 0.55, rev: 0.22, pv: 0, r(k) {
    k.boom(0, 0.8, 0.5, 70, 35);
    for (const m of [62, 63, 69, 74, 75]) {
      k.tone({ type: 'sawtooth', f: hz(m), a: 0.01, h: 0.15, d: 0.8, g: 0.12, lp: [[0, 6000], [0.9, 900]], det: rand(-8, 8) });
    }
    k.tone({ type: 'sawtooth', f: [[0, hz(86)], [0.6, hz(87)]], a: 0.02, h: 0.2, d: 0.7, g: 0.07, vib: [7, 30], lp: 5000 });
  } },
  suspicious: { d: 0.5, v: 1, vol: 0.32, rev: 0.18, pv: 0, r(k) {
    k.tone({ type: 'triangle', f: [[0, 520], [0.3, 760]], a: 0.06, h: 0.12, d: 0.25, g: 0.5, vib: [6, 15] });
    k.tone({ type: 'sine', f: [[0, 1040], [0.3, 1520]], a: 0.06, h: 0.1, d: 0.2, g: 0.12 });
  } },
  lostTrack: { d: 0.75, v: 1, vol: 0.32, rev: 0.22, pv: 0, r(k) {
    k.tone({ type: 'triangle', f: [[0, 760], [0.5, 470]], a: 0.04, h: 0.15, d: 0.45, g: 0.5 });
    k.tone({ type: 'sine', f: [[0, 380], [0.5, 235]], a: 0.04, h: 0.15, d: 0.45, g: 0.25 });
  } },
  heartbeat: { d: 0.5, v: 2, vol: 0.5, rev: 0.02, pv: 0.03, lo: true, r(k) {
    k.tone({ type: 'sine', f: [[0, 70], [0.08, 42]], a: 0.004, d: 0.14, g: 1, lp: 200 });
    k.tone({ type: 'sine', f: [[0, 60], [0.08, 38]], dt: 0.2, a: 0.004, d: 0.18, g: 0.75, lp: 200 });
  } },
  playerHurt: { d: 0.36, v: 4, vol: 0.55, rev: 0.05, pv: 0.06, r(k) {
    k.thump(0, 150, 70, 0.14, 0.9);
    k.voice({ dur: 0.22, f: [[0, 160], [0.22, 110]], g: 0.35, form: [[600, 5, 1], [1000, 6, 0.6]], drive: 1.5, jit: 30, breath: 0.8, a: 0.008, r: 0.14 });
    k.nz({ n: 'pink', a: 0.002, d: 0.12, g: 0.5, ft: 'bandpass', f: 900, q: 1 });
  } },
  playerDeath: { d: 2.6, v: 1, vol: 0.7, rev: 0.28, pv: 0, r(k) {
    k.boom(0, 1.2, 0.7, 70, 30);
    for (const [m, g] of [[26, 0.35], [33, 0.25], [38, 0.25], [39, 0.12]]) {
      k.tone({ type: 'sawtooth', f: [[0, hz(m)], [2.4, hz(m - 2)]], a: 0.2, h: 0.8, d: 1.4, g, lp: [[0, 600], [2.4, 150]] });
    }
    k.bell(0.05, hz(50), 2.4, 0.2, 0.3);
  } },
  waveStart: { d: 2, v: 1, vol: 0.62, rev: 0.28, pv: 0, r(k) {
    k.brass(0, hz(38), 1.7, 0.7);
    k.brass(0.02, hz(38) * 1.003, 1.7, 0.5);
    k.boom(0, 0.9, 0.35, 70, 35);
  } },
  riftOpen: { d: 1.7, v: 2, vol: 0.7, rev: 0.22, pv: 0.04, r(k) {
    k.nz({ n: 'white', a: 0.5, h: 0.2, d: 0.9, g: 0.8, ft: 'bandpass', f: [[0, 3500], [1.4, 200]], q: 1.5, am: [rand(25, 40), 0.8] });
    k.nz({ n: 'brown', a: 0.6, h: 0.3, d: 0.7, g: 0.8, ft: 'lowpass', f: 300 });
    k.tone({ type: 'sine', f: [[0, 30], [0.6, 45], [1.5, 35]], a: 0.5, h: 0.3, d: 0.7, g: 0.6 });
    k.tex(0.1, 1.3, (d, sr) => crackles(d, sr, 140, 1.1, 800, 3000, 0.001, 0.004, 3, 8, 0.8), 0.35);
  } },
  riftClose: { d: 3.4, v: 1, vol: 0.8, rev: 0.32, pv: 0, r(k) {
    k.boom(0, 1.6, 1, 80, 25);
    k.choir(0.3, [50, 57, 62, 66, 69].map(hz), 3, 0.45, 1, 1.4, 5);
    k.tex(0.4, 2.8, (d, sr) => { for (let i = 0; i < 24; i++) partial(d, sr, rand(0, 2.3), rand(2500, 7000), rand(0.05, 0.14), rand(0.2, 1)); }, 0.25);
  } },
  bell: { d: 4.6, v: 1, vol: 0.7, rev: 0.32, pv: 0.01, r(k) {
    k.bell(0, hz(50), 4.5, 0.8, 1);
  } },
  thunder: { d: 3.5, v: 2, vol: 0.75, rev: 0.28, pv: 0.05, lo: true, r(k) {
    k.nz({ n: 'pink', a: 0.02, d: 0.4, g: 0.5, ft: 'lowpass', f: 1200 });
    let t = rand(0.05, 0.2);
    for (let i = 0; i < 5; i++) {
      k.nz({ n: 'brown', dt: t, a: rand(0.05, 0.25), h: rand(0.05, 0.3), d: rand(0.8, 1.6), g: rand(0.5, 1) * (1 - i * 0.12), ft: 'lowpass', f: rand(180, 400), q: 0.7 });
      t += rand(0.2, 0.55);
    }
    k.tone({ type: 'sine', f: [[0, 45], [2, 30]], a: 0.3, h: 0.5, d: 2, g: 0.3 });
  } },
};

// Peak calibration per sound (measured from offline renders): gain that brings the
// loudest variant to ~0.9 so that `vol` above is the actual mix peak level.
const CAL = {
  step: 1.41, jump: 1.81, land: 0.841, landHeavy: 0.608, climb: 1.27, grab: 1.34, mantle: 1.88, vault: 1.29,
  climbLeap: 1.19, hay: 0.848, leap: 1.48, dodge: 4.8, roll: 1.16, swing: 1.93, swingHeavy: 1.66, hitFlesh: 0.611,
  hitArmor: 0.528, parry: 0.344, block: 0.75, counter: 0.527, hiddenBlade: 1.9, assassinate: 0.861, gloryKill: 0.444,
  gore: 0.789, crossbow: 0.653, boltHit: 0.764, sigilFire: 0.684, sigilWind: 0.565, sigilShield: 0.525,
  sigilShieldBreak: 0.431, sigilTrap: 0.788, sigilHex: 0.916, noStamina: 1.4, tonic: 1.43, chestOpen: 1.25,
  pickupHealth: 1.97, pickupArmor: 0.974, pickupKnife: 1.88, pickupRune: 1.86, relic: 1.23, sync: 0.951,
  uiHover: 1.53, uiClick: 1.46, uiBack: 1.76, objective: 0.906, checkpoint: 1.37, impScreech: 1.53,
  thrallGroan: 1.64, houndGrowl: 1.41, houndBark: 1.35, bruteRoar: 0.614, bruteSlam: 0.487, bruteCharge: 0.763,
  demonPain: 1.14, demonDeath: 1.15, fireballCast: 0.845, explosion: 0.456, orbShoot: 1.62, beamCharge: 3.27,
  bossRoar: 0.564, bossStomp: 0.47, alert: 0.798, suspicious: 1.47, lostTrack: 1.32, heartbeat: 0.92,
  playerHurt: 1.01, playerDeath: 0.701, waveStart: 0.846, riftOpen: 0.724, riftClose: 0.452, bell: 0.855,
  thunder: 0.914,
};

// =============================================================================
// Continuous loops
// -----------------------------------------------------------------------------
//  buffer loops: rendered offline once (seamless crossfade); each instance is a
//                single looping AudioBufferSourceNode started at a random offset.
//  live loops:   tiny oscillator/noise graphs (LiveGraph) whose pitch can be
//                bent; an optional tick() adds slow random modulation scheduled
//                on the audio clock (wind gusts).
// =============================================================================
class LiveGraph {
  constructor(c, out, res) {
    this.c = c;
    this.out = out;
    this.res = res;
    this.t = c.currentTime;
    this.srcs = [];
    this.pitched = []; // [AudioParam, base value] scaled by setPitch
  }
  gain(v = 1, dest = this.out) {
    const g = this.c.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  filter(type, f, q = 0.707, dest = this.out) {
    const n = this.c.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    if (dest) n.connect(dest);
    return n;
  }
  drive(k, dest = this.out) {
    const n = this.c.createWaveShaper();
    n.curve = driveCurve(k, 0);
    n.oversample = '2x';
    if (dest) n.connect(dest);
    return n;
  }
  osc(type, f, dest, pitched = true) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    if (dest) o.connect(dest);
    o.start(this.t);
    this.srcs.push(o);
    if (pitched) this.pitched.push([o.frequency, f]);
    return o;
  }
  noise(kind, dest, rate = 1) {
    const b = this.res.noise[kind] || this.res.noise.white;
    const s = this.c.createBufferSource();
    s.buffer = b;
    s.loop = true;
    s.playbackRate.value = rate;
    if (dest) s.connect(dest);
    s.start(this.t, Math.random() * b.duration * 0.9);
    this.srcs.push(s);
    this.pitched.push([s.playbackRate, rate]);
    return s;
  }
  lfo(rate, depth, param, type = 'sine') {
    const g = this.gain(depth, null);
    g.connect(param);
    return this.osc(type, rate, g, false);
  }
  setPitch(p, t) { for (const [param, base] of this.pitched) rampTo(param, base * p, t, 0.08); }
  stop(t) { for (const s of this.srcs) { try { s.stop(t); } catch (e) { /* already stopped */ } } }
}

const LOOPS = {
  // Crackling fire: roaring low bed + random crackles and pops (buffer loop).
  fireCrackle: { vol: 0.5, rev: 0.05, len: 7.13, render(k, len) {
    k.nz({ n: 'brown', a: 0.01, h: len + 1, d: 0.05, g: 0.7, ft: 'lowpass', f: 380, q: 0.6, am: [2.3, 0.35], wob: 0.06 });
    k.nz({ n: 'pink', a: 0.01, h: len + 1, d: 0.05, g: 0.14, ft: 'bandpass', f: 900, q: 0.7, am: [6.3, 0.6], wob: 0.06 });
    k.tex(0, len + 0.5, (d, sr) => {
      const span = len + 0.4; // also fill the seam crossfade region
      for (let i = 0; i < span * 14; i++) grain(d, sr, Math.random() * span, rand(0.0006, 0.0025), rand(1500, 6000), rand(3, 9), Math.pow(Math.random(), 2.2));
      for (let i = 0; i < span * 1.6; i++) grain(d, sr, Math.random() * span, rand(0.004, 0.012), rand(300, 900), rand(2, 4), rand(0.4, 1)); // pops
    }, 0.55);
  } },
  // Sizzling burn: fluttering high noise + small crackles (buffer loop).
  burning: { vol: 0.38, rev: 0.04, len: 6.37, render(k, len) {
    k.nz({ n: 'white', a: 0.01, h: len + 1, d: 0.05, g: 0.3, ft: 'highpass', f: 3500, q: 0.6, am: [17, 0.6], wob: 0.06 });
    k.nz({ n: 'pink', a: 0.01, h: len + 1, d: 0.05, g: 0.25, ft: 'bandpass', f: 6000, q: 0.8, am: [23, 0.7], wob: 0.06 });
    k.nz({ n: 'brown', a: 0.01, h: len + 1, d: 0.05, g: 0.35, ft: 'lowpass', f: 300, wob: 0.06 });
    k.tex(0, len + 0.5, (d, sr) => {
      for (let i = 0; i < (len + 0.4) * 25; i++) grain(d, sr, Math.random() * (len + 0.4), rand(0.0005, 0.0015), rand(2000, 7000), rand(3, 8), Math.pow(Math.random(), 2));
    }, 0.35);
  } },
  // Gentle ambient city wind with random gusts (live, never repeats).
  wind: { vol: 0.3, rev: 0.08, create(g) {
    const gust = g.gain(0.6);
    const lp = g.filter('lowpass', 1600, 0.5, gust);
    const bp = g.filter('bandpass', 500, 0.8, lp);
    g.lfo(0.11, 0.05, g.noise('pink', bp).playbackRate);
    const whistle = g.filter('bandpass', 1150, 14, g.gain(0.18, gust));
    g.noise('white', whistle, 0.97);
    const low = g.filter('lowpass', 220, 0.7, g.gain(0.55));
    g.lfo(0.07, 0.05, g.noise('brown', low).playbackRate);
    let next = 0;
    return (now) => {
      if (now < next) return;
      rampTo(bp.frequency, rand(300, 900), now, rand(0.6, 1.6));
      rampTo(whistle.frequency, rand(900, 1500), now, rand(0.8, 2));
      rampTo(gust.gain, rand(0.25, 1), now, rand(0.5, 1.6));
      next = now + rand(1.4, 4);
    };
  } },
  // Deep pulsing infernal drone (rift).
  riftHum: { vol: 0.55, rev: 0.22, create(g) {
    const trem = g.gain(0.6);
    g.lfo(1.6, 0.4, trem.gain);
    const lp = g.filter('lowpass', 240, 2.5, trem);
    g.lfo(0.21, 90, lp.frequency);
    const sh = g.drive(2.5, lp);
    for (const [f, det] of [[36.7, -6], [36.7, 7], [55, 0]]) g.osc('sawtooth', f, g.gain(0.3, sh)).detune.value = det;
    g.osc('sine', 36.7, g.gain(0.5, trem));
    const eerie = g.gain(0.035);
    g.lfo(0.13, 0.03, eerie.gain);
    g.lfo(0.4, 18, g.osc('sine', 293.7, eerie).detune);
    g.noise('brown', g.filter('lowpass', 120, 0.7, g.gain(0.4, trem)));
  } },
  // Floating, buzzing gazer hum.
  gazerHum: { vol: 0.42, rev: 0.08, create(g) {
    const trem = g.gain(0.7);
    g.lfo(9, 0.3, trem.gain);
    const bp = g.filter('bandpass', 700, 1.4, trem);
    g.lfo(0.7, 200, bp.frequency);
    const vib = g.gain(15, null);
    g.osc('sine', 6, vib, false);
    for (const [type, f, gg] of [['square', 110, 0.25], ['sawtooth', 111.3, 0.3], ['sine', 220, 0.2]]) vib.connect(g.osc(type, f, g.gain(gg, bp)).detune);
    g.osc('sine', 55, g.gain(0.25, trem));
  } },
  // Searing energy beam.
  beamLoop: { vol: 0.55, rev: 0.1, create(g) {
    const lp = g.filter('lowpass', 5000, 0.7);
    const sh = g.drive(3, lp);
    const bp = g.filter('bandpass', 1300, 0.9, sh);
    g.lfo(13, 400, bp.frequency);
    for (const [type, f, gg] of [['sawtooth', 180, 0.35], ['sawtooth', 181.7, 0.35], ['square', 360, 0.15]]) g.osc(type, f, g.gain(gg, bp));
    const fl = g.gain(0.7, g.filter('highpass', 3500, 0.7, g.gain(0.22)));
    g.lfo(31, 0.3, fl.gain);
    g.noise('white', fl);
    g.osc('sine', 90, g.gain(0.3));
  } },
};

// =============================================================================
// Music instruments
// -----------------------------------------------------------------------------
// Drums, distorted guitar power chords and bass are rendered offline once into
// sample buffers and sequenced by the tracks. Pads, choir and lead voices are
// cheap live oscillators (they are sparse and long).
// =============================================================================
/** 808-style metallic cluster (six detuned squares) for hats and cymbals. */
function cymbal(k, d, g, hp, bpf) {
  const amp = k.gain(0);
  k.env(amp.gain, 0, 0.0008, 0, d, g);
  const b = k.filter('bandpass', bpf, 0.8, k.filter('highpass', hp, 0.7, amp));
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) k.osc('square', f * rand(0.995, 1.005), 0, d, k.gain(0.18, b));
  k.nz({ n: 'white', a: 0.0008, d, g: g * 0.6, ft: 'highpass', f: hp });
}
function tom(k, f) {
  k.tone({ type: 'sine', f: [[0, f * 1.7], [0.06, f], [0.35, f * 0.85]], a: 0.0008, h: 0.01, d: 0.35, g: 0.9 });
  k.nz({ n: 'pink', a: 0.0008, d: 0.08, g: 0.35, ft: 'bandpass', f: f * 5, q: 0.8 });
}

const DRUMS = {
  kick: { d: 0.45, v: 2, mix: 0.9, r(k) {
    k.tone({ type: 'sine', f: [[0, 165], [0.035, 62], [0.35, 44]], a: 0.0008, h: 0.02, d: 0.38, g: 1, drive: 1.6 });
    k.tone({ type: 'triangle', f: [[0, 320], [0.025, 110]], a: 0.0005, d: 0.04, g: 0.45 });
    k.nz({ n: 'white', a: 0.0004, d: 0.012, g: 0.4, ft: 'highpass', f: 2500 });
  } },
  snare: { d: 0.4, v: 3, mix: 0.7, r(k) {
    k.tone({ type: 'triangle', f: [[0, 250], [0.04, 185]], a: 0.0008, d: 0.12, g: 0.75 });
    k.tone({ type: 'sine', f: [[0, 340], [0.03, 300]], a: 0.0008, d: 0.06, g: 0.35 });
    k.nz({ n: 'white', a: 0.0008, h: 0.008, d: 0.22, g: 0.8, ft: 'bandpass', f: 3800, q: 0.6 });
    k.nz({ n: 'white', a: 0.0008, d: 0.14, g: 0.45, ft: 'highpass', f: 6500 });
  } },
  hat: { d: 0.08, v: 3, mix: 0.3, r(k) { cymbal(k, 0.045, 0.7, 7000, 10000); } },
  ohat: { d: 0.5, v: 2, mix: 0.28, r(k) { cymbal(k, 0.32, 0.6, 6500, 9000); } },
  crash: { d: 2.3, v: 2, mix: 0.4, r(k) {
    cymbal(k, 2.1, 0.6, 4000, 7000);
    k.nz({ n: 'white', a: 0.001, d: 1.2, g: 0.35, ft: 'bandpass', f: 3200, q: 0.6 });
  } },
  tomH: { d: 0.4, v: 1, mix: 0.65, r(k) { tom(k, 150); } },
  tomM: { d: 0.4, v: 1, mix: 0.65, r(k) { tom(k, 112); } },
  tomL: { d: 0.45, v: 1, mix: 0.7, r(k) { tom(k, 82); } },
  boom: { d: 2.2, v: 1, mix: 0.8, r(k) { // cinematic low hit for breakdowns / boss
    k.boom(0, 1.9, 1, 70, 28);
    k.tone({ type: 'triangle', f: [[0, 110], [0.5, 55]], a: 0.001, h: 0.05, d: 0.9, g: 0.4, lp: 400 });
  } },
};

// Drop-D guitar: notes in semitones above D2 that the riffs use.
const GTR_ROOT = 38; // D2 (73.4 Hz)
const GTR_NOTES = [0, 1, 3, 5, 6, 7, 8, 10, 12];

/** Distorted power chord (root, fifth, octave; saw + square) through amp + cabinet. */
function renderGuitar(k, f, mute) {
  const dur = mute ? 0.26 : 1.6;
  const post = k.gain(0);
  const lp2 = k.filter('lowpass', 5200, 0.6, post);
  const lp1 = k.filter('lowpass', 4300, 0.9, lp2); // cabinet roll-off
  const scoop = k.filter('peaking', 750, 0.9, lp1, -7); // mid scoop
  const thump = k.filter('peaking', 110, 1, scoop, mute ? 5 : 3);
  const hp = k.filter('highpass', 70, 0.7, thump);
  if (mute) k.env(post.gain, 0, 0.002, 0.05, 0.17, 1);
  else k.env(post.gain, 0, 0.003, 1, 0.55, 1);
  const sh = k.drive(16, hp, 0.08); // heavy overdrive
  const pre = mute ? k.filter('lowpass', 950, 0.8, sh) : k.filter('lowpass', 3200, 0.7, sh);
  const penv = k.gain(0, pre); // string envelope before distortion (palm mute decays fast)
  k.env(penv.gain, 0, 0.002, mute ? 0.02 : 0.25, mute ? 0.25 : 2.5, 1);
  for (const [r, g] of [[1, 1], [1.4983, 0.8], [2, 0.55]]) {
    const o1 = k.osc('sawtooth', f * r, 0, dur, k.gain(g * 0.4, penv));
    o1.detune.value = rand(-5, 5);
    const o2 = k.osc('square', f * r, 0, dur, k.gain(g * 0.18, penv));
    o2.detune.value = rand(-6, 6);
  }
  k.nz({ n: 'white', a: 0.0005, d: 0.015, g: 0.3, ft: 'bandpass', f: 2500, q: 0.8, dest: penv }); // pick attack
}
/** Bass doubling the riff an octave down. */
function renderBass(k, f, mute) {
  const dur = mute ? 0.26 : 1.5;
  const amp = k.gain(0);
  k.env(amp.gain, 0, 0.003, mute ? 0.05 : 0.9, mute ? 0.18 : 0.5, 1);
  const sh = k.drive(2.5, k.filter('lowpass', mute ? 520 : 850, 0.8, amp));
  k.osc('sawtooth', f, 0, dur, k.gain(0.5, sh));
  k.osc('sine', f, 0, dur, k.gain(0.6, amp));
}

// Riff notation: 16 sixteenths per bar. lowercase = palm-muted chug,
// UPPERCASE = open accented chord, '-' = let ring, '.' = rest (choke).
// Letters: d=D r=Eb f=F g=G h=Ab a=A b=Bb c=C o=D(octave) over drop-D.
const NOTE = { d: 0, r: 1, f: 3, g: 5, h: 6, a: 7, b: 8, c: 10, o: 12 }; // each has rendered samples (GTR_NOTES)
const RIFFS = {
  A: ['d.ddd.ddd.dd.dR-', 'd.ddd.ddd.dd.dH-', 'd.ddd.ddd.dd.dG-', 'D-.dd.R-.dd.H-G-'],
  C: ['D..D..D..D..R-H-', 'd.dd.dd.dd.dG-F-', 'D..D..D..D..R-H-', 'd.dd.dd.dH-G-R-.'],
  B: ['d.ddd.ddr.rrr.rr', 'd.ddd.ddh.hhG-F-', 'd.ddd.ddr.rrr.rr', 'd.ddd.ddH---R---'],
  K: ['D-----d.d...R---', 'D-----d.d.d.H---', 'D-----d.d...R---', 'D-----d.ddH-G-F-'],
  X: ['D-----..d.d.R---', 'D-----..d.d.H---', 'D-----d.d...G-F-', 'D-----R-----H---'],
  Y: ['D..d..D..d..R---', 'D..d..D..d..H-G-', 'D..d..D..d..R---', 'D-----dddd..H---'],
};
const METAL = {
  combat: {
    bpm: 150, first: 'A', gtr: 0.13, bass: 0.21, drums: 0.4,
    sections: { A: 'rock', C: 'rock', B: 'double', K: 'half' },
    next: { A: ['B', 'C', 'K'], B: ['A', 'K', 'C'], C: ['B', 'K', 'A'], K: ['A', 'B', 'C'] },
  },
  boss: {
    bpm: 110, first: 'X', gtr: 0.18, bass: 0.27, drums: 0.5, choir: true,
    sections: { X: 'half', Y: 'gallop' },
    next: { X: ['Y', 'X'], Y: ['X', 'Y'] },
  },
};

// D-minor harmony for the ambient tracks (pitch classes: root, third, fifth).
const CHORDS = { Dm: [2, 5, 9], Bb: [10, 2, 5], Gm: [7, 10, 2], A: [9, 1, 4], F: [5, 9, 0], C: [0, 4, 7], Eb: [3, 7, 10] };
const CHORD_NEXT = {
  Dm: ['Bb', 'Gm', 'F', 'Bb', 'Eb', 'A'], Bb: ['Gm', 'F', 'Dm', 'C', 'Gm'], Gm: ['A', 'Dm', 'Bb', 'Eb', 'Dm'],
  A: ['Dm', 'Dm', 'Bb'], F: ['C', 'Gm', 'Bb', 'Dm'], C: ['Dm', 'A', 'F'], Eb: ['Dm', 'Gm', 'Bb'],
};
/** A random MIDI note of pitch class pc inside [lo, hi]. */
function pcIn(pc, lo, hi) {
  const opts = [];
  for (let m = lo; m <= hi; m++) if (((m % 12) + 12) % 12 === pc) opts.push(m);
  return opts.length ? pick(opts) : lo;
}

// =============================================================================
// Music tracks
// -----------------------------------------------------------------------------
// Each track owns a fader pair (dry -> musicBus, wet -> musicSend) so modes can
// crossfade. schedule(until, now) is called by the engine's lookahead
// scheduler and creates every note with an exact AudioContext start time.
// =============================================================================
function fadeParam(param, to, t, dur) {
  try {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else { const v = param.value; param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
    param.linearRampToValueAtTime(to, t + dur);
  } catch (e) { param.value = to; }
}

class Track {
  constructor(eng, mode) {
    const c = (this.c = eng.ctx);
    this.e = eng;
    this.mode = mode;
    this.persist = [];
    this.endAt = Infinity;
    this.fading = false;
    this.dryF = c.createGain();
    this.dryF.gain.value = 0;
    this.dryF.connect(eng.musicBus);
    this.wetF = c.createGain();
    this.wetF.gain.value = 0;
    this.wetF.connect(eng.musicSend);
    this.dry = c.createGain();
    this.dry.connect(this.dryF);
    this.wet = c.createGain();
    this.wet.connect(this.wetF);
  }
  fadeIn(t, dur) {
    for (const f of [this.dryF, this.wetF]) { f.gain.setValueAtTime(0, t); f.gain.linearRampToValueAtTime(1, t + dur); }
  }
  fadeOut(t, dur) {
    this.fading = true;
    for (const f of [this.dryF, this.wetF]) fadeParam(f.gain, 0, t, dur);
    this.endAt = Math.min(this.endAt, t + dur + 0.25);
  }
  begin() {}
  schedule() {}
  dispose() {
    const t = this.c.currentTime;
    for (const n of this.persist) { try { n.stop(t + 0.05); } catch (e) { /* ignore */ } }
    this.persist.length = 0;
    try { this.dryF.disconnect(); this.wetF.disconnect(); } catch (e) { /* ignore */ }
  }

  // ---- routing / node helpers ----------------------------------------------
  gainNode(v, dest) {
    const g = this.c.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }
  biquad(type, f, q = 0.707, dest = null) {
    const n = this.c.createBiquadFilter();
    n.type = type;
    n.frequency.value = f;
    n.Q.value = q;
    if (dest) n.connect(dest);
    return n;
  }
  panNode(p, dest) {
    if (!this.c.createStereoPanner) return dest;
    const n = this.c.createStereoPanner();
    n.pan.value = p;
    n.connect(dest);
    return n;
  }
  /** Connect node to the track with a dry level and a reverb send. */
  route(node, wet = 0.3, dry = 1) {
    if (dry > 0) node.connect(dry === 1 ? this.dry : this.gainNode(dry, this.dry));
    if (wet > 0) node.connect(this.gainNode(wet, this.wet));
    return node;
  }
  /** Persistent source (drone, LFO); stopped on dispose. */
  posc(type, f, dest) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(dest);
    o.start();
    this.persist.push(o);
    return o;
  }
  pnoise(kind, dest) {
    const s = this.c.createBufferSource();
    s.buffer = this.e.res.noise[kind];
    s.loop = true;
    s.connect(dest);
    s.start(0, Math.random() * s.buffer.duration * 0.9);
    this.persist.push(s);
    return s;
  }
  plfo(rate, depth, param) {
    const g = this.gainNode(depth, null);
    g.connect(param);
    this.posc('sine', rate, g);
    return g;
  }
  /** One-shot buffer playback; returns {s, g} so it can be choked. */
  sample(t, buf, g, dest, rate = 1) {
    if (!buf) return null;
    const s = this.c.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const gg = this.gainNode(g, dest);
    s.connect(gg);
    s.start(t);
    return { s, g: gg };
  }
  /** Linear attack / hold / linear release gain for long notes. */
  noteEnv(t, dur, g, a, r, dest) {
    a = Math.min(a, dur * 0.45);
    r = Math.min(r, dur * 0.5);
    const env = this.gainNode(0, dest);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(g, t + a);
    env.gain.setValueAtTime(g, t + dur - r);
    env.gain.linearRampToValueAtTime(0, t + dur);
    return env;
  }
  voiceOsc(type, f, det, t, dur, dest) {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = det;
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  // ---- live instruments ------------------------------------------------------
  /** String-like pad: three detuned saws per note into a slowly breathing low-pass. */
  pad(t, midi, dur, g, a = 1.5, r = 2) {
    if (!this._pad) {
      const cut = this.padCut || 900;
      this._pad = this.biquad('lowpass', cut, 0.6, this.route(this.biquad('highpass', 45, 0.7), 0.55));
      this.plfo(0.045, cut * 0.28, this._pad.frequency);
    }
    const env = this.noteEnv(t, dur, g, a, r, this._pad);
    for (const det of [-11, 0, 9]) this.voiceOsc('sawtooth', hz(midi), det + rand(-3, 3), t, dur, env);
  }
  /** Choir "aah": detuned saws through a shared formant bank with common vibrato. */
  choirNote(t, midi, dur, g, a = 2, r = 2.5) {
    if (!this._choir) {
      const out = this.biquad('lowpass', 3800, 0.7);
      this.route(out, 0.75, 0.8);
      this._choir = this.gainNode(1, null);
      for (const [f, q, gg] of [[750, 5, 1], [1150, 6, 0.55], [2800, 8, 0.22]]) {
        this._choir.connect(this.biquad('bandpass', f, q, this.gainNode(gg * 2.2, out)));
      }
      this._vib = this.gainNode(9, null);
      this.posc('sine', 4.8, this._vib);
    }
    const env = this.noteEnv(t, dur, g, a, r, this._choir);
    for (const det of [-9, 8]) this._vib.connect(this.voiceOsc('sawtooth', hz(midi), det + rand(-4, 4), t, dur, env).detune);
  }
  /** Soft bowed lead (title melody, victory). */
  lead(t, midi, dur, g) {
    if (!this._lead) {
      this._lead = this.biquad('lowpass', 1700, 0.8);
      this.route(this._lead, 0.6);
    }
    const env = this.noteEnv(t, dur, g, 0.18, Math.min(0.9, dur * 0.4), this._lead);
    const vib = this.gainNode(0, null);
    vib.gain.setValueAtTime(0, t + 0.3);
    vib.gain.linearRampToValueAtTime(12, t + 0.9);
    this.voiceOsc('sine', 5.3, 0, t, dur, vib);
    vib.connect(this.voiceOsc('sawtooth', hz(midi), 0, t, dur, this.gainNode(0.5, env)).detune);
    vib.connect(this.voiceOsc('triangle', hz(midi), 3, t, dur, this.gainNode(0.8, env)).detune);
  }
  /** Distant church bell (re-uses the rendered 'bell' SFX buffer). */
  bellHit(t, rate, g) {
    const buf = this.e._sfxBuf('bell');
    if (!buf) return;
    if (!this._bell) { this._bell = this.biquad('lowpass', 1500, 0.7); this.route(this._bell, 1, 0.35); }
    this.sample(t, buf, g, this._bell, rate);
  }
  /** Far-away war drum. */
  distantDrum(t, g = 0.35) {
    const buf = this.e._instBuf('boom');
    if (!buf) return;
    if (!this._far) { this._far = this.biquad('lowpass', 260, 0.7); this.route(this._far, 0.9, 0.3); }
    this.sample(t, buf, g * DRUMS.boom.mix, this._far, rand(0.8, 1));
  }
}

// ---- ambient: title / explore / stealth -------------------------------------
const AMBIENT = {
  title: { len: [4.6, 4.6], prog: ['Dm', 'Bb', 'Gm', 'A', 'Dm', 'Bb', 'Eb', 'A'], pad: 0.04, padA: 1.4, padR: 2, padCut: 800,
    choir: 0.3, choirG: 0.025, melody: 0.06, bell: [9, 15], bellG: 0.3, drone: 0.08, air: 0, drum: 0.2, fadeIn: 2.5 },
  explore: { len: [7, 11], pad: 0.04, padA: 2.5, padR: 3, padCut: 900, choir: 0.55, choirG: 0.023,
    melody: 0, bell: [16, 34], bellG: 0.24, drone: 0.072, air: 0.03, drum: 0.12, fadeIn: 2.5 },
  stealth: { len: [8, 12], pad: 0.032, padA: 3, padR: 3, padCut: 650, choir: 0.3, choirG: 0.018,
    melody: 0, bell: [24, 44], bellG: 0.18, drone: 0.088, air: 0.03, drum: 0, pulse: 70, pulseG: 0.45, high: 0.009, fadeIn: 2 },
};

class AmbientTrack extends Track {
  constructor(eng, mode) {
    super(eng, mode);
    this.cfg = AMBIENT[mode];
    this.padCut = this.cfg.padCut;
    this.chord = 'Dm';
    this.ci = 0;
    this.mel = 69;
    this.nextChord = 0;
    this.nextBell = 0;
    this.nextBeat = 0;
  }
  begin(t) {
    const cfg = this.cfg;
    this.fadeIn(t, cfg.fadeIn);
    this.nextChord = t + 0.05;
    this.nextBell = t + rand(3, 8);
    this.nextBeat = t + 1.2;
    if (cfg.drone) { // D1/D2/A1 saws through a slowly breathing low-pass + sub
      const g = this.route(this.gainNode(cfg.drone, null), 0.35);
      const lp = this.biquad('lowpass', 170, 1.2, g);
      this.plfo(0.031, 60, lp.frequency);
      for (const [f, det, gg] of [[36.71, -5, 0.5], [36.71, 6, 0.5], [73.42, 3, 0.35], [55, 0, 0.18]]) {
        this.posc('sawtooth', f, this.gainNode(gg, lp)).detune.value = det;
      }
      this.posc('sine', 36.71, this.gainNode(0.5, g));
    }
    if (cfg.air) { // dark, slowly moving air
      const g = this.route(this.gainNode(cfg.air, null), 0.6);
      const bp = this.biquad('bandpass', 420, 1.5, g);
      this.plfo(0.07, 150, bp.frequency);
      this.pnoise('pink', bp);
    }
    if (cfg.high) { // high sustained dissonant note (Eb6 against D minor), slow shimmer
      const g = this.route(this.gainNode(cfg.high, null), 0.8);
      this.plfo(0.2, cfg.high * 0.5, g.gain);
      this.posc('sine', hz(87), g);
      this.posc('sine', hz(87) + 2.4, g);
    }
  }
  schedule(until, now) {
    if (this.nextChord < now - 1) this.nextChord = now + 0.1; // context was suspended
    while (this.nextChord < until) this.playChord(this.nextChord);
    if (this.cfg.pulse) {
      if (this.nextBeat < now - 0.5) this.nextBeat = now + 0.1;
      while (this.nextBeat < until) { this.heartbeat(this.nextBeat); this.nextBeat += 60 / this.cfg.pulse; }
    }
  }
  playChord(t) {
    const cfg = this.cfg;
    let name;
    if (cfg.prog) name = cfg.prog[this.ci++ % cfg.prog.length];
    else name = pick(CHORD_NEXT[this.chord]);
    this.chord = name;
    const len = rand(cfg.len[0], cfg.len[1]);
    const [r, th, fi] = CHORDS[name];
    const dur = len + cfg.padR; // chords overlap by their release
    this.pad(t, pcIn(r, 38, 49), dur, cfg.pad * 1.2, cfg.padA, cfg.padR);
    for (const m of [pcIn(th, 53, 64), pcIn(fi, 55, 67), pcIn(pick([r, th, fi]), 60, 70)]) {
      this.pad(t + rand(0, 0.5), m, dur, cfg.pad, cfg.padA, cfg.padR);
    }
    if (chance(cfg.choir)) {
      const tt = t + rand(0.3, 2);
      const notes = [pcIn(r, 57, 69), pcIn(th, 60, 72), pcIn(fi, 62, 74)].slice(0, pick([2, 3]));
      for (const m of notes) this.choirNote(tt, m, dur - (tt - t), cfg.choirG, 2.2, 2.6);
    }
    if (cfg.melody && chance(0.8)) this.melody(t, len, name);
    if (t >= this.nextBell) {
      this.bellHit(t + rand(0.3, len * 0.6), pick([0.5, 0.75, 1, 1]), cfg.bellG);
      this.nextBell = t + rand(cfg.bell[0], cfg.bell[1]);
    }
    if (cfg.drum && chance(cfg.drum)) this.distantDrum(t + rand(1, Math.max(1.2, len - 1)));
    this.nextChord = t + len;
  }
  /** Sparse minor-key melody: stepwise motion that lands on chord tones. */
  melody(t, len, name) {
    const pcs = CHORDS[name];
    const scale = name === 'A' ? [2, 4, 5, 7, 9, 10, 1] : [2, 4, 5, 7, 9, 10, 0];
    const n = pick([1, 2, 2, 3]);
    let tt = t + rand(0.2, 0.9);
    for (let i = 0; i < n; i++) {
      const left = t + len - tt;
      if (left < 0.6) break;
      const d = i === n - 1 ? left + 0.4 : (left / (n - i)) * rand(0.8, 1.15);
      const cands = [];
      for (let m = this.mel - 5; m <= this.mel + 5; m++) {
        if (m < 60 || m > 79) continue;
        const pc = m % 12;
        if (pcs.includes(pc)) cands.push(m, m);
        else if (scale.includes(pc) && i < n - 1) cands.push(m);
      }
      const m = cands.length ? pick(cands) : pcIn(pcs[0], 62, 74);
      this.lead(tt, m, Math.max(0.5, d), this.cfg.melody);
      this.mel = m;
      tt += d;
    }
  }
  /** Muffled heartbeat pulse (lub-dub). */
  heartbeat(t) {
    if (!this._hb) this._hb = this.route(this.biquad('lowpass', 140, 0.7), 0.08);
    for (const [dt, g, f] of [[0, 1, 62], [0.26, 0.6, 55]]) {
      const env = this.gainNode(0, this._hb);
      env.gain.setValueAtTime(0, t + dt);
      env.gain.linearRampToValueAtTime(g * this.cfg.pulseG, t + dt + 0.005);
      env.gain.exponentialRampToValueAtTime(EPS, t + dt + 0.2);
      const o = this.voiceOsc('sine', f, 0, t + dt, 0.22, env);
      o.frequency.setValueAtTime(f, t + dt);
      o.frequency.exponentialRampToValueAtTime(f * 0.62, t + dt + 0.09);
    }
  }
}

// ---- metal: combat / boss ----------------------------------------------------
class MetalTrack extends Track {
  constructor(eng, mode) {
    super(eng, mode);
    const cfg = (this.cfg = METAL[mode]);
    this.sd = 60 / cfg.bpm / 4; // one sixteenth
    this.step = 0;
    this.sec = cfg.first;
    this.secBar = 0;
    this.intro = mode === 'combat' ? 8 : 0; // half-bar drum fill into the downbeat
    this.choirIdx = 0;
    this.fillChord = 'H';
    this.gBus = [-0.75, 0.75].map((p) => this.gainNode(cfg.gtr, this.panNode(p, this.route(this.gainNode(1, null), 0.12))));
    this.bBus = this.route(this.gainNode(cfg.bass, null), 0.05);
    this.dBus = this.route(this.gainNode(cfg.drums, null), 0.16);
    this.pans = new Map();
    this.gPrev = [null, null];
    this.bPrev = [null];
    this.next = 0;
    this.started = false;
  }
  begin(t) {
    this.fadeIn(t, this.mode === 'combat' ? 0.03 : 0.8);
    this.next = t + 0.06;
  }
  schedule(until, now) {
    if (!this.e._instReady) { this.next = Math.max(this.next, now + 0.06); return; } // samples still rendering
    if (this.next < now - 0.2) this.next = now + 0.06; // resync after a suspension
    while (this.next < until) { this.tick16(this.next); this.next += this.sd; }
  }
  tick16(t) {
    const cfg = this.cfg;
    if (!this.started) {
      this.started = true;
      if (this.mode === 'boss') { this.drum(t, 'boom', 0.9); this.drum(t, 'crash', 0.5, -0.35); }
    }
    if (this.intro > 0) { this.introStep(t, 8 - this.intro); this.intro--; return; }
    const s = this.step % 16;
    if (s === 0 && this.step > 0 && ++this.secBar >= 8) {
      this.secBar = 0;
      const opts = cfg.next[this.sec];
      this.sec = pick(opts.filter((x) => x !== this.sec).concat(opts));
    }
    const style = cfg.sections[this.sec];
    if (s === 0) {
      if (this.secBar === 6) this.fillChord = pick(['H', 'R', 'A', 'G']);
      if (cfg.choir && this.secBar % 2 === 0) this.bossChoir(t);
      if (this.secBar === 0 && (style === 'half' || this.mode === 'boss') && this.step > 0) this.drum(t, 'boom', 0.55);
      if (this.secBar === 0 || (this.secBar === 4 && style !== 'double')) this.drum(t, 'crash', this.secBar === 0 ? 0.5 : 0.36, -0.35);
      else if (style === 'half') this.drum(t, 'crash', 0.22, 0.35);
    }
    const fill = this.secBar === 7 && s >= 8;
    let ch = RIFFS[this.sec][this.secBar % 4][s];
    if (fill) ch = s === 8 ? this.fillChord : '-';
    const hit = ch !== '.' && ch !== '-';
    const accent = hit && ch !== ch.toLowerCase();
    if (ch === '.') { this.choke(this.gPrev, 0, t); this.choke(this.gPrev, 1, t); this.choke(this.bPrev, 0, t); }
    else if (hit) this.guitar(t, NOTE[ch.toLowerCase()] || 0, !accent);
    if (fill) this.fillDrums(t, s);
    else this.groove(t, s, style, hit, accent);
    this.step++;
  }
  groove(t, s, style, hit, accent) {
    const v = (x) => x * rand(0.9, 1.05);
    if (style === 'rock') {
      if (hit) this.drum(t, 'kick', v(accent ? 1 : 0.82));
      if (s === 4 || s === 12) this.drum(t, 'snare', v(0.9));
      if (s % 2 === 0) this.drum(t, 'hat', v(s % 4 === 0 ? 0.55 : 0.38), 0.25);
    } else if (style === 'double') {
      this.drum(t, 'kick', v(s % 2 ? 0.6 : 0.78));
      if (s === 4 || s === 12) this.drum(t, 'snare', v(0.95));
      if (s % 4 === 0) this.drum(t, 'ohat', v(0.32), 0.25);
    } else if (style === 'half') {
      if (hit || s === 0) this.drum(t, 'kick', v(accent || s === 0 ? 1 : 0.8));
      if (s === 8) this.drum(t, 'snare', v(1));
      if (s % 4 === 0) this.drum(t, s === 0 ? 'ohat' : 'hat', v(0.4), 0.25);
    } else { // gallop
      if (s % 4 !== 1) this.drum(t, 'kick', v(s % 4 === 0 ? 0.95 : 0.7));
      if (s === 8) this.drum(t, 'snare', v(1));
      if (s % 4 === 0) this.drum(t, 'hat', v(0.4), 0.25);
    }
  }
  fillDrums(t, s) {
    const name = ['snare', 'snare', 'tomH', 'tomH', 'tomM', 'tomM', 'tomL', 'tomL'][s - 8];
    this.drum(t, name, 0.6 + (s - 8) * 0.05, name === 'tomH' ? -0.3 : name === 'tomL' ? 0.3 : 0);
    if (s === 8 || s === 14) this.drum(t, 'kick', 0.9);
  }
  introStep(t, i) {
    const [name, g] = [['snare', 0.42], ['snare', 0.5], ['snare', 0.58], ['snare', 0.68], ['tomH', 0.75], ['tomM', 0.8], ['tomL', 0.85], ['tomL', 0.9]][i];
    this.drum(t, name, g, name === 'tomH' ? -0.3 : name === 'tomL' ? 0.3 : 0);
    if (i === 7) this.drum(t, 'kick', 0.9);
  }
  guitar(t, n, mute) {
    const inst = this.e._inst, key = mute ? 'm' : 'o';
    const g = inst.gtr[n], b = inst.bass[n];
    for (let side = 0; side < 2; side++) {
      const tt = t + side * 0.006 + rand(0, 0.003); // double-tracked, slightly loose
      this.choke(this.gPrev, side, tt);
      this.gPrev[side] = g ? this.sample(tt, g[key][side % g[key].length], mute ? 0.85 : 1, this.gBus[side]) : null;
    }
    this.choke(this.bPrev, 0, t);
    this.bPrev[0] = b ? this.sample(t, b[key][0], 1, this.bBus) : null;
  }
  choke(arr, i, t) {
    const p = arr[i];
    if (!p) return;
    p.g.gain.setTargetAtTime(0, t, 0.006);
    try { p.s.stop(t + 0.05); } catch (e) { /* ignore */ }
    arr[i] = null;
  }
  drum(t, name, g, pan = 0) {
    const buf = this.e._instBuf(name);
    if (!buf) return;
    let dest = this.dBus;
    if (pan) {
      if (!this.pans.has(pan)) this.pans.set(pan, this.panNode(pan, this.dBus));
      dest = this.pans.get(pan);
    }
    this.sample(t, buf, g * (DRUMS[name].mix || 1), dest);
  }
  /** Dark low choir pad over the boss riffs (D Phrygian colours). */
  bossChoir(t) {
    const prog = [[50, 53, 57], [51, 55, 58], [50, 53, 57], [48, 51, 55]];
    const ch = prog[this.choirIdx++ % prog.length];
    for (const m of ch) this.choirNote(t, m, this.sd * 32 + 0.8, 0.04, 0.7, 1.1);
  }
}

// ---- victory: warm resolving swell, then silence -----------------------------
class VictoryTrack extends Track {
  begin(t) {
    this.padCut = 1500;
    this.fadeIn(t, 0.2);
    const t0 = t + 0.05;
    for (const m of [38, 50, 54, 57, 62]) this.pad(t0, m, 8, 0.055, 2, 3.5);
    for (const m of [62, 66, 69, 74]) this.choirNote(t0 + 0.4, m, 7.4, 0.032, 2.4, 3.5);
    this.lead(t0 + 1.2, 74, 2.2, 0.05);
    this.lead(t0 + 3.4, 78, 3.6, 0.05);
    this.bellHit(t0, 1, 0.3);
    this.bellHit(t0 + 2.4, 1.5, 0.16);
    this.endAt = t0 + 9;
  }
}

// =============================================================================
// AudioEngine - public API
// =============================================================================
const NOOP_LOOP = Object.freeze({ setVolume() {}, setPos() {}, setPitch() {}, stop() {} });
export const SFX_NAMES = Object.freeze(Object.keys(SFX));
export const LOOP_NAMES = Object.freeze(Object.keys(LOOPS));
export const MUSIC_NAMES = Object.freeze(MUSIC_MODES.slice());

function setPannerPos(p, pos) {
  if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
  else p.setPosition(pos.x, pos.y, pos.z);
}
/** Copy [t0, t0+dur) of rendered data into its own buffer with a 4 ms safety fade at the end. */
function sliceBuffer(ctx, data, sr, t0, dur, peak = 0) {
  const i0 = Math.floor(t0 * sr), n = Math.min(Math.ceil(dur * sr), data.length - i0);
  const b = makeBuffer(ctx, 1, n, sr);
  const d = b.getChannelData(0);
  d.set(data.subarray(i0, i0 + n));
  const f = Math.min(n, Math.floor(sr * 0.004)), fi = Math.min(n, Math.ceil(sr * 0.0006));
  for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  for (let i = 0; i < fi; i++) d[i] *= i / fi; // no onset click
  if (peak) normalize(d, peak);
  return b;
}

export class AudioEngine {
  constructor() {
    this.ctx = null; // created lazily in unlock() (autoplay policy)
    this.res = null; // shared noise buffers
    this._vol = { master: 0.9, music: 0.8, sfx: 1 };
    this._paused = false;
    this._mode = 'none'; // requested music mode
    this._tracks = [];
    this._cache = new Map(); // sfx name -> AudioBuffer[] (variants)
    this._loopBufs = new Map(); // buffer-loop name -> AudioBuffer
    this._inst = { drums: {}, gtr: {}, bass: {} };
    this._instReady = false;
    this._jobs = new Map(); // render key -> job
    this._queue = [];
    this._active = 0;
    this._pumpTimer = null;
    this._voices = [];
    this._loops = new Set();
    this._last = new Map();
    this._warned = new Set();
    this._lis = { x: 0, y: 0, z: 0 };
    this._timer = null;
    this._failed = false;
  }

  /** True once the AudioContext exists and is running. */
  get ready() {
    try { return !!this.ctx && this.ctx.state === 'running'; } catch (e) { return false; }
  }

  /** Call on any user gesture: creates / resumes the AudioContext. Idempotent. */
  unlock() {
    if (!AudioCtx || this._failed) return;
    try {
      if (!this.ctx) this._init();
      const c = this.ctx;
      if (c && c.state !== 'running' && c.state !== 'closed') {
        const p = c.resume();
        if (p && p.catch) p.catch(() => {});
        // iOS needs a sound started inside the gesture
        const s = c.createBufferSource();
        s.buffer = makeBuffer(c, 1, 1, 22050);
        s.connect(c.destination);
        s.start(0);
      }
    } catch (e) { this._fail(e); }
  }

  // ---------------------------------------------------------------------------
  // Context, buses and resources
  // ---------------------------------------------------------------------------
  _init() {
    let c;
    try { c = new AudioCtx({ latencyHint: 'interactive' }); } catch (e) { c = new AudioCtx(); }
    this.ctx = c;
    // Shared seamless noise buffers: generated on first use, and warmed one per task
    // right after unlock so unlock() itself stays short.
    this.res = { noise: {} };
    [['white', 1.5], ['pink', 2], ['brown', 2]].forEach(([kind, secs], i) => {
      let buf = null;
      Object.defineProperty(this.res.noise, kind, { enumerable: true, get: () => buf || (buf = makeNoise(c, kind, secs)) });
      setTimeout(() => { try { void this.res.noise[kind]; } catch (e) { /* ignore */ } }, 1 + i * 6);
    });

    // master: compressor (glue) -> limiter (safety) -> master volume
    this.masterGain = c.createGain();
    this.masterGain.connect(c.destination);
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
    lim.connect(this.masterGain);
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.006; comp.release.value = 0.25;
    comp.connect(lim);
    this.masterIn = c.createGain();
    this.masterIn.connect(comp);
    this.pauseFilter = c.createBiquadFilter();
    this.pauseFilter.type = 'lowpass';
    this.pauseFilter.frequency.value = 20000;
    this.pauseFilter.connect(this.masterIn);

    // shared reverb (generated dark hall impulse; built in a later task to keep unlock() short)
    this.reverb = c.createConvolver();
    this.reverb.normalize = false;
    this._buildReverb();
    const revHp = c.createBiquadFilter();
    revHp.type = 'highpass';
    revHp.frequency.value = 140;
    const revRet = c.createGain();
    revRet.gain.value = 0.45;
    this.reverb.connect(revHp);
    revHp.connect(revRet);
    revRet.connect(this.pauseFilter);

    const bus = (dest) => { const g = c.createGain(); g.connect(dest); return g; };
    this.sfxBus = bus(this.pauseFilter);
    this.sfxSend = bus(this.reverb);
    this.musicBus = bus(this.pauseFilter);
    this.musicSend = bus(this.reverb);
    this.uiBus = bus(this.masterIn);
    this._applyGains(true);

    const L = c.listener;
    if (L.upX) { L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1; }
    else if (L.setOrientation) L.setOrientation(0, 0, -1, 0, 1, 0);

    this._timer = setInterval(() => this._tick(), TICK_MS);
    // background tabs throttle timers: extend the lookahead immediately when hidden
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', () => this._tick());
    this._queueAll();
    if (this._mode !== 'none') this._startMusic(this._mode);
  }

  _applyGains(instant) {
    const c = this.ctx;
    if (!c) return;
    const t = c.currentTime, v = this._vol, p = this._paused;
    const set = (param, val, tau = 0.1) => { if (instant) param.value = val; else rampTo(param, val, t, tau); };
    const sfx = v.sfx * (p ? 0.12 : 1);
    const mus = v.music * MUSIC_LEVEL * (p ? 0.25 : 1);
    set(this.sfxBus.gain, sfx);
    set(this.sfxSend.gain, sfx);
    set(this.musicBus.gain, mus);
    set(this.musicSend.gain, mus);
    set(this.uiBus.gain, v.sfx);
    set(this.masterGain.gain, v.master, 0.05);
    set(this.pauseFilter.frequency, p ? 900 : 20000, 0.12);
  }

  /** Generate the reverb impulse in small tasks (one per channel) so unlock() stays short. */
  _buildReverb() {
    const c = this.ctx, b = makeBuffer(c, 2, Math.floor(c.sampleRate * 2.3), c.sampleRate);
    let energy = 0, ch = 0;
    const step = () => {
      try {
        if (ch < 2) { energy += fillImpulse(b.getChannelData(ch++), b.sampleRate); setTimeout(step, 15); return; }
        const k = 1.2 / Math.sqrt(energy / 2 || 1);
        for (let i = 0; i < 2; i++) { const d = b.getChannelData(i); for (let j = 0; j < d.length; j++) d[j] *= k; }
        this.reverb.buffer = b;
      } catch (e) { this._warnOnce('reverb', e); }
    };
    setTimeout(step, 30);
  }
  _fail(e) {
    this._failed = true;
    this._warnOnce('init', e);
    try { if (this._timer) clearInterval(this._timer); } catch (err) { /* ignore */ }
  }
  _warnName(name) {
    if (this._warned.has(name)) return;
    this._warned.add(name);
    console.warn(`[audio] unknown sound "${name}"`);
  }
  _warnOnce(tag, e) {
    if (this._warned.has('!' + tag)) return;
    this._warned.add('!' + tag);
    console.warn(`[audio] ${tag} failed:`, e && e.message ? e.message : e);
  }

  // ---------------------------------------------------------------------------
  // Pre-render queue (OfflineAudioContext renders run off the main thread;
  // only small graph construction happens here, one job at a time per slot)
  // ---------------------------------------------------------------------------
  _queueAll() {
    const first = ['step', 'jump', 'land', 'swing', 'hitFlesh', 'climb', 'grab', 'uiHover', 'uiClick', 'uiBack',
      'dodge', 'block', 'parry', 'hitArmor', 'swingHeavy', 'gore', 'demonPain'];
    for (const n of first) this._job('sfx:' + n);
    this._job('loop:fireCrackle');
    this._job('loop:burning');
    this._job('inst:drums');
    for (const n of GTR_NOTES) this._job('inst:gtr:' + n);
    this._job('inst:bass');
    this._job('sfx:bell');
    for (const n of SFX_NAMES) this._job('sfx:' + n);
    this._pump();
  }
  /** Queue (or bump to the front) a render job; resolves when it finished. */
  _job(key, front = false) {
    let j = this._jobs.get(key);
    if (!j) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      j = { key, promise, resolve, state: 'queued' };
      this._jobs.set(key, j);
      if (front) this._queue.unshift(j); else this._queue.push(j);
    } else if (front && j.state === 'queued') {
      const i = this._queue.indexOf(j);
      if (i > 0) { this._queue.splice(i, 1); this._queue.unshift(j); }
    }
    return j.promise;
  }
  /** Start queued jobs, at most one per macrotask so graph building never piles up in one frame. */
  _pump() {
    if (this._pumpTimer || !OfflineCtx) return;
    this._pumpTimer = setTimeout(() => {
      this._pumpTimer = null;
      if (this._active >= 2 || !this._queue.length) return;
      const j = this._queue.shift();
      j.state = 'running';
      this._active++;
      let p;
      try { p = this._runJob(j.key); } catch (e) { p = Promise.reject(e); }
      p.catch((e) => this._warnOnce('render ' + j.key, e)).then(() => {
        j.state = 'done';
        this._active--;
        j.resolve();
        this._pump();
      });
      if (this._queue.length) this._pump();
    }, 0);
  }
  _runJob(key) {
    const [kind, name, arg] = key.split(':');
    if (kind === 'sfx') return this._renderSfx(name).then((bufs) => { this._cache.set(name, bufs); });
    if (kind === 'loop') return this._renderLoop(name);
    if (name === 'drums') return this._renderDrums();
    if (name === 'gtr') return this._renderGuitar(Number(arg));
    return this._renderBass();
  }
  _rate(lo) { return lo ? 22050 : Math.min(48000, this.ctx.sampleRate); }

  /** Render `vars` variants of a one-shot into separate buffers. */
  _renderSfx(name, vars) {
    const def = SFX[name], sr = this._rate(def.lo);
    vars = vars || def.v || 1;
    const seg = def.d + 0.06;
    const oc = new OfflineCtx(1, Math.ceil(seg * vars * sr), sr);
    const out = sfxOut(oc, oc.destination);
    for (let i = 0; i < vars; i++) def.r(new Kit(oc, out, i * seg, this.res));
    return renderOffline(oc).then((buf) => {
      const data = buf.getChannelData(0), out = [];
      for (let i = 0; i < vars; i++) out.push(sliceBuffer(this.ctx, data, sr, i * seg, def.d));
      return out;
    });
  }
  /** Render a seamless loop buffer (tail crossfaded into the head). */
  _renderLoop(name) {
    const def = LOOPS[name], sr = this._rate(false), x = 0.35;
    const oc = new OfflineCtx(1, Math.ceil((def.len + x + 0.1) * sr), sr);
    def.render(new Kit(oc, oc.destination, 0, this.res), def.len);
    return renderOffline(oc).then((buf) => {
      const n = Math.floor(def.len * sr);
      const b = makeBuffer(this.ctx, 1, n, sr);
      b.getChannelData(0).set(seamless(buf.getChannelData(0), n, Math.floor(x * sr)));
      this._loopBufs.set(name, b);
    });
  }
  /** Lay out several instrument renders in one offline context and slice them apart. */
  _renderSlots(sr, slots, store) {
    let t = 0;
    for (const s of slots) { s.t0 = t; t += s.d + 0.05; }
    const oc = new OfflineCtx(1, Math.ceil(t * sr), sr);
    for (const s of slots) s.r(new Kit(oc, oc.destination, s.t0, this.res));
    return renderOffline(oc).then((buf) => {
      const data = buf.getChannelData(0);
      for (const s of slots) store(s, sliceBuffer(this.ctx, data, sr, s.t0, s.d, 0.9)); // instruments: peak-normalized
      this._checkInst();
    });
  }
  _renderDrums() {
    const slots = [];
    for (const [name, def] of Object.entries(DRUMS)) for (let i = 0; i < (def.v || 1); i++) slots.push({ name, d: def.d, r: def.r });
    return this._renderSlots(this._rate(false), slots, (s, b) => {
      const D = this._inst.drums;
      if (!D[s.name]) D[s.name] = [];
      D[s.name].push(b);
    });
  }
  _renderGuitar(n) {
    const f = hz(GTR_ROOT + n), set = { m: [], o: [] }, slots = [];
    for (const key of ['m', 'm', 'o', 'o']) slots.push({ key, d: key === 'm' ? 0.26 : 1.6, r: (k) => renderGuitar(k, f, key === 'm') });
    return this._renderSlots(Math.min(32000, this._rate(false)), slots, (s, b) => {
      set[s.key].push(b);
      if (set.m.length === 2 && set.o.length === 2) this._inst.gtr[n] = set;
    });
  }
  _renderBass() {
    const slots = [];
    for (const n of GTR_NOTES) {
      const f = hz(GTR_ROOT - 12 + n);
      for (const key of ['m', 'o']) slots.push({ n, key, d: key === 'm' ? 0.26 : 1.5, r: (k) => renderBass(k, f, key === 'm') });
    }
    return this._renderSlots(22050, slots, (s, b) => {
      if (!this._inst.bass[s.n]) this._inst.bass[s.n] = { m: [], o: [] };
      const set = this._inst.bass[s.n];
      set[s.key].push(b);
    });
  }
  _checkInst() {
    const I = this._inst;
    this._instReady = !!(I.drums.kick && I.drums.boom && I.bass[12] && GTR_NOTES.every((n) => I.gtr[n]));
  }
  /** A random rendered variant of a one-shot, or null (and queue it). */
  _sfxBuf(name) {
    const b = this._cache.get(name);
    if (b) return pick(b);
    if (SFX[name]) { this._job('sfx:' + name, true); this._pump(); }
    return null;
  }
  _instBuf(name) {
    const b = this._inst.drums[name];
    return b ? pick(b) : null;
  }

  // ---------------------------------------------------------------------------
  // Lookahead scheduler (audio clock driven; independent of frame rate)
  // ---------------------------------------------------------------------------
  _tick() {
    const c = this.ctx;
    if (!c || c.state === 'closed') return;
    try {
      const now = c.currentTime;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const until = now + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
      for (const tr of this._tracks) tr.schedule(until, now);
      if (this._tracks.length) {
        this._tracks = this._tracks.filter((tr) => {
          if (now <= tr.endAt) return true;
          tr.dispose();
          return false;
        });
      }
      for (const l of this._loops) if (l.tick) l.tick(now);
      if (this._voices.length) {
        for (const v of this._voices) if (!v.done && now > v.end + 0.15) this._release(v);
        this._voices = this._voices.filter((v) => !v.done);
      }
    } catch (e) { this._warnOnce('tick', e); }
  }

  // ---------------------------------------------------------------------------
  // Listener
  // ---------------------------------------------------------------------------
  /** pos / forward: {x,y,z}, Y up. Call every frame. */
  setListener(pos, forward) {
    try {
      const c = this.ctx;
      if (!c || !vec(pos)) return;
      this._lis.x = pos.x; this._lis.y = pos.y; this._lis.z = pos.z;
      let fx = 0, fy = 0, fz = -1;
      if (vec(forward)) {
        const l = Math.hypot(forward.x, forward.y, forward.z);
        if (l > 1e-6) { fx = forward.x / l; fy = forward.y / l; fz = forward.z / l; }
      }
      if (Math.abs(fy) > 0.98) { // never parallel to the up vector
        const h = Math.hypot(fx, fz) || 1;
        fx = (fx / h) * 0.2 || 0; fz = (fz / h) * 0.2 || -0.2; fy = Math.sign(fy) * 0.98;
      }
      const L = c.listener;
      if (L.positionX) {
        L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
        L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      } else {
        L.setPosition(pos.x, pos.y, pos.z);
        L.setOrientation(fx, fy, fz, 0, 1, 0);
      }
    } catch (e) { /* never break the frame */ }
  }
  _dist(pos) {
    const L = this._lis;
    return Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z);
  }
  _panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = PAN_REF;
    p.rolloffFactor = PAN_ROLL;
    p.maxDistance = PAN_MAX;
    setPannerPos(p, pos);
    return p;
  }
  /** Air absorption: distant sounds lose their highs. */
  _airCut(d) { return clamp(20000 / (1 + d / 12), 1600, 20000); }
  /** Reverb send scale: far sounds keep more of their reverb than their dry level. */
  _sendScale(d) { return Math.min(1, 0.25 + 0.75 * Math.sqrt(distGain(d))); }

  // ---------------------------------------------------------------------------
  // One-shots
  // ---------------------------------------------------------------------------
  /**
   * Play a one-shot. opts: { pos?:{x,y,z}, volume?=1, pitch?=1, pan?:-1..1 (no pos) }.
   * Returns { stop() } or null.
   */
  play(name, opts = {}) {
    try {
      const c = this.ctx;
      if (!c || this._failed || c.state === 'closed') return null;
      const def = SFX[name];
      if (!def) { this._warnName(name); return null; }
      opts = opts || {};
      const now = c.currentTime;
      const last = this._last.get(name);
      if (last !== undefined && now - last < REPEAT_GUARD && now >= last) return null;
      const vol = clamp(num(opts.volume, 1), 0, 4);
      const pos = vec(opts.pos) ? opts.pos : null;
      const dist = pos ? this._dist(pos) : 0;
      const gain = vol * def.vol * (CAL[name] || 1);
      const loud = gain * (pos ? distGain(dist) : 1);
      if (loud < 0.003) return null;
      if (!this._admit(loud)) return null;
      this._last.set(name, now);
      const chain = this._chain(def, gain, pos, dist, opts.pan);
      const bufs = this._cache.get(name);
      const v = { name, src: null, chain, start: now, end: now + def.d, loud, done: false, stopping: false };
      if (bufs) {
        const src = c.createBufferSource();
        src.buffer = pick(bufs);
        const rate = clamp(num(opts.pitch, 1), 0.25, 4) * (1 + rand(-def.pv, def.pv));
        src.playbackRate.value = rate;
        src.connect(chain.input);
        src.onended = () => this._release(v);
        src.start(now);
        v.src = src;
        v.end = now + src.buffer.duration / rate;
      } else {
        // Not rendered yet: synthesize live with the same recipe and bump its render.
        this._job('sfx:' + name, true);
        this._pump();
        def.r(new Kit(c, sfxOut(c, chain.input), now + 0.005, this.res));
        v.end = now + def.d + 0.06;
      }
      this._voices.push(v);
      return { stop: () => this._stopVoice(v) };
    } catch (e) {
      this._warnOnce('play', e);
      return null;
    }
  }
  /** Voice output chain: gain -> (air filter -> panner | stereo pan) -> bus, + reverb send. */
  _chain(def, gain, pos, dist, pan) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = gain;
    const nodes = [g];
    const bus = def.ui ? this.uiBus : this.sfxBus;
    if (pos) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = this._airCut(dist);
      const p = this._panner(pos);
      g.connect(lp); lp.connect(p); p.connect(bus);
      nodes.push(lp, p);
    } else if (typeof pan === 'number' && pan && c.createStereoPanner) {
      const sp = c.createStereoPanner();
      sp.pan.value = clamp(pan, -1, 1);
      g.connect(sp); sp.connect(bus);
      nodes.push(sp);
    } else g.connect(bus);
    if (def.rev > 0 && !def.ui) {
      const s = c.createGain();
      s.gain.value = def.rev * (pos ? this._sendScale(dist) : 1);
      g.connect(s); s.connect(this.sfxSend);
      nodes.push(s);
    }
    return { input: g, gain: g, nodes };
  }
  /** Voice cap: when full, fade out the quietest / most finished voice (or drop the newcomer if it is quieter still). */
  _admit(loud) {
    let count = 0, worst = null, ws = Infinity;
    const now = this.ctx.currentTime;
    for (const v of this._voices) {
      if (v.done || v.stopping) continue;
      count++;
      const rem = clamp((v.end - now) / Math.max(0.02, v.end - v.start), 0, 1);
      const score = v.loud * (0.2 + 0.8 * rem);
      if (score < ws) { ws = score; worst = v; }
    }
    if (count < MAX_VOICES || !worst) return true;
    if (loud < ws) return false;
    this._stopVoice(worst, 0.02);
    return true;
  }
  _stopVoice(v, fade = 0.04) {
    if (!v || v.done || v.stopping) return;
    try {
      const t = this.ctx.currentTime;
      v.stopping = true;
      rampTo(v.chain.gain.gain, 0, t, fade / 3);
      if (v.src) v.src.stop(t + fade + 0.02);
      v.end = Math.min(v.end, t + fade);
    } catch (e) { this._release(v); }
  }
  _release(v) {
    if (v.done) return;
    v.done = true;
    for (const n of v.chain.nodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    if (v.src) { try { v.src.disconnect(); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------------------
  // Loops
  // ---------------------------------------------------------------------------
  /** Continuous sound. Returns { setVolume, setPos, setPitch, stop(fade=0.2) }. */
  loop(name, opts = {}) {
    try {
      if (!this.ready || this._failed) return NOOP_LOOP;
      const def = LOOPS[name];
      if (!def) { this._warnName(name); return NOOP_LOOP; }
      opts = opts || {};
      const c = this.ctx, now = c.currentTime;
      const L = { def, vol: clamp(num(opts.volume, 1), 0, 4), pitch: clamp(num(opts.pitch, 1), 0.25, 4), stopped: false,
        src: null, graph: null, tick: null, panner: null, lp: null, send: null, dist: 0 };
      const vg = (L.vg = c.createGain());
      vg.gain.value = 0;
      vg.gain.setTargetAtTime(L.vol * def.vol, now, 0.06);
      L.send = c.createGain();
      L.send.gain.value = def.rev;
      vg.connect(L.send);
      L.send.connect(this.sfxSend);
      if (vec(opts.pos)) this._loopPos(L, opts.pos, true);
      else vg.connect(this.sfxBus);
      if (def.render) {
        const start = () => {
          const b = this._loopBufs.get(name);
          if (!b || L.stopped) return;
          const s = c.createBufferSource();
          s.buffer = b;
          s.loop = true;
          s.playbackRate.value = L.pitch;
          s.connect(vg);
          s.start(c.currentTime, Math.random() * b.duration);
          L.src = s;
        };
        if (this._loopBufs.has(name)) start();
        else { this._job('loop:' + name, true).then(start); this._pump(); }
      } else {
        L.graph = new LiveGraph(c, vg, this.res);
        L.tick = def.create(L.graph) || null;
        if (L.pitch !== 1) L.graph.setPitch(L.pitch, now);
      }
      this._loops.add(L);
      return {
        setVolume: (v) => { try { if (!L.stopped) { L.vol = clamp(num(v, L.vol), 0, 4); rampTo(vg.gain, L.vol * def.vol, c.currentTime, 0.05); } } catch (e) { /* ignore */ } },
        setPos: (p) => { try { if (!L.stopped && vec(p)) this._loopPos(L, p, false); } catch (e) { /* ignore */ } },
        setPitch: (p) => {
          try {
            if (L.stopped) return;
            L.pitch = clamp(num(p, L.pitch), 0.25, 4);
            if (L.src) rampTo(L.src.playbackRate, L.pitch, c.currentTime, 0.05);
            if (L.graph) L.graph.setPitch(L.pitch, c.currentTime);
          } catch (e) { /* ignore */ }
        },
        stop: (fade = 0.2) => { try { this._stopLoop(L, fade); } catch (e) { /* ignore */ } },
      };
    } catch (e) {
      this._warnOnce('loop', e);
      return NOOP_LOOP;
    }
  }
  _loopPos(L, pos, initial) {
    const c = this.ctx;
    if (!L.panner) {
      L.lp = c.createBiquadFilter();
      L.lp.type = 'lowpass';
      L.lp.frequency.value = this._airCut(this._dist(pos));
      L.send.gain.value = L.def.rev * this._sendScale(this._dist(pos));
      L.panner = this._panner(pos);
      if (!initial) { try { L.vg.disconnect(this.sfxBus); } catch (e) { /* ignore */ } }
      L.vg.connect(L.lp);
      L.lp.connect(L.panner);
      L.panner.connect(this.sfxBus);
      L.dist = -10;
    }
    setPannerPos(L.panner, pos);
    const d = this._dist(pos);
    if (Math.abs(d - L.dist) > 1) { // cheap: only re-tune distance cues when it moved
      L.dist = d;
      const t = c.currentTime;
      rampTo(L.lp.frequency, this._airCut(d), t, 0.1);
      rampTo(L.send.gain, L.def.rev * this._sendScale(d), t, 0.1);
    }
  }
  _stopLoop(L, fade) {
    if (L.stopped) return;
    L.stopped = true;
    this._loops.delete(L);
    const c = this.ctx, t = c.currentTime;
    fade = clamp(num(fade, 0.2), 0, 10);
    const tau = Math.max(0.005, fade / 4);
    rampTo(L.vg.gain, 0, t, tau);
    const end = t + tau * 6 + 0.05; // ~-52 dB before the sources stop: no click
    if (L.src) { try { L.src.stop(end); } catch (e) { /* ignore */ } }
    if (L.graph) L.graph.stop(end);
    setTimeout(() => {
      for (const n of [L.vg, L.send, L.lp, L.panner]) { if (n) { try { n.disconnect(); } catch (e) { /* ignore */ } } }
    }, (end - t + 0.2) * 1000);
  }

  // ---------------------------------------------------------------------------
  // Music, volumes, pause
  // ---------------------------------------------------------------------------
  /** 'none'|'title'|'explore'|'stealth'|'combat'|'boss'|'victory'. Same mode = no-op. */
  setMusic(mode) {
    try {
      if (!MUSIC_MODES.includes(mode)) { this._warnName('music:' + mode); return; }
      if (mode === this._mode) return;
      this._mode = mode;
      if (this.ctx && !this._failed) this._startMusic(mode);
    } catch (e) { this._warnOnce('music', e); }
  }
  _startMusic(mode) {
    const c = this.ctx, now = c.currentTime;
    const fast = mode === 'combat' || mode === 'boss' || mode === 'victory';
    for (const tr of this._tracks) if (!tr.fading) tr.fadeOut(now, fast ? 1.5 : 2.2);
    if (mode === 'none') return;
    const tr = mode === 'combat' || mode === 'boss' ? new MetalTrack(this, mode)
      : mode === 'victory' ? new VictoryTrack(this, mode) : new AmbientTrack(this, mode);
    tr.begin(now);
    this._tracks.push(tr);
    tr.schedule(now + LOOKAHEAD, now);
  }
  /** { master, music, sfx }, each 0..1, any subset. */
  setVolumes(v) {
    try {
      if (!v) return;
      for (const k of ['master', 'music', 'sfx']) if (typeof v[k] === 'number' && Number.isFinite(v[k])) this._vol[k] = clamp(v[k], 0, 1);
      if (this.ctx && !this._failed) this._applyGains(false);
    } catch (e) { this._warnOnce('volumes', e); }
  }
  /** true: strongly duck sfx and music (and muffle them) for the pause menu. UI sounds stay. */
  setPaused(paused) {
    try {
      paused = !!paused;
      if (paused === this._paused) return;
      this._paused = paused;
      if (this.ctx && !this._failed) this._applyGains(false);
    } catch (e) { this._warnOnce('pause', e); }
  }

  // ---------------------------------------------------------------------------
  // Dev helpers (used by the test harness; harmless in production)
  // ---------------------------------------------------------------------------
  /** Render a one-shot `n` times offline and report raw (pre-calibration) peak / RMS. */
  _measure(name, n = 6) {
    if (!this.ctx || !SFX[name]) return Promise.resolve(null);
    return this._renderSfx(name, n).then((bufs) => {
      let peak = 0, sum = 0, dc = 0, len = 0, edge = 0;
      for (const b of bufs) {
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; dc += d[i]; }
        edge = Math.max(edge, Math.abs(d[0]), Math.abs(d[d.length - 1]));
        len += d.length;
      }
      return { name, peak, rms: Math.sqrt(sum / Math.max(1, len)), dc: dc / Math.max(1, len), edge, cal: CAL[name] || 1, vol: SFX[name].vol };
    });
  }
  /** Promise resolving once every pre-render job has finished. */
  _whenRendered() {
    return Promise.all([...this._jobs.values()].map((j) => j.promise));
  }
}
