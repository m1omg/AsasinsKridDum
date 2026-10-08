import { TOUCH, stamp } from '../core/input.js';
import { SIGILS } from '../entities/playerCombat.js';
import { clamp } from '../core/math.js';
import { ICONS } from './ui.js';

// On-screen controls for phones and tablets: a floating stick under the left
// thumb, drag-to-look on the rest of the screen and a cluster of buttons on
// the right. Everything goes through the Input queue with event timestamps
// (buttons as 'Touch:<action>' codes, the stick as timestamped positions), so
// the simulation sees touch exactly as it sees keys: tick by tick, at any
// display refresh rate. Parts of the HUD become controls too: the emblem
// pauses, a sigil icon chooses that sigil, the minimap opens the map and the
// interaction prompt performs it.
//
// Mode 'auto' shows the controls on touch screens and after any touch, and
// hides them again when a key, the mouse or a gamepad is used.

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  attack: svg('<path d="M19.5 4.5L8.5 15.5" stroke-width="2.6"/><path d="M19.5 4.5l-3.2.6 2.6 2.6z" fill="currentColor"/><path d="M5.5 12.5l6 6"/><path d="M7.6 16.4L4 20"/>'),
  heavy: svg('<path d="M17.5 6.5L8 16" stroke-width="3"/><path d="M5 13l6 6"/><path d="M6.8 17.2L3.5 20.5"/><path d="M14 2.5v2.2M19.5 9.5h2.2M18.6 3.8l1.6-1.6"/>'),
  jump: svg('<path d="M12 20V7"/><path d="M6.5 11.5L12 6l5.5 5.5"/><path d="M7 3.5h10"/>'),
  dodge: svg('<path d="M13 6l6 6-6 6"/><path d="M3 12h15"/><path d="M4 7.5h5M4 16.5h5"/>'),
  block: svg('<path d="M12 3l7.5 3v5.5c0 4.6-3.3 8-7.5 9.5-4.2-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M12 7v10" stroke-width="1.4"/>'),
  interact: svg('<path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5.5"/><path d="M11.5 11V4.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14.5 11V6.2a1.5 1.5 0 0 1 3 0v7.3c0 4.2-2.6 7.5-6.3 7.5-2.4 0-3.9-1.2-5.2-3.2L3.7 14a1.5 1.5 0 0 1 2.5-1.7l2.3 2.7"/>'),
  lock: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  sprint: svg('<path d="M4.5 6l6 6-6 6"/><path d="M12.5 6l6 6-6 6"/>'),
  sneak: svg('<ellipse cx="8.5" cy="9" rx="2.6" ry="3.8" fill="currentColor" stroke="none"/><ellipse cx="15.5" cy="15" rx="2.6" ry="3.8" fill="currentColor" stroke="none"/><path d="M7 14.3h3M14 20.3h3" stroke-width="2.4"/>'),
  sight: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
};

// [id = the action it presses while held, caption]
const BUTTONS = [
  ['attack', 'Attack'], ['heavy', 'Heavy'], ['jump', 'Jump'], ['dodge', 'Dodge'], ['block', 'Block'], ['interact', 'Interact'],
  ['cast', 'Sigil'], ['crossbow', 'Crossbow'], ['lock', 'Lock'], ['sprint', 'Sprint'], ['sneak', 'Sneak'], ['tonic', 'Tonic'], ['sight', 'Sight'],
];

// Right thumb: buttons around the attack button, [angle in degrees counter-clockwise from the
// right, distance, diameter] in layout pixels (scaled with the screen).
const CLUSTER = {
  land: {
    attack: [0, 0, 88],
    jump: [203, 108, 64], dodge: [158, 108, 60], block: [113, 108, 60], interact: [68, 108, 62],
    heavy: [184, 194, 54], cast: [158, 194, 54], crossbow: [132, 194, 54], lock: [106, 194, 50],
  },
  port: {
    attack: [0, 0, 84],
    jump: [200, 100, 62], dodge: [154, 100, 58], block: [108, 100, 58], interact: [62, 100, 60],
    heavy: [148, 182, 52], cast: [124, 182, 52], crossbow: [100, 182, 52], lock: [76, 182, 48],
  },
};
// Left thumb: buttons in an arc above where the stick rests, same format.
const LEFT = {
  land: { sneak: [104, 126, 52], sprint: [62, 124, 58], tonic: [22, 128, 52] },
  port: { sneak: [128, 124, 52], sprint: [90, 124, 58], tonic: [52, 126, 52] },
};

const DEAD_ZONE = 0.12;
const FULL_AT = 0.85; // stick deflection that already counts as full speed

/** A touch screen is the main way to point (phones, tablets). */
export function touchFirst() {
  try { return matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch (_) { return false; }
}

/** The device has a touch screen at all. */
export function touchCapable() {
  return (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
}

/** The page can go full screen here (not on iPhones, nor in frames that don't allow it). */
export function fullscreenAvailable() {
  return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
}

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

export function toggleFullscreen() {
  const d = document, el = d.documentElement;
  try {
    if (isFullscreen()) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else {
      const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
      // phones: stay in landscape while full screen (where the browser allows it)
      if (p && p.then) p.then(() => screen.orientation?.lock?.('landscape').catch(() => {}), () => {});
    }
  } catch (_) { /* not allowed here */ }
}

export class TouchControls {
  constructor(game, uiRoot) {
    this.game = game;
    this.input = game.input;
    this.uiRoot = uiRoot;
    this.mode = 'auto';
    this.auto = null; // in auto mode: true after a touch, false after a key / mouse / gamepad
    this.active = false;
    this.size = 1;
    this.shown = false;
    this.cache = {};
    this.buttons = {};
    this.held = new Map(); // pointerId -> button id
    this.look = new Map(); // pointerId -> { x, y }
    this.stickId = null;
    this.stick = { bx: 0, by: 0, kx: 0, ky: 0, restX: 0, restY: 0, r: 58 };
    this.zoneRect = { left: 0, top: 0, right: 0, bottom: 0 };
    this.build();
    this.bind();
    this.layout();
  }

  // ------------------------------------------------------------ DOM
  build() {
    const hud = this.uiRoot.querySelector('#hud');
    this.lookEl = document.createElement('div');
    this.lookEl.id = 'touch-look';
    hud.before(this.lookEl);
    const root = document.createElement('div');
    root.id = 'touch';
    const icon = (id) => (id === 'cast' ? '<i class="ic"></i>' : id === 'crossbow' || id === 'tonic' ? ICONS[id] : ICON[id]);
    root.innerHTML = '<div class="stick-zone"></div><div class="stick"><div class="knob"></div></div>'
      + BUTTONS.map(([id, cap]) => `<div class="tb tb-${id}" data-b="${id}" role="button" aria-label="${cap}">${icon(id)}<span class="cap">${cap}</span>`
        + `${id === 'crossbow' || id === 'tonic' ? '<span class="cnt"></span>' : ''}${id === 'interact' ? '<span class="bubble"></span>' : ''}</div>`).join('')
      + '<div class="safe-probe"></div>';
    hud.after(root);
    this.root = root;
    this.zone = root.querySelector('.stick-zone');
    this.stickEl = root.querySelector('.stick');
    this.knob = root.querySelector('.knob');
    for (const b of root.querySelectorAll('.tb')) this.buttons[b.dataset.b] = b;
    this.castIcon = this.buttons.cast.querySelector('.ic');
    this.bubble = this.buttons.interact.querySelector('.bubble');
    this.boltsN = this.buttons.crossbow.querySelector('.cnt');
    this.tonicsN = this.buttons.tonic.querySelector('.cnt');
    this.probe = root.querySelector('.safe-probe');
  }

  bind() {
    const input = this.input;
    // any touch switches to the touch controls (auto mode); keys, the mouse and gamepads switch back
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        if (this.mode === 'auto') { this.auto = true; this.setActive(true); }
        if (this.active) input.setDevice('touch');
        // a touch that lands on the game canvas mustn't also arrive as a mouse click (an attack)
        if (e.target === this.game.canvas) e.preventDefault();
      } else if (e.pointerType === 'mouse' && this.mode === 'auto' && this.active) {
        input.setDevice('kbm');
      }
    }, { capture: true, passive: false });
    // browsers start audio only from a completed touch
    window.addEventListener('pointerup', () => this.game.audio?.unlock(), { capture: true });
    window.addEventListener('resize', () => this.layout());
    window.visualViewport?.addEventListener('resize', () => this.layout());
    window.addEventListener('blur', () => this.release());

    const own = (el, e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
      input.setDevice('touch');
    };
    // buttons: the action is held while any finger is on the button
    for (const [id, b] of Object.entries(this.buttons)) {
      b.addEventListener('pointerdown', (e) => {
        own(b, e);
        if (this.held.has(e.pointerId)) return;
        this.held.set(e.pointerId, id);
        b.classList.add('down');
        if (this.count(id) === 1) input._raw(TOUCH + id, true, stamp(e));
      });
      const up = (e) => {
        if (this.held.get(e.pointerId) !== id) return;
        this.held.delete(e.pointerId);
        if (this.count(id) > 0) return;
        b.classList.remove('down');
        input._raw(TOUCH + id, false, stamp(e));
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('lostpointercapture', up);
    }
    // stick: appears under the thumb anywhere in its zone
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      own(z, e);
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      const s = this.stick, zr = this.zoneRect, m = s.r * 0.6;
      s.bx = clamp(e.clientX, zr.left + m, Math.max(zr.left + m, zr.right - m));
      s.by = clamp(e.clientY, zr.top + m, Math.max(zr.top + m, zr.bottom - m));
      this.stickEl.classList.add('on');
      this.moveStick(e);
    });
    z.addEventListener('pointermove', (e) => { if (e.pointerId === this.stickId) this.moveStick(e); });
    const stickUp = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.resetStick(stamp(e));
    };
    z.addEventListener('pointerup', stickUp);
    z.addEventListener('pointercancel', stickUp);
    z.addEventListener('lostpointercapture', stickUp);
    // look: drag anywhere else
    const L = this.lookEl;
    L.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && this.mode === 'auto') return; // the mouse is taking over
      own(L, e);
      this.look.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    L.addEventListener('pointermove', (e) => {
      const p = this.look.get(e.pointerId);
      if (!p) return;
      const s = this.game.settings;
      // dragging across half the screen's width turns the camera half a circle (at look speed 1)
      const k = ((2 * Math.PI) / Math.max(320, window.innerWidth)) * (s.touchSens || 1) / (0.0022 * (s.sens || 1));
      input.addLook((e.clientX - p.x) * k, (e.clientY - p.y) * k * 0.8);
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const lookUp = (e) => this.look.delete(e.pointerId);
    L.addEventListener('pointerup', lookUp);
    L.addEventListener('pointercancel', lookUp);
    L.addEventListener('lostpointercapture', lookUp);
    // HUD pieces that become controls
    const ui = this.game.ui;
    ui.h.sigils.forEach((el, i) => this.hudButton(el, `sigil${i + 1}`));
    this.hudButton(ui.h.prompt, 'interact');
    // the emblem pauses; on phones it does even with the touch controls switched off, so the menus stay in reach
    this.hudTap(this.uiRoot.querySelector('.medallion'), () => this.game.pause(), true);
    this.hudTap(this.uiRoot.querySelector('.minimap-wrap'), () => this.game.pause('map'));
    this.uiRoot.classList.toggle('tap-pause', touchFirst());
  }

  /** A HUD element that holds `action` while touched (only while the touch controls are on). */
  hudButton(el, action) {
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active || this.game.state !== 'playing' || id !== null) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* gone */ }
      id = e.pointerId;
      el.classList.add('down');
      this.input.setDevice('touch');
      this.input._raw(TOUCH + action, true, stamp(e));
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('down');
      this.input._raw(TOUCH + action, false, stamp(e));
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  /** A HUD element that does `fn` when touched (while the touch controls are on, or always on phones if `phones`). */
  hudTap(el, fn, phones = false) {
    el.addEventListener('pointerdown', (e) => {
      if (!(this.active || (phones && e.pointerType === 'touch' && touchFirst())) || this.game.state !== 'playing') return;
      e.preventDefault();
      this.input.setDevice('touch');
      fn();
    });
  }

  count(id) {
    let n = 0;
    for (const v of this.held.values()) if (v === id) n++;
    return n;
  }

  moveStick(e) {
    const s = this.stick, r = s.r;
    let dx = e.clientX - s.bx, dy = e.clientY - s.by;
    const d = Math.hypot(dx, dy);
    // past the rim the base follows the thumb, so the stick never runs out of travel
    if (d > r) {
      s.bx += dx * (1 - r / d);
      s.by += dy * (1 - r / d);
      dx *= r / d;
      dy *= r / d;
    }
    s.kx = dx; s.ky = dy;
    this.drawStick();
    const m = Math.min(1, Math.hypot(dx, dy) / r);
    const out = m < DEAD_ZONE ? 0 : Math.min(1, (m - DEAD_ZONE) / (FULL_AT - DEAD_ZONE));
    const len = Math.hypot(dx, dy) || 1;
    this.input.setStick((dx / len) * out, (-dy / len) * out, stamp(e));
  }

  resetStick(time) {
    const s = this.stick;
    s.bx = s.restX; s.by = s.restY; s.kx = 0; s.ky = 0;
    this.stickEl.classList.remove('on');
    this.drawStick();
    this.input.setStick(0, 0, time);
  }

  drawStick() {
    const s = this.stick;
    this.stickEl.style.transform = `translate(${(s.bx - s.r).toFixed(1)}px, ${(s.by - s.r).toFixed(1)}px)`;
    this.knob.style.transform = `translate(${s.kx.toFixed(1)}px, ${s.ky.toFixed(1)}px)`;
  }

  /** Let go of everything (pause, blur, controls hidden). */
  release() {
    const held = [...this.held];
    this.held.clear();
    for (const [pid, id] of held) {
      this.buttons[id].classList.remove('down');
      this.input._raw(TOUCH + id, false);
      try { this.buttons[id].releasePointerCapture(pid); } catch (_) { /* gone */ }
    }
    this.look.clear();
    if (this.stickId !== null) { this.stickId = null; this.resetStick(performance.now()); }
  }

  // ------------------------------------------------------------ mode
  setMode(mode) {
    this.mode = mode === 'on' || mode === 'off' ? mode : 'auto';
    this.setActive(this.mode === 'on' || (this.mode === 'auto' && (this.auto ?? touchFirst())));
  }

  setSize(k) {
    this.size = clamp(Number(k) || 1, 0.7, 1.4);
    this.layout();
  }

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    this.input.touchActive = on;
    this.uiRoot.classList.toggle('touch', on);
    if (on) this.input.setDevice('touch');
    else {
      this.release();
      if (this.input.lastDevice === 'touch') this.input.setDevice('kbm');
    }
    this.game.applyToggles?.();
    this.layout();
  }

  insets() {
    const cs = getComputedStyle(this.probe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  }

  // ------------------------------------------------------------ layout
  layout() {
    if (!this.root) return;
    const W = window.innerWidth, H = window.innerHeight;
    const ins = this.insets();
    const S = Math.min(W, H);
    const portrait = H > W * 1.1;
    const k = (portrait ? clamp(W / 470, 0.7, 1.15) : clamp(S / 400, 0.72, 1.3)) * this.size;
    const root = this.uiRoot.style;
    const px = (v) => `${Math.round(v)}px`;
    const set = (el, x, y, d) => {
      el.style.left = `${x.toFixed(1)}px`;
      el.style.top = `${y.toFixed(1)}px`;
      el.style.setProperty('--d', `${(d * k).toFixed(1)}px`);
    };
    // right thumb: the cluster around the attack button
    const C = portrait ? CLUSTER.port : CLUSTER.land;
    const ax = W - ins.r - 92 * k, ay = H - ins.b - (portrait ? 96 : 88) * k;
    let left = W;
    for (const [id, [a, r, d]] of Object.entries(C)) {
      const t = (a * Math.PI) / 180;
      const x = ax + Math.cos(t) * r * k, y = ay - Math.sin(t) * r * k;
      set(this.buttons[id], x, y, d);
      left = Math.min(left, x - (d * k) / 2);
    }
    // left thumb: the stick rests low on the left, with sprint, sneak and tonic in an arc above it
    const s = this.stick;
    s.r = 58 * k;
    s.restX = ins.l + 118 * k;
    s.restY = H - ins.b - (portrait ? 150 : 112) * k;
    for (const [id, [a, r, d]] of Object.entries(portrait ? LEFT.port : LEFT.land)) {
      const t = (a * Math.PI) / 180;
      set(this.buttons[id], s.restX + Math.cos(t) * r * k, s.restY - Math.sin(t) * r * k, d);
    }
    // top: HUD on the left (scaled), minimap on the right with Sight beside it (under it in portrait)
    const mm = Math.round(clamp(S * (portrait ? 0.27 : 0.26), 84, 150));
    root.setProperty('--mm', px(mm));
    root.setProperty('--hud-k', (portrait ? clamp(W / 600, 0.58, 1) : clamp(S / 520, 0.62, 1)).toFixed(3));
    const sd = 46 * k;
    const sx = portrait ? W - ins.r - 10 - sd / 2 : W - ins.r - 10 - mm - 12 - sd / 2;
    const sy = portrait ? ins.t + 8 + mm + 34 + sd / 2 : ins.t + 8 + sd / 2;
    set(this.buttons.sight, sx, sy, 46);
    const hud = this.uiRoot.querySelector('.hud-tl').getBoundingClientRect();
    // the objective, and hints in its place, go in the gap between the HUD and the top-right corner
    // (landscape) or under the HUD (portrait)
    let ox, oy, ow, hx, hy, hw;
    if (portrait) {
      ox = hx = ins.l + 10;
      oy = hy = hud.bottom + 6;
      ow = hw = W - ins.l - ins.r - mm - 40;
    } else {
      const gl = hud.right + 10, gr = sx - sd / 2 - 10;
      ox = gl; oy = ins.t + 6; ow = gr - gl;
      const want = Math.min(W * 0.46, 440);
      if (ow >= 200) { hx = ox; hy = oy; hw = ow; } else { hw = want; hx = (W - hw) / 2; hy = Math.max(hud.bottom, sy + sd / 2) + 6; }
    }
    root.setProperty('--obj-l', px(ox)); root.setProperty('--obj-t', px(oy)); root.setProperty('--obj-w', px(Math.max(0, ow)));
    root.setProperty('--hint-l', px(hx)); root.setProperty('--hint-t', px(hy)); root.setProperty('--hint-w', px(hw));
    this.uiRoot.classList.toggle('obj-short', !portrait && ow < 200);
    this.uiRoot.classList.toggle('portrait', portrait);
    // stick zone: the lower left below the HUD, up to the cluster (buttons inside it keep their touches)
    const zr = {
      left: ins.l,
      top: Math.max(hud.bottom + 8, Math.min(s.restY - 2 * s.r, H * (portrait ? 0.5 : 0.3))),
      right: Math.max(ins.l + 200 * k, Math.min(W * (portrait ? 0.62 : 0.46), left - 12 * k)),
      bottom: H - ins.b,
    };
    this.zoneRect = zr;
    Object.assign(this.zone.style, { left: px(zr.left), top: px(zr.top), width: px(zr.right - zr.left), height: px(zr.bottom - zr.top) });
    this.stickEl.style.setProperty('--r', `${s.r.toFixed(1)}px`);
    if (this.stickId === null) { s.bx = s.restX; s.by = s.restY; s.kx = 0; s.ky = 0; }
    this.drawStick();
  }

  // ------------------------------------------------------------ per frame
  /** Called every rendered frame: visibility and button states (cheap; writes only on change). */
  update() {
    const g = this.game, input = this.input;
    // auto mode: a key, mouse button or gamepad takes over from touch
    if (this.mode === 'auto' && this.active && (input.lastDevice === 'kbm' || input.lastDevice === 'pad')) {
      this.auto = false;
      this.setActive(false);
    }
    const p = g.player;
    const show = this.active && g.state === 'playing' && !!p;
    if (show !== this.shown) {
      this.shown = show;
      this.root.classList.toggle('on', show);
      this.lookEl.classList.toggle('on', show);
      if (!show) this.release();
    }
    if (!show) return;
    this.cls('root', this.root, 'dead', p.dead);
    const B = this.buttons;
    // something to interact with: the Interact button lights up and says what it will do
    const pr = !p.dead ? p.prompt : null;
    const kind = pr ? pr.kind : '';
    this.cls('interact', B.interact, 'ready', !!pr);
    this.cls('interact', B.interact, 'danger', kind === 'assassinate' || kind === 'airAssassinate' || kind === 'hayAssassinate' || kind === 'ledgeAssassinate');
    this.cls('interact', B.interact, 'glory', kind === 'glory');
    this.text('bubble', this.bubble, pr ? pr.label : '');
    // counts, and what can't be used right now
    this.text('bolts', this.boltsN, String(p.bolts));
    this.cls('crossbow', B.crossbow, 'empty', p.bolts === 0);
    this.text('tonics', this.tonicsN, String(p.tonics));
    this.cls('tonic', B.tonic, 'empty', p.tonics === 0);
    const sg = SIGILS[p.sigil];
    if (this.cache.sigil !== p.sigil) { this.cache.sigil = p.sigil; this.castIcon.innerHTML = ICONS[sg.id]; }
    this.cls('cast', B.cast, 'empty', p.stamina < sg.cost);
    // switched on
    this.cls('sprint', B.sprint, 'on', input.held('sprint'));
    this.cls('sneak', B.sneak, 'on', !!p.sneaking);
    this.cls('sight', B.sight, 'on', !!g.sightOn);
    this.cls('lock', B.lock, 'on', !!(p.lockTarget && !p.lockTarget.dead));
    this.cls('block', B.block, 'on', !!p.blocking);
  }

  /** Toggle a class only when it changes (`key` names the element in the cache). */
  cls(key, el, name, on) {
    const k = key + ':' + name;
    if (this.cache[k] === on) return;
    this.cache[k] = on;
    el.classList.toggle(name, on);
  }

  text(key, el, v) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    el.textContent = v;
  }
}
