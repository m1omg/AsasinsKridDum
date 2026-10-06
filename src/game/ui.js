import * as THREE from 'three';
import { SIGILS } from '../entities/playerCombat.js';
import { TITLE_URL } from '../render/textures.js';
import { clamp } from '../core/math.js';
import { DEFAULT_SLOTS, RESERVED, PAD_SLOT, isPadCode, keyLabel } from '../core/input.js';

// DOM HUD + menus. HUD values update every rendered frame (cheap writes only
// when values change); markers are pooled absolutely-positioned elements.

const ICONS = {
  pyre: '<svg viewBox="0 0 24 24"><path fill="#ff8a3a" d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 3 1 4 2 4 0-4-1-6 1-10z"/></svg>',
  gust: '<svg viewBox="0 0 24 24" fill="none" stroke="#a8d4ff" stroke-width="2.2" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h16a3 3 0 1 1-3 3"/><path d="M3 18h8"/></svg>',
  aegis: '<svg viewBox="0 0 24 24"><path fill="none" stroke="#ffd36a" stroke-width="2.2" d="M12 2l8 4.5v11L12 22l-8-4.5v-11z"/><circle cx="12" cy="12" r="3" fill="#ffd36a"/></svg>',
  snare: '<svg viewBox="0 0 24 24" fill="none" stroke="#c78bff" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 5l6 11H6z"/></svg>',
  hex: '<svg viewBox="0 0 24 24" fill="none" stroke="#7dffb0" stroke-width="2"><path d="M12 4c5 0 8 4 8 8s-3 6-6 6-5-2-5-5 2-4 4-4 3 1 3 3"/></svg>',
  knife: '<svg viewBox="0 0 24 24"><path fill="#dfe6ee" d="M20 3l-9 9 1.5 1.5L21.5 4.5z"/><path fill="#8a6a40" d="M10 12.5l1.5 1.5-5 5-1.5-1.5z"/><path fill="#d8a446" d="M8.5 11l4.5 4.5-1 1L7.5 12z"/></svg>',
  tonic: '<svg viewBox="0 0 24 24"><path fill="#8a1a14" d="M9 9h6l3 8a3 3 0 0 1-3 4H9a3 3 0 0 1-3-4z"/><path fill="#d8c8a8" d="M10 3h4v6h-4z"/><path fill="#ff4a3a" d="M8 14h8l1.4 3.5A2 2 0 0 1 15.5 20h-7a2 2 0 0 1-1.9-2.5z"/></svg>',
};

const EMBLEM = `<svg viewBox="0 0 100 100">
  <defs><radialGradient id="em" cx="50%" cy="45%" r="55%"><stop offset="0" stop-color="#3a1408"/><stop offset="1" stop-color="#0c0503"/></radialGradient>
  <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a8"/><stop offset="0.6" stop-color="#d8a446"/><stop offset="1" stop-color="#7a3a10"/></linearGradient></defs>
  <circle cx="50" cy="50" r="46" fill="url(#em)" stroke="url(#eg)" stroke-width="4"/>
  <circle cx="50" cy="50" r="38" fill="none" stroke="#d8a44655" stroke-width="1.5"/>
  <path d="M50 16 L68 62 Q50 54 32 62 Z" fill="url(#eg)"/>
  <path d="M50 30 L60 58 Q50 53 40 58 Z" fill="#1a0a05"/>
  <path d="M50 40c4 6 4 10 0 14-4-4-4-8 0-14z" fill="#ff5a1a"/>
  <path d="M26 70 Q50 82 74 70" stroke="url(#eg)" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`;

const UPGRADES = [
  { id: 'vitality', name: 'Vitality', desc: '+30 maximum health.', costs: [1, 2, 2] },
  { id: 'blade', name: 'Ashen Blade', desc: '+18% sword damage.', costs: [1, 2, 2] },
  { id: 'vigor', name: 'Vigor', desc: '+30 stamina and faster recovery for Sigils.', costs: [1, 2] },
  { id: 'sigils', name: 'Sigil Mastery', desc: 'Sigils are 30% more potent.', costs: [1, 2] },
  { id: 'quiver', name: 'Bandolier', desc: 'Carry 3 more throwing knives.', costs: [1, 1] },
  { id: 'tonic', name: 'Alchemist', desc: 'Carry one more Blood Tonic.', costs: [1, 2] },
  { id: 'shadow', name: 'Shadow of the Creed', desc: 'Demons notice you 20% slower.', costs: [1, 2] },
];
export { UPGRADES };

// Remappable actions as they appear on the Controls screen.
const ACTION_GROUPS = [
  ['Movement', [
    ['forward', 'Move forward'], ['back', 'Move back'], ['left', 'Move left'], ['right', 'Move right'],
    ['sprint', 'Sprint and free-run'], ['jump', 'Jump, climb and leap; roll in a fight'], ['sneak', 'Sneak'],
  ]],
  ['Combat', [
    ['attack', 'Fast attack'], ['heavy', 'Strong attack (hold for Rend)'], ['block', 'Block, or parry with good timing'],
    ['dodge', 'Dodge'], ['lock', 'Lock on to a demon'],
  ]],
  ['Stealth', [
    ['interact', 'Assassinate, Glory Kill, interact'], ['sight', 'Ashen Sight'],
  ]],
  ['Sigils and items', [
    ['cast', 'Cast Sigil'], ['sigilNext', 'Next Sigil'], ['sigilPrev', 'Previous Sigil'],
    ...SIGILS.map((sg, i) => [`sigil${i + 1}`, `Choose ${sg.name}`]),
    ['knife', 'Throwing knife'], ['tonic', 'Blood Tonic (heal)'],
  ]],
  ['Camera keys', [
    ['lookLeft', 'Turn camera left'], ['lookRight', 'Turn camera right'], ['lookUp', 'Look up'], ['lookDown', 'Look down'],
  ]],
  ['Menus', [
    ['map', 'Map'], ['pause', 'Pause (Esc always pauses too)'],
  ]],
];
const ACTION_NAME = Object.fromEntries(ACTION_GROUPS.flatMap(([, list]) => list));
// hold or toggle, per action: [row name, hold text, toggle text, message when switched to toggle]
const HOLD_MODES = [
  ['sprint', 'Sprint', 'Hold the key to sprint', 'Press once to start sprinting, again to stop',
    'Sprint now toggles: press once to start and again to stop. It also stops when you stop moving or start sneaking.'],
  ['block', 'Block', 'Hold the key to keep your guard up', 'Press once to raise your guard, again to lower it',
    'Block now toggles: press once to raise your guard and again to lower it. Raising it just before a hit still parries. It lowers by itself when no demons are near.'],
  ['sneak', 'Sneak', 'Hold the key to sneak', 'Press once to start sneaking, again to stop',
    'Sneak now toggles: press once to start and again to stop.'],
];
const SLOT_NAMES = ['first key', 'second key', 'gamepad button'];
const CAPTURE_MS = 8000;

// difficulty levels: [name, description]
const DIFF_TEXT = {
  easy: ['Easy', 'Demons hit softly, attack one at a time and give long warnings before they strike. Parrying is forgiving, and they are slow to notice you.'],
  medium: ['Medium', 'Demons attack one at a time with clear warnings and moderate damage. A fair fight. Recommended.'],
  hard: ['Hard', 'Two demons can strike at once, warnings are short and hits hurt. The original challenge.'],
};

const PCT = (v) => `${Math.round(v * 100)}%`;
// Settings rows: choices cycle; numbers step between min and max
const SETTINGS = [
  { k: 'difficulty', label: 'Difficulty', options: [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']] },
  { k: 'sens', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { k: 'invertY', label: 'Invert camera Y', options: [[false, 'Off'], [true, 'On']] },
  { k: 'fov', label: 'Field of view', min: 55, max: 85, step: 5, fmt: (v) => `${Math.round(v)}°` },
  { k: 'master', label: 'Master volume', min: 0, max: 1, step: 0.1, fmt: PCT },
  { k: 'music', label: 'Music volume', min: 0, max: 1, step: 0.1, fmt: PCT },
  { k: 'sfx', label: 'Effects volume', min: 0, max: 1, step: 0.1, fmt: PCT },
  { k: 'quality', label: 'Graphics quality', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { k: 'shake', label: 'Camera shake', options: [[true, 'On'], [false, 'Off']] },
  { k: 'dmgNumbers', label: 'Damage numbers', options: [[true, 'On'], [false, 'Off']] },
  { k: 'fps', label: 'Show FPS', options: [[false, 'Off'], [true, 'On']] },
];

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

export class UI {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.cache = {};
    this.markers = [];
    this.edges = [];
    this.dmgs = [];
    this.notes = [];
    this.screen = null;
    this.focusIdx = 0;
    root.innerHTML = this.template();
    this.$ = (s) => root.querySelector(s);
    this.buildHud();
    this.bindMenus();
    this.embers();
    this.lastMinimap = 0;
  }

  template() {
    const sig = SIGILS.map((s, i) => `<div class="sigil" data-i="${i}">${ICONS[s.id]}<span class="k">${i + 1}</span></div>`).join('');
    return `
<div id="hud">
  <div class="hud-tl">
    <div class="medallion">${EMBLEM}</div>
    <div>
      <div class="bars">
        <div class="bar hp"><div class="lag"></div><div class="fill"></div><div class="armor"></div></div>
        <div class="bar st"><div class="fill"></div></div>
        <div class="fury"><i></i><i></i><i></i></div>
      </div>
      <div class="sigils">${sig}</div>
      <div class="sigil-name"></div>
    </div>
  </div>
  <div class="hud-tr">
    <div class="minimap-wrap"><canvas class="minimap" width="190" height="190"></canvas><div class="minimap-n">N</div></div>
    <div class="status anon">Anonymous</div>
    <div class="objective"><div class="title">Objective</div><div class="text"></div><div class="sub"></div></div>
  </div>
  <div class="hud-br">
    <div class="item knives">${ICONS.knife}<span class="n">5</span><span class="k">G</span></div>
    <div class="item tonics">${ICONS.tonic}<span class="n">3</span><span class="k">H</span></div>
  </div>
  <div class="hint"></div>
  <div class="prompt"><span class="key">F</span><span class="label"></span></div>
  <div class="notify"></div>
  <div class="banner"><div class="big"></div><div class="line"></div><div class="small"></div></div>
  <div class="bossbar"><div class="name"></div><div class="bar"><div class="fill"></div></div></div>
  <div class="markers"></div>
  <div class="waypoint"><svg viewBox="0 0 24 24"><path d="M12 2l7 10-7 10-7-10z" fill="#ffcf6a" stroke="#1a0d07" stroke-width="1.6"/><path d="M12 7l3.5 5L12 17l-3.5-5z" fill="#1a0d07" opacity="0.55"/></svg><span></span></div>
  <div class="wave"></div>
  <div class="vignette-sight"></div>
  <div class="center-dot"></div>
  <div class="fps"></div>
  <div class="lockhint clickable">Click to play<small>Mouse look needs the pointer captured. If nothing happens, open the game in its own tab.</small></div>
</div>

<div class="screen" id="screen-loading"><div class="logo">HELLCREED</div><div class="loadbar"><i></i></div><div class="loadtext">Summoning the city of Vellano…</div></div>

<div class="screen" id="screen-title">
  <div class="art" style="background-image:url('${TITLE_URL}')"></div>
  <div class="shade"></div>
  <div class="embers"></div>
  <div class="content">
    <div><div class="logo">HELLCREED</div><div class="tagline">The Burning of Vellano, 1499</div></div>
    <div class="menu">
      <button class="btn" data-act="continue">Continue</button>
      <button class="btn" data-act="new">New Game</button>
      <button class="btn" data-act="controls">Controls</button>
      <button class="btn" data-act="settings">Settings</button>
    </div>
    <div class="device-note" hidden>Hellcreed needs a keyboard and mouse, or a gamepad. Touch controls aren't supported.</div>
  </div>
  <div class="credit">Textures, sky &amp; key art generated with Higgsfield · Built with Three.js</div>
</div>

<div class="screen dim" id="screen-intro"><div class="panel">
  <h2>Vellano, 1499</h2><div class="sep"></div>
  <p>The sky over Vellano tore open on the Feast of Ashes. From the wound poured the damned: thralls that once were neighbours, imps that crawl the walls, hounds, gazers and brutes, and above the cathedral, their shepherd, the Cardinal of Ash.</p>
  <p>The Brotherhood of the Ashen Creed is all that remains. You are its last blade.</p>
  <p><i>Climb the towers to read the city. Hunt from the rooftops. Close the three Hell Rifts. Then end the Cardinal.</i></p>
  <div class="sep"></div>
  <button class="btn" data-act="begin">Begin</button>
</div></div>

<div class="screen dim" id="screen-pause"><div class="panel" style="text-align:center">
  <h2>Paused</h2><div class="sep"></div>
  <div class="menu" style="margin:0 auto">
    <button class="btn" data-act="resume">Resume</button>
    <button class="btn" data-act="map">Map</button>
    <button class="btn" data-act="upgrades">The Creed (Upgrades)</button>
    <button class="btn" data-act="controls">Controls</button>
    <button class="btn" data-act="settings">Settings</button>
    <button class="btn" data-act="title">Quit to Title</button>
  </div>
</div></div>

<div class="screen dim" id="screen-map"><div class="panel map-wrap">
  <h2>Vellano</h2>
  <canvas id="bigmap" width="720" height="720"></canvas>
  <div class="legend">
    <span><i style="background:#f4cf7a"></i>You</span><span><i style="background:#e8c060"></i>Viewpoint (synced)</span><span><i style="background:#8a7a60"></i>Viewpoint</span>
    <span><i style="background:#ff3a1a"></i>Hell Rift</span><span><i style="background:#c9a040"></i>Chest (revealed)</span><span><i style="background:#ff5a4a"></i>Demons hunting you</span>
  </div>
  <div class="sep"></div><button class="btn small" data-act="back">Back</button>
</div></div>

<div class="screen dim" id="screen-upgrades"><div class="panel" style="width:640px">
  <h2>The Creed</h2>
  <p>Spend <b>Ashen Runes</b> found in chests, at viewpoints, in relic caches and in cleansed rifts.</p>
  <div class="runes"></div>
  <div class="upg-list"></div>
  <div class="sep"></div><button class="btn small" data-act="back">Back</button>
</div></div>

<div class="screen dim" id="screen-controls"><div class="panel controls-panel">
  <div class="bind-head">
    <h2>Controls</h2>
    <p class="bind-help">To change a control, select one of its boxes, then press the key, mouse button or gamepad button you want. Each action takes two keys and one gamepad button. Right-click a box or press <b>Delete</b> to clear it. Changes save automatically.</p>
    <p class="bind-status" role="status" aria-live="polite"></p>
  </div>
  <div class="bind-scroll">
    <div class="binds">${this.bindsTemplate()}</div>
    <h3>How to play</h3>
    <div class="howto"></div>
  </div>
  <div class="bind-foot">
    <p class="bind-note">The mouse and right stick turn the camera; the left stick moves. <b>Esc</b> always pauses.</p>
    <div class="bind-buttons"><button class="btn small" data-act="resetBinds" data-r="${this.bindRows}" data-c="0">Reset to defaults</button><button class="btn small" data-act="back" data-r="${this.bindRows}" data-c="1">Back</button></div>
  </div>
</div></div>

<div class="screen dim" id="screen-difficulty"><div class="panel diff-panel">
  <h2>Choose difficulty</h2>
  <p>You can change it at any time in Settings.</p>
  <div class="sep"></div>
  <div class="diff-list">${['easy', 'medium', 'hard'].map((d) => `<button class="btn diff" data-act="pickDifficulty" data-d="${d}"><span class="dn">${DIFF_TEXT[d][0]}</span><span class="dd">${DIFF_TEXT[d][1]}</span></button>`).join('')}</div>
  <div class="sep"></div><button class="btn small" data-act="back">Back</button>
</div></div>

<div class="screen dim" id="screen-settings"><div class="panel settings-panel">
  <h2>Settings</h2>
  <p class="opt-help">Up and down pick a setting; left and right change it. You can also click the arrows.</p>
  <div class="sep"></div>
  ${SETTINGS.map((o, i) => `<div class="settings-row"><span id="set-${o.k}">${o.label}</span><button class="btn opt" data-act="opt" data-k="${o.k}" data-r="${i}" data-c="0" aria-describedby="set-${o.k}"><span class="arw" data-d="-1" aria-hidden="true">&#9664;</span><span class="v"></span><span class="arw" data-d="1" aria-hidden="true">&#9654;</span></button></div>`).join('')}
  <p class="diff-note"></p>
  <div class="sep"></div><button class="btn small" data-act="back">Back</button>
</div></div>

<div class="screen" id="screen-death"><div class="death-title">SLAIN</div><p>The Creed endures. Rise again…</p><button class="btn" data-act="respawn">Rise</button></div>

<div class="screen dim" id="screen-victory"><div class="panel" style="text-align:center;width:560px">
  <h2>Vellano is Free</h2><div class="sep"></div>
  <p>The Cardinal of Ash is unmade and the wound in the sky closes. Somewhere a bell rings, the first in a year.</p>
  <div class="stats"></div>
  <div class="menu" style="margin:0 auto"><button class="btn" data-act="freeroam">Keep exploring</button><button class="btn" data-act="title">Title screen</button></div>
</div></div>`;
  }

  // ------------------------------------------------------------ remapping
  bindsTemplate() {
    let r = 0;
    let html = '<span class="grp">Hold or toggle</span>';
    for (const [a, name] of HOLD_MODES) {
      html += `<span class="act" id="mode-${a}">${esc(name)}</span><button class="btn mode" data-act="holdMode" data-m="${a}" data-r="${r}" data-c="0" aria-describedby="mode-${a}"></button>`;
      r++;
    }
    html += '<span class="h">Action</span><span class="h">Key</span><span class="h">Second key</span><span class="h">Gamepad</span>';
    for (const [group, list] of ACTION_GROUPS) {
      html += `<span class="grp">${esc(group)}</span>`;
      for (const [a, name] of list) {
        html += `<span class="act" id="bind-${a}">${esc(name)}</span>`;
        for (let i = 0; i < 3; i++) {
          html += `<button class="btn slot" data-act="bind" data-a="${a}" data-s="${i}" data-r="${r}" data-c="${i}" aria-describedby="bind-${a}"></button>`;
        }
        r++;
      }
    }
    this.bindRows = r;
    return html;
  }

  /** Write the current bindings and hold / toggle modes into the Controls screen. */
  refreshBindings() {
    const input = this.game.input;
    const toggles = this.game.settings.toggles;
    for (const b of this.root.querySelectorAll('.btn.mode')) {
      const m = HOLD_MODES.find((x) => x[0] === b.dataset.m);
      const on = !!toggles[m[0]];
      b.innerHTML = on ? `<b>Toggle</b> · ${esc(m[3])}` : `<b>Hold</b> · ${esc(m[2])}`;
      b.setAttribute('aria-label', `${m[1]}: ${on ? 'toggle, ' + m[3] : 'hold, ' + m[2]}. Select to switch.`);
    }
    for (const b of this.root.querySelectorAll('.btn.slot')) {
      if (this.capturing && this.capturing.btn === b) continue;
      const code = input.slots[b.dataset.a][Number(b.dataset.s)];
      const label = code ? keyLabel(code, false, input.layout) : '–';
      b.textContent = label;
      b.classList.toggle('empty', !code);
      b.setAttribute('aria-label', `${ACTION_NAME[b.dataset.a]}, ${SLOT_NAMES[b.dataset.s]}: ${code ? label : 'empty'}`);
    }
    this.renderHowTo();
  }

  setStatus(text, warn = false) {
    const st = this.$('.bind-status');
    st.textContent = text;
    st.classList.toggle('warn', warn);
  }

  startCapture(btn) {
    this.endCapture();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const s = Number(btn.dataset.s);
    this.focusIdx = Math.max(0, this.visibleButtons().indexOf(btn));
    this.updateFocus();
    this.capturing = { a: btn.dataset.a, s, btn };
    btn.classList.add('capturing');
    btn.textContent = 'Press…';
    const name = ACTION_NAME[btn.dataset.a];
    this.setStatus(s === PAD_SLOT
      ? `Press a gamepad button for “${name}”. Esc cancels; after 8 seconds nothing changes.`
      : `Press a key or mouse button for “${name}”. Esc cancels; after 8 seconds nothing changes.`);
    this.game.input.capture = (code) => this.onCapture(code);
    this.armCaptureTimer();
  }

  armCaptureTimer() {
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(() => this.endCapture('Nothing was pressed, so that control is unchanged.'), CAPTURE_MS);
  }

  onCapture(code) {
    const c = this.capturing;
    if (!c) return;
    const input = this.game.input;
    const name = keyLabel(code, false, input.layout);
    if (code === 'Escape') { this.endCapture('Cancelled. Nothing changed.'); return; }
    if (RESERVED.has(code)) { this.setStatus(`${name || 'That key'} is kept by your system or browser. Press another one, or Esc to cancel.`, true); this.armCaptureTimer(); return; }
    const pad = isPadCode(code);
    if (c.s === PAD_SLOT && !pad) { this.setStatus('This column is for gamepad buttons. Press one, or Esc to cancel.', true); this.armCaptureTimer(); return; }
    if (c.s !== PAD_SLOT && pad) { this.setStatus('This column is for keys and mouse buttons. Press one, or Esc to cancel.', true); this.armCaptureTimer(); return; }
    const from = input.assign(c.a, c.s, code);
    this.game.saveBindings();
    let msg = `${ACTION_NAME[c.a]}: ${name}.`;
    if (from) msg += ` ${name} no longer does “${ACTION_NAME[from.action]}”.`;
    if (code.startsWith('Control')) msg += ' Careful: browsers keep some Ctrl shortcuts, such as Ctrl+W, which closes the tab.';
    this.game.audio?.play('uiClick', { volume: 0.6 });
    this.endCapture(msg, !!from);
  }

  endCapture(msg, warn = false) {
    if (this.capturing) {
      clearTimeout(this.captureTimer);
      this.capturing.btn.classList.remove('capturing');
      this.capturing = null;
      this.game.input.capture = null;
    }
    this.refreshBindings();
    this.refreshKeyLabels();
    if (msg) this.setStatus(msg, warn);
  }

  clearBinding(btn) {
    if (!btn || !btn.classList.contains('slot')) return false;
    const a = btn.dataset.a, s = Number(btn.dataset.s);
    const input = this.game.input;
    if (!input.slots[a][s]) return true;
    input.clearSlot(a, s);
    this.game.saveBindings();
    this.refreshBindings();
    this.refreshKeyLabels();
    const left = input.bindings[a].length;
    this.setStatus(`Cleared the ${SLOT_NAMES[s]} for “${ACTION_NAME[a]}”.` + (left ? '' : ' Nothing triggers it now.'), !left);
    return true;
  }

  switchHoldMode(btn) {
    const m = HOLD_MODES.find((x) => x[0] === btn.dataset.m);
    if (!m) return;
    const on = !this.game.settings.toggles[m[0]];
    this.game.setToggleMode(m[0], on);
    this.focusIdx = Math.max(0, this.visibleButtons().indexOf(btn));
    this.updateFocus();
    this.refreshBindings();
    this.setStatus(on ? m[4] : `${m[1]} now works while you hold the key.`);
  }

  resetBindings() {
    this.endCapture();
    this.game.input.resetSlots();
    this.game.saveBindings();
    this.refreshBindings();
    this.refreshKeyLabels();
    this.setStatus('All controls are back to their defaults.');
  }

  /** Extra keys on the Controls screen: clear the selected box. Returns true when handled. */
  controlsKey(code) {
    if (code === 'Delete' || code === 'Backspace' || code === 'Pad2') {
      return this.clearBinding(this.visibleButtons()[this.focusIdx]);
    }
    return false;
  }

  /** Key names in hints, as bold HTML. */
  keyHtml(action) {
    const l = this.game.input.label(action);
    return l ? `<b>${esc(l)}</b>` : '<b>(unbound)</b>';
  }

  /** HUD badges that show keys follow the current bindings and device. */
  refreshKeyLabels() {
    const input = this.game.input;
    this.h.sigils.forEach((el, i) => { el.querySelector('.k').textContent = input.label(`sigil${i + 1}`, 'kbm', true); });
    this.h.knives.querySelector('.k').textContent = input.label('knife', input.lastDevice, true);
    this.h.tonics.querySelector('.k').textContent = input.label('tonic', input.lastDevice, true);
    if (this.screen === 'controls') this.refreshBindings();
  }

  renderHowTo() {
    const k = (a) => this.keyHtml(a);
    const t = this.game.settings.toggles;
    const sprint = t.sprint ? `Sprint (${k('sprint')} switches it on and off)` : `Hold ${k('sprint')}`;
    const parry = t.block ? `press ${k('block')} just before it lands to raise your guard and parry; press it again to lower it` : `tap ${k('block')} just before it lands to parry and counter`;
    this.$('.howto').innerHTML = `
  <p>${sprint} and run at a wall to climb it; at a ledge press ${k('forward')} or ${k('jump')} to pull up. Sprint off a roof edge to leap to the next rooftop automatically. Land in hay to break a fall and hide.</p>
  <p>Demons that spot you fill a meter above their heads: yellow means suspicious, red means you've been seen. Sneak (${k('sneak')}), stay above their line of sight and strike unaware demons with ${k('interact')} for an instant assassination, even from above or from inside a hay cart.</p>
  <p>In open combat, demons flash <span style="color:#ffd35a">yellow</span> before a parryable strike: ${parry}. <span style="color:#ff5a4a">Red</span> attacks can't be blocked, so dodge (${k('dodge')}) or roll (${k('jump')}). Badly wounded demons stagger and glow: press ${k('interact')} for a Glory Kill that showers health. Burning demons drop armor; assassinations drop knives.</p>`;
  }

  // ------------------------------------------------------------ HUD refs
  buildHud() {
    const $ = this.$;
    this.h = {
      hud: $('#hud'),
      hpFill: $('.bar.hp .fill'), hpLag: $('.bar.hp .lag'), hpArmor: $('.bar.hp .armor'), hpBar: $('.bar.hp'),
      stFill: $('.bar.st .fill'), stBar: $('.bar.st'),
      fury: [...this.root.querySelectorAll('.fury i')],
      sigils: [...this.root.querySelectorAll('.sigil')],
      sigilName: $('.sigil-name'),
      minimap: $('.minimap'),
      status: $('.status'),
      objTitle: $('.objective .title'), objText: $('.objective .text'), objSub: $('.objective .sub'),
      knives: $('.item.knives'), knivesN: $('.item.knives .n'),
      tonics: $('.item.tonics'), tonicsN: $('.item.tonics .n'),
      hint: $('.hint'),
      prompt: $('.prompt'), promptLabel: $('.prompt .label'), promptKey: $('.prompt .key'),
      notify: $('.notify'),
      banner: $('.banner'), bannerBig: $('.banner .big'), bannerSmall: $('.banner .small'),
      boss: $('.bossbar'), bossName: $('.bossbar .name'), bossFill: $('.bossbar .fill'),
      markers: $('.markers'),
      wave: $('.wave'),
      wp: $('.waypoint'), wpText: $('.waypoint span'),
      sight: $('.vignette-sight'),
      fps: $('.fps'),
      lockhint: $('.lockhint'),
    };
    this.mm = this.h.minimap.getContext('2d');
    this.hpLagV = 1;
    this.h.lockhint.addEventListener('click', () => { this.game.input.requestLock(); this.game.audio?.unlock(); });
  }

  setText(key, node, v) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    node.textContent = v;
  }

  setStyle(key, node, prop, v) {
    if (this.cache[key] === v) return;
    this.cache[key] = v;
    node.style[prop] = v;
  }

  setClass(key, node, cls, on) {
    const k = key + cls;
    if (this.cache[k] === on) return;
    this.cache[k] = on;
    node.classList.toggle(cls, on);
  }

  showHud(on) { this.h.hud.classList.toggle('on', on); }

  // ------------------------------------------------------------ per frame
  update(dt) {
    const g = this.game;
    const p = g.player;
    const h = this.h;
    if (!p) return;
    // health / armor / stamina
    const hpF = clamp(p.hp / p.maxHp, 0, 1);
    this.hpLagV = this.hpLagV > hpF ? Math.max(hpF, this.hpLagV - dt * 0.35) : hpF;
    this.setStyle('hp', h.hpFill, 'transform', `scaleX(${hpF.toFixed(3)})`);
    this.setStyle('hpl', h.hpLag, 'transform', `scaleX(${this.hpLagV.toFixed(3)})`);
    this.setStyle('ar', h.hpArmor, 'transform', `scaleX(${clamp(p.armor / p.maxArmor, 0, 1).toFixed(3)})`);
    this.setStyle('hpw', h.hpBar, 'width', `${Math.round(300 * p.maxHp / 150)}px`);
    this.setClass('hpb', h.hpBar, 'low', hpF < 0.3);
    const stF = clamp(p.stamina / p.maxStamina, 0, 1);
    this.setStyle('st', h.stFill, 'transform', `scaleX(${stF.toFixed(3)})`);
    this.setStyle('stw', h.stBar, 'width', `${Math.round(230 * p.maxStamina / 100)}px`);
    this.setClass('stb', h.stBar, 'empty', p.stamina < 50);
    h.fury.forEach((f, i) => this.setClass('fury' + i, f, 'on', p.fury > i));
    h.sigils.forEach((s, i) => {
      this.setClass('sig' + i, s, 'sel', i === p.sigil);
      this.setClass('sigs' + i, s, 'nost', p.stamina < SIGILS[i].cost);
    });
    this.setText('sname', h.sigilName, SIGILS[p.sigil].name + (p.aegis > 0 ? ' · ward active' : ''));
    this.setText('kn', h.knivesN, String(p.knives));
    this.setClass('kne', h.knives, 'empty', p.knives === 0);
    this.setText('tn', h.tonicsN, String(p.tonics));
    this.setClass('tne', h.tonics, 'empty', p.tonics === 0);
    // stealth status
    const cs = g.director.combatState();
    let st = 'anon', label = 'Anonymous';
    if (p.state === 'hidden') { st = 'hidden'; label = 'Hidden'; }
    else if (cs.close > 0) { st = 'det'; label = 'Detected'; }
    else if (cs.suspicious > 0) { st = 'sus'; label = 'Suspicious'; }
    if (this.cache.status !== st) {
      this.cache.status = st;
      h.status.className = 'status ' + st;
      h.status.textContent = label;
    }
    // prompt
    const pr = p.prompt;
    if (pr && !p.dead && g.state === 'playing') {
      this.setText('pl', h.promptLabel, pr.label);
      this.setText('pk', h.promptKey, g.input.label('interact') || '–');
      this.setClass('pr', h.prompt, 'on', true);
      this.setClass('prg', h.prompt, 'glory', pr.kind === 'glory');
      this.setClass('prd', h.prompt, 'danger', pr.kind === 'assassinate' || pr.kind === 'airAssassinate' || pr.kind === 'hayAssassinate' || pr.kind === 'ledgeAssassinate');
    } else this.setClass('pr', h.prompt, 'on', false);
    // objective
    const obj = g.objective();
    this.setText('ot', h.objTitle, obj.title);
    this.setText('ox', h.objText, obj.text);
    this.setText('os', h.objSub, obj.sub || '');
    // boss
    const boss = g.director.boss;
    if (boss && !boss.dead && boss.state !== 'spawn') {
      this.setClass('boss', h.boss, 'on', true);
      this.setText('bn', h.bossName, boss.def.name);
      this.setStyle('bf', h.bossFill, 'transform', `scaleX(${clamp(boss.hp / boss.maxHp, 0, 1).toFixed(3)})`);
    } else this.setClass('boss', h.boss, 'on', false);
    // arena wave
    const A = g.director.arena;
    if (A && !A.done && A.wave >= 0) {
      this.setClass('wave', h.wave, 'on', true);
      this.setText('wt', h.wave, `${A.rift.name.toUpperCase()} · WAVE ${Math.min(A.wave + 1, A.waves.length)} / ${A.waves.length} · ${A.alive.size} DEMONS`);
    } else this.setClass('wave', h.wave, 'on', false);
    this.setClass('sight', h.sight, 'on', g.sightOn);
    if (g.settings.fps) this.setText('fps', h.fps, `${Math.round(g.loop.fps)} fps`);
    else this.setText('fps', h.fps, '');
    this.setClass('lh', h.lockhint, 'on', g.state === 'playing' && !g.input.locked && g.wantLockHint);

    this.updateWaypoint(obj);
    this.updateMarkers(dt);
    this.updateDamageNumbers(dt);
    this.lastMinimap += dt;
    if (this.lastMinimap > 1 / 30) { this.lastMinimap = 0; this.drawMinimap(); }
  }

  // ------------------------------------------------------------ waypoint
  updateWaypoint(obj) {
    const h = this.h;
    const g = this.game;
    const p = g.player;
    if (!obj.pos || p.dead || g.sightOn === undefined) { this.setClass('wp', h.wp, 'on', false); return; }
    const v = this._wv || (this._wv = new THREE.Vector3());
    v.set(obj.pos.x, obj.pos.y ?? 4, obj.pos.z);
    const dist = Math.hypot(v.x - p.pos.x, v.z - p.pos.z);
    if (dist < 6) { this.setClass('wp', h.wp, 'on', false); return; }
    this.setClass('wp', h.wp, 'on', true);
    const cam = g.renderer.camera;
    v.project(cam);
    const W = window.innerWidth, H = window.innerHeight;
    let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
    const behind = v.z > 1;
    if (behind) { x = W - x; y = H - 60; }
    const m = 46;
    x = clamp(x, m, W - m);
    y = clamp(y, m + 40, H - m - 40);
    h.wp.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
    this.setText('wpt', h.wpText, `${Math.round(dist)} m`);
  }

  // ------------------------------------------------------------ markers
  marker(i) {
    if (!this.markers[i]) {
      const m = el('<div class="mk"><div class="gl"></div><div class="lock"></div><svg class="aw" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="rgba(0,0,0,0.55)" stroke="rgba(0,0,0,0.6)" stroke-width="2"/><circle class="arc" cx="12" cy="12" r="9" fill="none" stroke="#ffd35a" stroke-width="3" stroke-dasharray="56.5" stroke-dashoffset="56.5" transform="rotate(-90 12 12)"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="#ffd35a" font-family="Cinzel,serif">?</text></svg><div class="hp"><i></i></div></div>');
      this.h.markers.appendChild(m);
      this.markers[i] = { el: m, arc: m.querySelector('.arc'), text: m.querySelector('text'), aw: m.querySelector('.aw'), hp: m.querySelector('.hp'), hpi: m.querySelector('.hp i'), lock: m.querySelector('.lock'), gl: m.querySelector('.gl'), c: {} };
    }
    return this.markers[i];
  }

  edge(i) {
    if (!this.edges[i]) {
      const e = el('<div class="edge"></div>');
      this.h.markers.appendChild(e);
      this.edges[i] = e;
    }
    return this.edges[i];
  }

  updateMarkers() {
    const g = this.game;
    const cam = g.renderer.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const p = g.player;
    let mi = 0, ei = 0;
    const v = this._v || (this._v = new THREE.Vector3());
    const now = g.realTime;
    for (const e of g.director.enemies) {
      if (e.dead || e.removed) continue;
      const view = g.director.views.get(e);
      if (!view || !view.mesh) continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 45) continue;
      const showAw = !e.alerted && e.awareness > 0.03;
      const showAlert = e.alerted && now - (e.alertedAt ?? -99) < 2.5;
      const showHp = (e.hp < e.maxHp || (e.alerted && dist < 18)) && !e.def.boss && dist < 26;
      const locked = p.lockTarget === e;
      const glory = e.gloryable && dist < 8;
      if (!showAw && !showAlert && !showHp && !locked && !glory) continue;
      view.headPos(v);
      v.project(cam);
      const onScreen = v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05;
      if (!onScreen) {
        if ((showAw || showAlert) && dist < 32) {
          // edge arrow pointing toward the demon relative to the camera
          const ang = Math.atan2(dx, dz) - g.camera.yaw;
          const ed = this.edge(ei++);
          const r = Math.min(W, H) * 0.32;
          const sx = W / 2 - Math.sin(ang) * r, sy = H / 2 - Math.cos(ang) * r;
          ed.style.display = 'block';
          ed.style.transform = `translate(${sx - 10}px, ${sy - 12}px) rotate(${-ang}rad)`;
          ed.className = 'edge' + (e.alerted || e.awareness > 0.7 ? ' det' : '');
        }
        continue;
      }
      const m = this.marker(mi++);
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      m.el.style.display = 'flex';
      m.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      const awOn = showAw || showAlert;
      if (m.c.aw !== awOn) { m.c.aw = awOn; m.aw.style.display = awOn ? 'block' : 'none'; }
      if (awOn) {
        const f = showAlert ? 1 : e.awareness;
        m.arc.setAttribute('stroke-dashoffset', (56.5 * (1 - f)).toFixed(1));
        const col = showAlert ? '#ff4a3a' : f > 0.66 ? '#ff9a3a' : '#ffd35a';
        if (m.c.col !== col) { m.c.col = col; m.arc.setAttribute('stroke', col); m.text.setAttribute('fill', col); }
        const ch = showAlert ? '!' : '?';
        if (m.c.ch !== ch) { m.c.ch = ch; m.text.textContent = ch; }
      }
      if (m.c.hpOn !== showHp) { m.c.hpOn = showHp; m.hp.style.display = showHp ? 'block' : 'none'; }
      if (showHp) {
        m.hpi.style.width = `${clamp(e.hp / e.maxHp, 0, 1) * 100}%`;
        const arm = e.def.armoredFront && e.burning <= 0;
        if (m.c.arm !== arm) { m.c.arm = arm; m.hp.classList.toggle('armored', arm); }
      }
      if (m.c.lock !== locked) { m.c.lock = locked; m.lock.style.display = locked ? 'block' : 'none'; }
      const gl = glory ? (g.input.label('interact', undefined, true) || '–') + ' · GLORY' : '';
      if (m.c.gl !== gl) { m.c.gl = gl; m.gl.textContent = gl; m.gl.style.display = gl ? 'block' : 'none'; }
    }
    for (let i = mi; i < this.markers.length; i++) if (this.markers[i].el.style.display !== 'none') this.markers[i].el.style.display = 'none';
    for (let i = ei; i < this.edges.length; i++) if (this.edges[i].style.display !== 'none') this.edges[i].style.display = 'none';
  }

  damageNumber(e, amount, armored) {
    if (!this.game.settings.dmgNumbers) return;
    const view = this.game.director.views.get(e);
    if (!view) return;
    const pos = view.headPos(new THREE.Vector3());
    pos.y -= 0.3;
    let d = this.dmgs.find((x) => !x.alive);
    if (!d) {
      if (this.dmgs.length > 24) return;
      d = { el: el('<div class="dmg"></div>'), alive: false };
      this.h.markers.appendChild(d.el);
      this.dmgs.push(d);
    }
    d.alive = true;
    d.t = 0;
    d.pos = pos;
    d.vx = (Math.random() - 0.5) * 0.8;
    d.el.textContent = Math.round(amount);
    d.el.className = 'dmg' + (armored ? ' armor' : amount >= 45 ? ' crit' : '');
    d.el.style.display = 'block';
  }

  updateDamageNumbers(dt) {
    const cam = this.game.renderer.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const v = this._v2 || (this._v2 = new THREE.Vector3());
    for (const d of this.dmgs) {
      if (!d.alive) continue;
      d.t += dt;
      d.pos.y += dt * 1.2;
      d.pos.x += d.vx * dt;
      v.copy(d.pos).project(cam);
      if (d.t > 0.9 || v.z > 1) { d.alive = false; d.el.style.display = 'none'; continue; }
      d.el.style.left = ((v.x * 0.5 + 0.5) * W).toFixed(1) + 'px';
      d.el.style.top = ((-v.y * 0.5 + 0.5) * H).toFixed(1) + 'px';
      d.el.style.opacity = String(1 - Math.max(0, d.t - 0.5) / 0.4);
    }
  }

  // ------------------------------------------------------------ minimap
  drawMinimap() {
    const g = this.game;
    const ctx = this.mm;
    const city = g.city;
    const p = g.player;
    const S = 190, R = S / 2;
    const scale = 1.6; // px per metre on the minimap
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#1a110b';
    ctx.fillRect(0, 0, S, S);
    ctx.translate(R, R);
    ctx.rotate(Math.PI + g.camera.yaw);
    // map image: city.mapCanvas has 2 px / m with origin at -WALL_OUT
    const ms = city.mapScale;
    const k = scale / ms;
    ctx.scale(k, k);
    ctx.drawImage(city.mapCanvas, -(p.pos.x - city.mapOrigin) * ms, -(p.pos.z - city.mapOrigin) * ms);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // icons in rotated space
    const rot = -(Math.PI + g.camera.yaw);
    const toScreen = (x, z) => {
      const dx = (x - p.pos.x) * scale, dz = (z - p.pos.z) * scale;
      const c = Math.cos(-rot), s = Math.sin(-rot);
      return [R + dx * c - dz * s, R + dx * s + dz * c];
    };
    const prog = g.progress;
    const clampEdge = (sx, sy, m = 10) => {
      const dx = sx - R, dy = sy - R, d = Math.hypot(dx, dy);
      if (d > R - m) return [R + (dx / d) * (R - m), R + (dy / d) * (R - m), true];
      return [sx, sy, false];
    };
    // viewpoints
    for (const vp of city.viewpoints) {
      const [sx, sy] = toScreen(vp.x, vp.z);
      if (Math.hypot(sx - R, sy - R) > R) continue;
      this.drawVpIcon(ctx, sx, sy, prog.viewpoints[vp.id]);
    }
    // chests revealed by synced viewpoints
    for (const c of g.interactions.chests) {
      if (c.open || !g.isRevealed(c.data.x, c.data.z)) continue;
      const [sx, sy] = toScreen(c.data.x, c.data.z);
      if (Math.hypot(sx - R, sy - R) > R - 4) continue;
      ctx.fillStyle = '#d8b040';
      ctx.fillRect(sx - 3, sy - 2, 6, 4);
    }
    // demons
    for (const e of g.director.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (d > 55) continue;
      const known = e.alerted || e.awareness > 0.05 || d < 22 || g.sightOn;
      if (!known) continue;
      const [sx, sy] = toScreen(e.pos.x, e.pos.z);
      if (Math.hypot(sx - R, sy - R) > R - 3) continue;
      ctx.fillStyle = e.alerted ? '#ff3a2a' : e.awareness > 0.05 ? '#ffd35a' : 'rgba(200,120,100,0.75)';
      ctx.beginPath();
      ctx.arc(sx, sy, e.def.heavy ? 4 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // objective marker
    const obj = g.objective();
    if (obj.pos) {
      let [sx, sy] = toScreen(obj.pos.x, obj.pos.z);
      [sx, sy] = clampEdge(sx, sy, 9);
      ctx.fillStyle = '#ffcf6a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 7); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 7); ctx.lineTo(sx - 5, sy); ctx.closePath();
      ctx.stroke(); ctx.fill();
    }
    // player arrow (map rotates with the camera; arrow shows facing)
    ctx.translate(R, R);
    ctx.rotate(-(p.renderYaw ? p.renderYaw(1) : p.yaw) + g.camera.yaw);
    ctx.fillStyle = '#fff2cc';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // north indicator position
    const n = this.$('.minimap-n');
    const na = Math.PI + g.camera.yaw;
    n.style.left = `${R + Math.sin(-na) * (R - 2) * -1}px`;
    n.style.top = `${R - Math.cos(na) * (R - 2) - 8}px`;
  }

  drawVpIcon(ctx, x, y, synced) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = synced ? '#f0c860' : '#8a7a60';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(7, 4); ctx.lineTo(0, 1); ctx.lineTo(-7, 4); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------ big map
  drawBigMap() {
    const g = this.game;
    const cv = this.$('#bigmap');
    const ctx = cv.getContext('2d');
    const city = g.city;
    const W = cv.width;
    const mc = city.mapCanvas;
    ctx.drawImage(mc, 0, 0, W, W);
    const s = W / (mc.width / city.mapScale);
    const tx = (x) => (x - city.mapOrigin) * s;
    // fog of the unknown: darken areas not revealed by synced viewpoints
    if (!this.fogCanvas) { this.fogCanvas = document.createElement('canvas'); this.fogCanvas.width = this.fogCanvas.height = W; }
    const fc = this.fogCanvas.getContext('2d');
    fc.globalCompositeOperation = 'source-over';
    fc.clearRect(0, 0, W, W);
    fc.fillStyle = 'rgba(10,5,3,0.6)';
    fc.fillRect(0, 0, W, W);
    fc.globalCompositeOperation = 'destination-out';
    for (const vp of city.viewpoints) {
      if (!g.progress.viewpoints[vp.id]) continue;
      const grad = fc.createRadialGradient(tx(vp.x), tx(vp.z), 80 * s, tx(vp.x), tx(vp.z), 98 * s);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      fc.fillStyle = grad;
      fc.beginPath();
      fc.arc(tx(vp.x), tx(vp.z), 98 * s, 0, Math.PI * 2);
      fc.fill();
    }
    ctx.drawImage(this.fogCanvas, 0, 0);
    for (const r of city.rifts) {
      const x = tx(r.x), y = tx(r.z);
      ctx.fillStyle = r.closed ? '#f4e2b0' : '#ff3a1a';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '600 13px Cinzel, serif'; ctx.textAlign = 'center';
      ctx.fillText(r.closed ? r.name + ' (cleansed)' : r.name, x, y - 14);
    }
    if (Object.values(g.progress.rifts).filter(Boolean).length >= 3 && !g.progress.boss) {
      const c = city.cathedral.arena;
      ctx.fillStyle = '#ff2a10';
      ctx.beginPath(); ctx.arc(tx(c.x), tx(c.z), 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText('The Cardinal of Ash', tx(c.x), tx(c.z) - 18);
    }
    for (const vp of city.viewpoints) {
      this.drawVpIcon(ctx, tx(vp.x), tx(vp.z), g.progress.viewpoints[vp.id]);
      ctx.fillStyle = '#e8d8b8'; ctx.font = '12px EB Garamond, serif'; ctx.textAlign = 'center';
      ctx.fillText(vp.name, tx(vp.x), tx(vp.z) + 18);
    }
    for (const c of g.interactions.chests) {
      if (c.open || !g.isRevealed(c.data.x, c.data.z)) continue;
      ctx.fillStyle = '#d8b040'; ctx.fillRect(tx(c.data.x) - 4, tx(c.data.z) - 3, 8, 6);
    }
    for (const e of g.director.enemies) {
      if (e.dead || !e.alerted) continue;
      ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(tx(e.pos.x), tx(e.pos.z), 3, 0, Math.PI * 2); ctx.fill();
    }
    const p = g.player;
    ctx.save();
    ctx.translate(tx(p.pos.x), tx(p.pos.z));
    ctx.rotate(Math.PI - p.yaw);
    ctx.fillStyle = '#fff2cc'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------ messages
  notify(text, kind = '') {
    const n = el(`<div class="note ${kind}"></div>`);
    n.textContent = text;
    n.style.setProperty('--d', '3.2s');
    this.h.notify.appendChild(n);
    setTimeout(() => n.remove(), 4000);
    while (this.h.notify.children.length > 4) this.h.notify.firstChild.remove();
  }

  banner(big, small = '') {
    const b = this.h.banner;
    this.h.bannerBig.textContent = big;
    this.h.bannerSmall.textContent = small;
    b.classList.remove('on');
    void b.offsetWidth;
    b.classList.add('on');
  }

  hint(html, seconds = 6) {
    const h = this.h.hint;
    h.innerHTML = html;
    h.classList.add('on');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => h.classList.remove('on'), seconds * 1000);
  }

  // ------------------------------------------------------------ screens
  show(id) {
    if (this.capturing) this.endCapture();
    for (const s of this.root.querySelectorAll('.screen')) s.classList.toggle('on', s.id === 'screen-' + id);
    this.screen = id || null;
    this.focusIdx = 0;
    if (id === 'controls') {
      this.refreshBindings();
      this.setStatus('');
    }
    if (id === 'map') this.drawBigMap();
    if (id === 'upgrades') this.renderUpgrades();
    if (id === 'settings') this.syncSettings();
    if (id === 'difficulty') {
      const cur = this.game.settings.difficulty;
      for (const b of this.root.querySelectorAll('.btn.diff')) b.classList.toggle('current', b.dataset.d === cur);
      this.focusIdx = Math.max(0, this.visibleButtons().findIndex((b) => b.dataset.d === cur));
    }
    if (id === 'title') {
      const cont = this.$('[data-act="continue"]');
      cont.style.display = this.game.hasSave() ? '' : 'none';
      // touch-only devices (no mouse) can't play without a gamepad
      let touchOnly = false;
      try { touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch (_) { /* old browser */ }
      this.$('#screen-title .device-note').hidden = !touchOnly;
    }
    this.updateFocus();
  }

  setLoading(f, text) {
    this.$('.loadbar i').style.width = `${Math.round(f * 100)}%`;
    if (text) this.$('.loadtext').textContent = text;
  }

  bindMenus() {
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      this.game.audio?.unlock();
      this.game.audio?.play('uiClick', { volume: 0.6 });
      if (b.dataset.act === 'opt') {
        // the left arrow lowers / goes back; anywhere else on the button raises / goes forward
        const arw = e.target.closest('.arw');
        this.focusIdx = Math.max(0, this.visibleButtons().indexOf(b));
        this.updateFocus();
        this.changeOption(b, arw ? Number(arw.dataset.d) : 1);
        return;
      }
      this.game.menuAction(b.dataset.act, b);
    });
    // menu buttons never take browser focus: keyboard and gamepad focus is the game's own highlight,
    // so Enter / Space can't also click a button the mouse touched earlier
    this.root.addEventListener('mousedown', (e) => { if (e.target.closest('.btn')) e.preventDefault(); });
    this.root.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('.btn.slot');
      if (!b) return;
      e.preventDefault();
      this.focusIdx = Math.max(0, this.visibleButtons().indexOf(b));
      this.updateFocus();
      this.clearBinding(b);
    });
    this.root.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.btn');
      if (b && b !== this.hovered) { this.hovered = b; this.game.audio?.play('uiHover', { volume: 0.25 }); }
    });
  }

  changeOption(btn, dir) {
    const o = SETTINGS.find((x) => x.k === btn.dataset.k);
    if (!o) return;
    const cur = this.game.settings[o.k];
    let v;
    if (o.options) {
      const i = Math.max(0, o.options.findIndex(([val]) => val === cur));
      v = o.options[(i + dir + o.options.length) % o.options.length][0];
    } else {
      v = Math.min(o.max, Math.max(o.min, Math.round((Number(cur) + dir * o.step) / o.step) * o.step));
      v = Number(v.toFixed(2));
    }
    this.game.setSetting(o.k, v);
    this.syncSettings();
  }

  /** Keyboard / gamepad navigation of menus: dr moves between rows, dc within a row. */
  navigate(dr, dc = 0) {
    const btns = this.visibleButtons();
    if (!btns.length) return;
    if (this.screen === 'controls') {
      const cur = btns[this.focusIdx] || btns[0];
      const rows = this.bindRows + 1;
      let r = Number(cur.dataset.r), c = Number(cur.dataset.c);
      r = (r + dr + rows) % rows;
      const row = btns.filter((b) => Number(b.dataset.r) === r);
      if (dc) {
        const i = row.indexOf(cur);
        c = Number(row[(i + dc + row.length) % row.length].dataset.c);
      }
      let best = row[0];
      for (const b of row) if (Math.abs(Number(b.dataset.c) - c) < Math.abs(Number(best.dataset.c) - c)) best = b;
      this.focusIdx = btns.indexOf(best);
    } else if (dc) {
      // Settings: left / right change the selected option
      const f = btns[this.focusIdx];
      if (this.screen === 'settings' && f && f.classList.contains('opt')) this.changeOption(f, dc);
      return;
    } else {
      this.focusIdx = (this.focusIdx + dr + btns.length) % btns.length;
    }
    this.updateFocus();
    this.game.audio?.play('uiHover', { volume: 0.25 });
  }

  activate() {
    const btns = this.visibleButtons();
    const b = btns[this.focusIdx];
    if (b) b.click();
  }

  visibleButtons() {
    if (!this.screen) return [];
    const s = this.$('#screen-' + this.screen);
    return [...s.querySelectorAll('.btn')].filter((b) => b.offsetParent !== null && !b.disabled);
  }

  updateFocus() {
    const btns = this.visibleButtons();
    btns.forEach((b, i) => b.classList.toggle('focus', i === this.focusIdx));
    const f = btns[this.focusIdx];
    if (f && this.screen === 'controls') f.scrollIntoView({ block: 'nearest' });
  }

  syncSettings() {
    const s = this.game.settings;
    for (const b of this.root.querySelectorAll('.btn.opt')) {
      const o = SETTINGS.find((x) => x.k === b.dataset.k);
      const v = s[o.k];
      const text = o.options ? (o.options.find(([val]) => val === v) || o.options[0])[1] : o.fmt(Number(v));
      b.querySelector('.v').textContent = text;
      b.setAttribute('aria-label', `${o.label}: ${text}. Left and right change it.`);
    }
    const d = DIFF_TEXT[s.difficulty];
    this.$('.diff-note').textContent = d ? `${d[0]}: ${d[1]}` : '';
  }

  renderUpgrades() {
    const g = this.game;
    const prog = g.progress;
    this.$('.runes').textContent = `Ashen Runes: ${prog.runes}`;
    const list = this.$('.upg-list');
    list.innerHTML = '';
    for (const u of UPGRADES) {
      const lvl = prog.upgrades[u.id] || 0;
      const max = u.costs.length;
      const cost = lvl < max ? u.costs[lvl] : null;
      const row = el(`<div class="upg"><div><div class="n"></div><div class="d"></div><div class="pips">${u.costs.map((_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div></div><button class="btn small" data-act="buy" data-id="${u.id}"></button></div>`);
      row.querySelector('.n').textContent = u.name;
      row.querySelector('.d').textContent = u.desc;
      const b = row.querySelector('button');
      b.textContent = cost === null ? 'Mastered' : `Learn (${cost})`;
      b.disabled = cost === null || prog.runes < cost;
      list.appendChild(row);
    }
    this.updateFocus();
  }

  renderVictory(stats) {
    const s = this.$('#screen-victory .stats');
    s.innerHTML = Object.entries(stats).map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  }

  embers() {
    const box = this.$('#screen-title .embers');
    for (let i = 0; i < 40; i++) {
      const e = document.createElement('i');
      e.style.left = `${Math.random() * 100}%`;
      e.style.animationDuration = `${6 + Math.random() * 10}s`;
      e.style.animationDelay = `${-Math.random() * 12}s`;
      e.style.setProperty('--dx', `${(Math.random() - 0.3) * 200}px`);
      e.style.opacity = String(0.4 + Math.random() * 0.6);
      box.appendChild(e);
    }
  }
}
