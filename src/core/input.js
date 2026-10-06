// Keyboard / mouse / gamepad input mapped to game actions.
// Raw DOM events are queued with their timestamps and applied at the start of
// the first fixed simulation tick at or after the moment they happened, so
// "pressed this tick" edges, parry timing and input buffering are measured in
// simulation seconds and behave identically at any display refresh rate.
//
// Every action is remappable: it has two keyboard/mouse slots and one gamepad
// slot. A code can belong to only one action. Escape always pauses and can't
// be bound, since it also cancels remapping and releases the mouse.

/** Event time on the performance.now() clock (falls back if a browser reports another clock). */
function stamp(e) {
  const now = performance.now();
  const t = e && e.timeStamp;
  return t > 0 && Math.abs(now - t) < 1000 ? Math.min(t, now) : now;
}

/** Default bindings: [key or mouse, second key or mouse, gamepad button]. */
export const DEFAULT_SLOTS = {
  forward: ['KeyW', 'ArrowUp', null],
  back: ['KeyS', 'ArrowDown', null],
  left: ['KeyA', 'ArrowLeft', null],
  right: ['KeyD', 'ArrowRight', null],
  sprint: ['ShiftLeft', 'ShiftRight', 'Pad7'],
  jump: ['Space', null, 'Pad0'],
  sneak: ['KeyC', null, 'Pad10'],
  attack: ['Mouse0', null, 'Pad2'],
  heavy: ['KeyR', null, 'Pad3'],
  block: ['Mouse2', null, 'Pad6'],
  dodge: ['KeyE', null, 'Pad1'],
  lock: ['Mouse1', 'KeyZ', 'Pad11'],
  interact: ['KeyF', null, 'Pad4'],
  sight: ['KeyV', null, 'Pad8'],
  cast: ['KeyQ', null, 'Pad5'],
  sigilNext: ['WheelDown', null, 'Pad15'],
  sigilPrev: ['WheelUp', null, 'Pad14'],
  sigil1: ['Digit1', null, null],
  sigil2: ['Digit2', null, null],
  sigil3: ['Digit3', null, null],
  sigil4: ['Digit4', null, null],
  sigil5: ['Digit5', null, null],
  knife: ['KeyG', null, 'Pad12'],
  tonic: ['KeyH', null, 'Pad13'],
  lookLeft: ['KeyJ', 'Numpad4', null],
  lookRight: ['KeyL', 'Numpad6', null],
  lookUp: ['KeyI', 'Numpad8', null],
  lookDown: ['KeyK', 'Numpad2', null],
  map: ['KeyM', 'Tab', null],
  pause: ['KeyP', null, 'Pad9'],
};

/** Bindings that always work and can't be changed. */
const FIXED = { pause: ['Escape'] };
/** Codes that can't be bound: Escape cancels remapping; the rest belong to the OS or browser. */
export const RESERVED = new Set(['Escape', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'F11', 'F12', 'Unidentified', '']);
export const PAD_SLOT = 2;
export const isPadCode = (c) => /^Pad\d+$/.test(c);

// keys whose default action would scroll the page or move focus
const PREVENT = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const NAMES = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Num Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', CapsLock: 'Caps Lock', Escape: 'Esc', ContextMenu: 'Menu key',
  PrintScreen: 'Print Screen', ScrollLock: 'Scroll Lock', Pause: 'Pause', NumLock: 'Num Lock',
  ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left Win/Cmd', MetaRight: 'Right Win/Cmd',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEqual: 'Num =',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\', IntlRo: 'Ro', IntlYen: 'Yen',
  Mouse0: 'Left mouse', Mouse1: 'Middle mouse', Mouse2: 'Right mouse', Mouse3: 'Mouse back', Mouse4: 'Mouse forward',
  WheelUp: 'Wheel up', WheelDown: 'Wheel down',
  Pad0: 'A', Pad1: 'B', Pad2: 'X', Pad3: 'Y', Pad4: 'LB', Pad5: 'RB', Pad6: 'LT', Pad7: 'RT', Pad8: 'View', Pad9: 'Menu',
  Pad10: 'L3', Pad11: 'R3', Pad12: 'D-pad up', Pad13: 'D-pad down', Pad14: 'D-pad left', Pad15: 'D-pad right', Pad16: 'Guide',
};
// compact forms for small HUD badges
const SHORT = {
  ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192', ShiftLeft: 'Shift', ShiftRight: 'R Shift',
  ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', AltRight: 'R Alt', Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB',
  Mouse3: 'M4', Mouse4: 'M5', WheelUp: 'Wheel\u2191', WheelDown: 'Wheel\u2193', PageUp: 'PgUp', PageDown: 'PgDn',
  Backspace: 'Bksp', Delete: 'Del', Insert: 'Ins', CapsLock: 'Caps', NumpadEnter: 'NumEnt',
  Pad12: 'D\u2191', Pad13: 'D\u2193', Pad14: 'D\u2190', Pad15: 'D\u2192',
};

/** Human-readable name of a key / mouse / gamepad code. `layout` is an optional KeyboardLayoutMap. */
export function keyLabel(code, short = false, layout = null) {
  if (!code) return '';
  if (short && SHORT[code]) return SHORT[code];
  if (/^Key[A-Z]$/.test(code) || (NAMES[code] && NAMES[code].length === 1)) {
    const k = layout && layout.get(code);
    if (k && k.trim()) return k.toUpperCase();
    return code.startsWith('Key') ? code.slice(3) : NAMES[code];
  }
  if (NAMES[code]) return NAMES[code];
  let m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return short ? 'Num' + m[1] : 'Num ' + m[1];
  m = /^Mouse(\d+)$/.exec(code);
  if (m) return 'Mouse ' + (Number(m[1]) + 1);
  m = /^Pad(\d+)$/.exec(code);
  if (m) return 'Button ' + m[1];
  return code;
}

function copySlots(src) {
  const out = {};
  for (const a of Object.keys(DEFAULT_SLOTS)) out[a] = [...src[a]];
  return out;
}

export class Input {
  constructor(target) {
    this.target = target;
    this.slots = copySlots(DEFAULT_SLOTS);
    this.bindings = {}; // action -> every code that triggers it (slots + fixed)
    this.codeToActions = new Map();
    this.boundKeys = new Set();
    this.rebuildMap();
    this.queue = []; // flat triples: code, down, time (ms, performance.now clock)
    this.physical = new Set(); // keys held right now
    this.logical = new Set(); // keys held as of the last simulated tick
    this.actions = {};
    for (const a of Object.keys(DEFAULT_SLOTS)) this.actions[a] = { down: false, pressedTick: -1, pressedAt: -1e9, releasedAt: -1e9, consumedAt: -1e9 };
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
    this.toggles = new Set(); // actions that one press switches on and the next press switches off
    this.capture = null; // fn(code) while the Controls screen waits for a new binding
    this._swallow = null;
    this.layout = null; // KeyboardLayoutMap when the browser shares it (labels match the user's layout)
    this.onLabelsChanged = null;
    try {
      navigator.keyboard?.getLayoutMap?.().then((m) => { this.layout = m; this.onLabelsChanged?.(); }, () => {});
    } catch (_) { /* not available */ }
    this._bind();
  }

  rebuildMap() {
    this.codeToActions.clear();
    this.boundKeys.clear();
    for (const action of Object.keys(DEFAULT_SLOTS)) {
      const codes = [...this.slots[action].filter(Boolean), ...(FIXED[action] || [])];
      this.bindings[action] = codes;
      for (const c of codes) {
        if (!this.codeToActions.has(c)) this.codeToActions.set(c, []);
        this.codeToActions.get(c).push(action);
        if (!c.startsWith('Mouse') && !c.startsWith('Wheel') && !isPadCode(c)) this.boundKeys.add(c);
      }
    }
  }

  // ------------------------------------------------------------ remapping
  /** Load saved bindings, falling back to defaults for anything missing or malformed. */
  setSlots(saved) {
    const out = copySlots(DEFAULT_SLOTS);
    if (saved && typeof saved === 'object') {
      for (const a of Object.keys(DEFAULT_SLOTS)) {
        const s = saved[a];
        const ok = Array.isArray(s) && s.length === 3 && s.every((c, i) => c === null
          || (typeof c === 'string' && c.length < 40 && !RESERVED.has(c) && (i === PAD_SLOT) === isPadCode(c)));
        if (ok) out[a] = [...s];
      }
      // a code drives only one action; drop duplicates from a damaged save
      const seen = new Set();
      for (const a of Object.keys(out)) {
        for (let i = 0; i < 3; i++) {
          const c = out[a][i];
          if (!c) continue;
          if (seen.has(c)) out[a][i] = null; else seen.add(c);
        }
      }
    }
    this.slots = out;
    this.rebuildMap();
  }

  exportSlots() { return copySlots(this.slots); }

  resetSlots() { this.setSlots(null); this.releaseAll(); }

  /** Bind `code` to `action` in `slot`; returns where it was taken from, if anywhere else. */
  assign(action, slot, code) {
    let from = null;
    for (const a of Object.keys(this.slots)) {
      const s = this.slots[a];
      for (let i = 0; i < 3; i++) {
        if (s[i] === code && !(a === action && i === slot)) { s[i] = null; if (a !== action) from = { action: a, slot: i }; }
      }
    }
    this.slots[action][slot] = code;
    this.rebuildMap();
    this.releaseAll();
    return from;
  }

  clearSlot(action, slot) {
    this.slots[action][slot] = null;
    this.rebuildMap();
    this.releaseAll();
  }

  // ------------------------------------------------------------ hold / toggle
  /** Make `action` a toggle (press on, press again off) or a normal hold action. */
  setToggle(action, on) {
    if (on) { this.toggles.add(action); return; }
    this.toggles.delete(action);
    // leaving toggle mode: drop a latched state unless a key is really held
    const st = this.actions[action];
    if (st.down && !this.keyHeld(action)) { st.down = false; st.releasedAt = this.time; }
  }

  isToggle(action) { return this.toggles.has(action); }

  /** Switch a toggled-on action off (e.g. sprint when the player stops). */
  unlatch(action) {
    const st = this.actions[action];
    if (this.toggles.has(action) && st.down) { st.down = false; st.releasedAt = this.time; }
  }

  clearLatches() { for (const a of this.toggles) this.unlatch(a); }

  /** True while a key bound to `action` is physically down (ignores toggle state). */
  keyHeld(action) { return this.bindings[action].some((c) => this.logical.has(c)); }

  /** Name of the key that triggers `action` on `device` ('kbm' or 'pad'); '' when nothing is bound. */
  label(action, device = this.lastDevice, short = false) {
    const s = this.slots[action];
    if (!s) return '';
    let code = device === 'pad' ? s[PAD_SLOT] : (s[0] || s[1]);
    if (!code && FIXED[action] && device !== 'pad') code = FIXED[action][0];
    return keyLabel(code, short, this.layout);
  }

  _on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    this.listeners.push([el, type, fn, opts]);
  }

  _bind() {
    const win = window;
    const blocks = (code) => PREVENT.has(code) || this.boundKeys.has(code);
    this._on(win, 'keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) this.capture(e.code || 'Unidentified');
        return;
      }
      if (e.repeat) { if (blocks(e.code) && (this.locked || this.gameActive)) e.preventDefault(); return; }
      if (this.lastDevice !== 'kbm') { this.lastDevice = 'kbm'; this.onLabelsChanged?.(); }
      // a press the menus act on (resume, close the map, select) is not also fed to gameplay
      let used = false;
      for (const cb of this.anyKeyCallbacks) if (cb(e.code)) used = true;
      if (!this.enabled) return;
      if (blocks(e.code) && (this.locked || this.gameActive)) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
      if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && e.target instanceof HTMLButtonElement) e.preventDefault();
      if (!used) this._raw(e.code, true, stamp(e));
    });
    this._on(win, 'keyup', (e) => this._raw(e.code, false, stamp(e)));
    this._on(this.target, 'mousedown', (e) => {
      if (this.lastDevice !== 'kbm') { this.lastDevice = 'kbm'; this.onLabelsChanged?.(); }
      if (!this.enabled) return;
      if (this.gameActive) e.preventDefault();
      this._raw('Mouse' + e.button, true, stamp(e));
    });
    this._on(win, 'mouseup', (e) => {
      if (e.button === 3 || e.button === 4) e.preventDefault();
      this._raw('Mouse' + e.button, false, stamp(e));
    });
    this._on(this.target, 'contextmenu', (e) => e.preventDefault());
    // remapping: the next mouse button or wheel notch anywhere on the page becomes the binding,
    // and the click / context menu that follows it is swallowed
    this._on(win, 'mousedown', (e) => {
      if (!this.capture) { this._swallow = null; return; }
      e.preventDefault();
      e.stopPropagation();
      this._swallow = { button: e.button, until: Infinity };
      this.capture('Mouse' + e.button);
    }, true);
    this._on(win, 'mouseup', (e) => {
      const sw = this._swallow;
      if (sw && sw.button === e.button && sw.until === Infinity) sw.until = performance.now() + 150;
    }, true);
    for (const type of ['click', 'auxclick', 'contextmenu']) {
      this._on(win, type, (e) => {
        const sw = this._swallow;
        if (sw && performance.now() >= sw.until) this._swallow = null;
        if (this.capture || this._swallow) { e.preventDefault(); e.stopPropagation(); }
      }, true);
    }
    this._on(win, 'wheel', (e) => {
      if (!this.capture || !e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      this.capture(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    }, { capture: true, passive: false });
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
      const t = stamp(e);
      this._raw(code, true, t);
      this._raw(code, false, t);
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

  _raw(code, down, time = performance.now()) {
    if (down) {
      if (this.physical.has(code) && !code.startsWith('Wheel')) return;
      this.physical.add(code);
    } else {
      if (!this.physical.has(code) && !code.startsWith('Wheel')) return;
      this.physical.delete(code);
    }
    this.queue.push(code, down, time);
  }

  releaseAll() {
    for (const code of [...this.physical]) this._raw(code, false);
  }

  /**
   * Called at the start of every fixed simulation tick. `realTime` is the
   * wall-clock moment (performance.now ms) the tick stands for; events that
   * happened later stay queued for a later tick. Omit it to apply everything.
   */
  tick(simTime, realTime = Infinity) {
    this.tickIndex++;
    this.time = simTime;
    const q = this.queue;
    let i = 0;
    for (; i < q.length; i += 3) {
      if (q[i + 2] > realTime) break;
      const code = q[i], down = q[i + 1];
      if (down) this.logical.add(code); else this.logical.delete(code);
      const acts = this.codeToActions.get(code);
      if (!acts) continue;
      for (const a of acts) {
        const st = this.actions[a];
        if (this.toggles.has(a)) {
          // toggle: each press flips it; letting go of the key changes nothing
          if (!down) continue;
          if (!st.down) { st.down = true; st.pressedTick = this.tickIndex; st.pressedAt = simTime; }
          else { st.down = false; st.releasedAt = simTime; }
        } else if (down) {
          if (!st.down) { st.pressedTick = this.tickIndex; st.pressedAt = simTime; }
          st.down = true;
        } else {
          // only release when no other bound code is still held
          const still = this.bindings[a].some((c) => this.logical.has(c));
          if (!still) { st.down = false; st.releasedAt = simTime; }
        }
      }
    }
    if (i >= q.length) q.length = 0;
    else if (i > 0) q.splice(0, i);
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
    // when the pad state changed (its own clock is performance.now); fall back to the previous poll
    const now = performance.now();
    const ts = gp.timestamp;
    const when = ts > 0 && ts <= now && now - ts < 1000 ? ts : (this._lastPoll ?? now);
    this._lastPoll = now;
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
    // only a remap box that was already waiting takes a button: the press that opens one isn't captured
    const capture = this.capture;
    for (let i = 0; i < gp.buttons.length && i < 17; i++) {
      const b = gp.buttons[i];
      const pressed = typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
      if (pressed !== this.pad.buttons[i]) {
        this.pad.buttons[i] = pressed;
        if (pressed && capture) { active = true; if (this.capture === capture) this.capture('Pad' + i); continue; }
        let used = false;
        if (pressed) { active = true; for (const cb of this.anyKeyCallbacks) if (cb('Pad' + i)) used = true; }
        if (this.enabled && !used) this._raw('Pad' + i, pressed, when);
      }
    }
    if (active && this.lastDevice !== 'pad') { this.lastDevice = 'pad'; this.onLabelsChanged?.(); }
  }
}
