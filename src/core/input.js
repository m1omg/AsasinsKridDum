// Keyboard / mouse / gamepad input mapped to game actions.
// Raw DOM events are queued and applied at the start of each fixed simulation
// tick, so "pressed this tick" edges and input buffering are measured in
// simulation seconds and behave identically at any display refresh rate.

export const DEFAULT_BINDINGS = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space', 'Pad0'],
  sprint: ['ShiftLeft', 'ShiftRight', 'Pad7'],
  sneak: ['KeyC', 'Pad10'],
  attack: ['Mouse0', 'Pad2'],
  heavy: ['KeyR', 'Pad3'],
  block: ['Mouse2', 'Pad6'],
  dodge: ['KeyE', 'Pad1'],
  interact: ['KeyF', 'Pad4'],
  cast: ['KeyQ', 'Pad5'],
  sigilNext: ['WheelDown', 'Pad15'],
  sigilPrev: ['WheelUp', 'Pad14'],
  sigil1: ['Digit1'],
  sigil2: ['Digit2'],
  sigil3: ['Digit3'],
  sigil4: ['Digit4'],
  sigil5: ['Digit5'],
  knife: ['KeyG', 'Pad12'],
  tonic: ['KeyH', 'Pad13'],
  sight: ['KeyV', 'Pad8'],
  lock: ['Mouse1', 'KeyZ', 'Pad11'],
  map: ['KeyM', 'Tab'],
  pause: ['Escape', 'KeyP', 'Pad9'],
  lookLeft: ['ArrowLeft'],
  lookRight: ['ArrowRight'],
  lookUp: ['ArrowUp'],
  lookDown: ['ArrowDown'],
};

const PREVENT = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyQ', 'KeyE', 'KeyR', 'KeyG', 'KeyH', 'KeyV', 'KeyZ', 'KeyC', 'KeyM']);

export class Input {
  constructor(target) {
    this.target = target;
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    this.codeToActions = new Map();
    this.rebuildMap();
    this.queue = [];
    this.physical = new Set();
    this.actions = {};
    for (const a of Object.keys(this.bindings)) this.actions[a] = { down: false, pressedTick: -1, pressedAt: -1e9, releasedAt: -1e9, consumedAt: -1e9 };
    this.tickIndex = 0;
    this.time = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.enabled = true;
    this.pad = { lx: 0, ly: 0, rx: 0, ry: 0, connected: false, buttons: new Array(17).fill(false) };
    this.lastDevice = 'kbm';
    this.listeners = [];
    this.anyKeyCallbacks = [];
    this._bind();
  }

  rebuildMap() {
    this.codeToActions.clear();
    for (const [action, codes] of Object.entries(this.bindings)) {
      for (const c of codes) {
        if (!this.codeToActions.has(c)) this.codeToActions.set(c, []);
        this.codeToActions.get(c).push(action);
      }
    }
  }

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.listeners.push([el, type, fn, opts]);
  }

  _bind() {
    const win = window;
    this._on(win, 'keydown', (e) => {
      if (e.repeat) { if (PREVENT.has(e.code) && this.locked) e.preventDefault(); return; }
      this.lastDevice = 'kbm';
      for (const cb of this.anyKeyCallbacks) cb(e.code);
      if (!this.enabled) return;
      if (PREVENT.has(e.code) && (this.locked || this.gameActive)) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
      this._raw(e.code, true);
    });
    this._on(win, 'keyup', (e) => this._raw(e.code, false));
    this._on(this.target, 'mousedown', (e) => {
      this.lastDevice = 'kbm';
      if (!this.enabled) return;
      if (this.gameActive) e.preventDefault();
      this._raw('Mouse' + e.button, true);
    });
    this._on(win, 'mouseup', (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
      this._raw('Mouse' + e.button, false);
    });
    this._on(this.target, 'contextmenu', (e) => e.preventDefault());
    this._on(win, 'mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || this.freeLook) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
    });
    this._on(this.target, 'wheel', (e) => {
      if (!this.enabled || !this.gameActive) return;
      e.preventDefault();
      const code = e.deltaY > 0 ? 'WheelDown' : 'WheelUp';
      this._raw(code, true);
      this._raw(code, false);
    }, { passive: false });
    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    this._on(win, 'blur', () => this.releaseAll());
    this._on(win, 'gamepadconnected', () => { this.pad.connected = true; });
    this._on(win, 'gamepaddisconnected', () => { this.pad.connected = false; });
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.target.requestPointerLock && this.target.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => {
        try { this.target.requestPointerLock(); } catch (_) { /* unsupported */ }
      });
    } catch (_) {
      try { this.target.requestPointerLock(); } catch (__) { /* unsupported */ }
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  _raw(code, down) {
    if (down) {
      if (this.physical.has(code) && !code.startsWith('Wheel')) return;
      this.physical.add(code);
    } else {
      if (!this.physical.has(code) && !code.startsWith('Wheel')) return;
      this.physical.delete(code);
    }
    this.queue.push(code, down);
  }

  releaseAll() {
    for (const code of [...this.physical]) this._raw(code, false);
  }

  /** Called at the start of every fixed simulation tick. */
  tick(simTime) {
    this.tickIndex++;
    this.time = simTime;
    const q = this.queue;
    for (let i = 0; i < q.length; i += 2) {
      const acts = this.codeToActions.get(q[i]);
      if (!acts) continue;
      for (const a of acts) {
        const st = this.actions[a];
        if (q[i + 1]) {
          if (!st.down) { st.pressedTick = this.tickIndex; st.pressedAt = simTime; }
          st.down = true;
        } else {
          // only release when no other bound code is still held
          const still = this.bindings[a].some((c) => this.physical.has(c));
          if (!still) { st.down = false; st.releasedAt = simTime; }
        }
      }
    }
    q.length = 0;
  }

  /** Pressed during the current tick. */
  pressed(a) { return this.actions[a].pressedTick === this.tickIndex; }
  held(a) { return this.actions[a].down; }
  holdTime(a) { const s = this.actions[a]; return s.down ? this.time - s.pressedAt : 0; }
  /** True if pressed within `window` seconds and not consumed since. */
  buffered(a, window = 0.2) {
    const s = this.actions[a];
    return s.pressedAt > s.consumedAt && this.time - s.pressedAt <= window;
  }
  consume(a) { this.actions[a].consumedAt = this.time; }
  releasedSince(a, t) { return this.actions[a].releasedAt >= t; }

  /** Movement vector from keys + left stick, length <= 1. x = right, y = forward. */
  moveVector(out) {
    let x = 0, y = 0;
    const a = this.actions;
    if (a.forward.down) y += 1;
    if (a.back.down) y -= 1;
    if (a.right.down) x += 1;
    if (a.left.down) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    if (this.pad.connected) {
      const lx = this.pad.lx, ly = -this.pad.ly;
      if (Math.hypot(lx, ly) > Math.hypot(x, y)) { x = lx; y = ly; }
    }
    out.x = x; out.y = y;
    return out;
  }

  /** Take accumulated mouse delta (pixels). */
  takeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  /** Poll gamepad once per rendered frame; buttons become queued raw events. */
  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) { this.pad.connected = false; this.pad.lx = this.pad.ly = this.pad.rx = this.pad.ry = 0; return; }
    this.pad.connected = true;
    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    const stick = (x, y) => {
      const m = Math.hypot(x, y);
      if (m < 0.18) return [0, 0];
      const k = Math.min(1, (m - 0.18) / 0.82) / m;
      return [x * k, y * k];
    };
    [this.pad.lx, this.pad.ly] = stick(gp.axes[0] || 0, gp.axes[1] || 0);
    this.pad.rx = dz(gp.axes[2] || 0);
    this.pad.ry = dz(gp.axes[3] || 0);
    let active = Math.abs(this.pad.lx) + Math.abs(this.pad.ly) + Math.abs(this.pad.rx) + Math.abs(this.pad.ry) > 0;
    for (let i = 0; i < gp.buttons.length && i < 17; i++) {
      const b = gp.buttons[i];
      const pressed = typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
      if (pressed !== this.pad.buttons[i]) {
        this.pad.buttons[i] = pressed;
        if (pressed) { active = true; for (const cb of this.anyKeyCallbacks) cb('Pad' + i); }
        if (this.enabled) this._raw('Pad' + i, pressed);
      }
    }
    if (active) this.lastDevice = 'pad';
  }
}
