// Fixed-timestep simulation with interpolated rendering.
// Game logic always advances in FIXED_DT steps regardless of display refresh
// rate (30 / 60 / 144 / 240 Hz all simulate identically); rendering receives
// the interpolation factor alpha in [0,1) between the last two sim states.

export const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.25;
const MAX_STEPS = 10;

export class Loop {
  constructor({ update, render, pre }) {
    this.update = update;
    this.render = render;
    this.pre = pre;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.paused = false;
    this.timeScale = 1;
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
    if (!this.paused) {
      simDt = dt * this.timeScale;
      this.acc += simDt;
      let steps = 0;
      while (this.acc >= FIXED_DT) {
        this.simTime += FIXED_DT;
        this.update(FIXED_DT, this.simTime);
        this.acc -= FIXED_DT;
        if (++steps >= MAX_STEPS) { this.acc = 0; break; }
      }
    }
    const alpha = this.paused ? 1 : this.acc / FIXED_DT;
    this.render(dt, simDt, alpha);
  }
}
