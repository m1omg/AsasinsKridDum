// Fixed-timestep simulation with interpolated rendering.
// Game logic always advances in FIXED_DT steps regardless of display refresh
// rate (30 / 60 / 144 / 240 Hz all simulate identically); rendering receives
// the interpolation factor alpha in [0,1) between the last two sim states.
//
// Each frame's wall-clock interval is integrated exactly, step by step:
// every step knows the real moment it stands for (so input events land on the
// step in which they happened), and hit-stop / slow motion are real-time
// deadlines that take effect from the exact step that triggered them, not
// from the next rendered frame.

export const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.25;
const MAX_STEPS = 10;
const HIT_STOP_SCALE = 0.06;

export class Loop {
  constructor({ update, render, pre }) {
    this.update = update;
    this.render = render;
    this.pre = pre;
    this.acc = 0; // sim seconds accumulated toward the next step
    this.last = 0;
    this.running = false;
    this.paused = false;
    this.timeScale = 1; // base speed
    this.fx = { stopUntil: -Infinity, slowUntil: -Infinity, slowScale: 1 }; // real-time deadlines (ms)
    this.stepNow = undefined; // real time of the step being simulated
    this.simTime = 0;
    this.realTime = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._frame = this._frame.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this._frame);
  }

  /** Real time "now" from the simulation's point of view (ms, performance.now clock). */
  now() { return this.stepNow ?? this.last; }

  /** Nearly freeze the simulation for `dur` real seconds. */
  hitStop(dur) {
    this.fx.stopUntil = Math.max(this.fx.stopUntil, this.now() + dur * 1000);
  }

  /** Run the simulation at `scale` speed for `dur` real seconds. */
  slowMo(scale, dur) {
    const f = this.fx;
    f.slowUntil = Math.max(f.slowUntil, this.now() + dur * 1000);
    f.slowScale = scale;
  }

  clearEffects() {
    this.fx.stopUntil = this.fx.slowUntil = -Infinity;
  }

  /** Simulation speed at real time t, and the real time at which it next changes. */
  _scaleAt(t) {
    const f = this.fx;
    if (t < f.stopUntil) return [this.timeScale * HIT_STOP_SCALE, f.stopUntil];
    if (t < f.slowUntil) return [this.timeScale * f.slowScale, f.slowUntil];
    return [this.timeScale, Infinity];
  }

  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    this.realTime += dt;

    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    if (this.pre) this.pre(dt);
    let simDt = 0;
    if (!this.paused && dt > 0) {
      // walk the frame's real interval, running a step whenever a full FIXED_DT
      // of sim time has accumulated at the speed in force at that moment
      let t = now - dt * 1000;
      let steps = 0;
      while (t < now) {
        const [scale, change] = this._scaleAt(t);
        const segEnd = Math.min(now, change);
        if (!(scale > 0)) { t = segEnd; continue; }
        const need = ((FIXED_DT - this.acc) / scale) * 1000; // real ms until the next step
        if (t + need <= segEnd) {
          t += need;
          simDt += FIXED_DT - this.acc;
          this.acc = 0;
          this.simTime += FIXED_DT;
          this.stepNow = t;
          this.update(FIXED_DT, this.simTime, t);
          // too far behind (very slow device): drop the rest of this frame
          if (++steps >= MAX_STEPS) break;
        } else {
          const add = ((segEnd - t) / 1000) * scale;
          this.acc += add;
          simDt += add;
          t = segEnd;
        }
      }
      this.stepNow = undefined;
    }
    const alpha = this.paused ? 1 : Math.min(this.acc / FIXED_DT, 1);
    this.render(dt, simDt, alpha);
  }
}
