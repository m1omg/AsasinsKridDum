import * as THREE from 'three';
import { Renderer } from '../render/renderer.js';
import { loadTextures } from '../render/textures.js';
import { createMaterials } from '../render/materials.js';
import { Sky } from '../render/sky.js';
import { FX } from '../render/fx.js';
import { CollisionWorld } from '../world/collision.js';
import { City } from '../world/city.js';
import { Input } from '../core/input.js';
import { Loop, FIXED_DT } from '../core/loop.js';
import { Events } from '../core/events.js';
import { AudioEngine } from '../core/audio.js';
import { ThirdPersonCamera } from './camera.js';
import { Player } from '../entities/player.js';
import { installCombat, PLAYER_CLIPS } from '../entities/playerCombat.js';
import { PlayerView } from '../entities/playerView.js';
import { CLIPS } from '../entities/clips.js';
import { Director } from './director.js';
import { Pickups } from './pickups.js';
import { Interactions, Snares } from './interactions.js';
import { UI, UPGRADES } from './ui.js';
import { clamp, damp } from '../core/math.js';

installCombat();
Object.assign(CLIPS, PLAYER_CLIPS);

const SAVE_KEY = 'hellcreed_save_v1';
const SETTINGS_KEY = 'hellcreed_settings_v1';
const DIFFICULTY = {
  easy: { taken: 0.55, dealt: 1.25, detect: 0.75 },
  normal: { taken: 1, dealt: 1, detect: 1 },
  hard: { taken: 1.45, dealt: 0.9, detect: 1.25 },
};

function storage(fn, fallback = null) {
  try { return fn(); } catch (_) { return fallback; }
}

function freshProgress() {
  return { rifts: {}, viewpoints: {}, chests: {}, relics: {}, runes: 0, upgrades: {}, boss: false, checkpoint: null, stats: { kills: 0, assassinations: 0, gloryKills: 0, detected: 0, time: 0, deaths: 0 } };
}

export class Game {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.events = new Events();
    this.renderer = new Renderer(canvas);
    this.scene = this.renderer.scene;
    this.input = new Input(canvas);
    this.collision = new CollisionWorld();
    this.audio = new AudioEngine();
    this.ui = new UI(this, uiRoot);
    this.state = 'loading';
    this.tick = 0;
    this.time = 0;
    this.realTime = 0;
    this.focus = new THREE.Vector3();
    this.sightOn = false;
    this.sightK = 0;
    this.settings = this.loadSettings();
    this.input.setSlots(this.settings.bindings);
    this.applyToggles();
    this.input.onLabelsChanged = () => this.ui.refreshKeyLabels();
    this.ui.refreshKeyLabels();
    this.difficulty = DIFFICULTY[this.settings.difficulty] || DIFFICULTY.normal;
    this.progress = freshProgress();
    this.musicMode = 'none';
    this.loop = new Loop({
      pre: (dt) => this.preFrame(dt),
      update: (dt, t, now) => this.fixedUpdate(dt, t, now),
      render: (dt, simDt, alpha) => this.renderFrame(dt, simDt, alpha),
    });
    this.ui.show('loading');
    this.bindGlobal();
  }

  // ------------------------------------------------------------ settings
  loadSettings() {
    // toggles: true = one press switches the action on and the next switches it off; false = hold the key
    const def = { sens: 1, invertY: false, fov: 65, master: 0.8, music: 0.55, sfx: 0.9, quality: 'medium', difficulty: 'normal', shake: true, dmgNumbers: true, fps: false, bindings: null, toggles: { sprint: false, block: false, sneak: true } };
    const s = storage(() => JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
    // mobile / small GPUs start on low quality
    if (!s && (window.innerWidth < 900 || /Mobi|Android/i.test(navigator.userAgent))) def.quality = 'low';
    const out = { ...def, ...(s || {}) };
    const t = s && s.toggles && typeof s.toggles === 'object' ? s.toggles : {};
    out.toggles = {};
    for (const k of Object.keys(def.toggles)) out.toggles[k] = typeof t[k] === 'boolean' ? t[k] : def.toggles[k];
    return out;
  }

  setSetting(k, v) {
    const s = this.settings;
    if (k === 'invertY' || k === 'shake' || k === 'dmgNumbers' || k === 'fps') v = v === true || v === '1' || v === 1;
    else if (k === 'quality' || k === 'difficulty') v = String(v);
    else v = Number(v);
    s[k] = v;
    this.applySettings();
    this.saveSettings();
  }

  saveSettings() { storage(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))); }

  /** Remember remapped controls (called by the Controls screen after every change). */
  saveBindings() {
    this.settings.bindings = this.input.exportSlots();
    this.saveSettings();
  }

  /** Sprint / block / sneak: hold the key, or press once to switch on and again to switch off. */
  setToggleMode(action, on) {
    this.settings.toggles = { ...this.settings.toggles, [action]: !!on };
    this.applyToggles();
    this.saveSettings();
  }

  applyToggles() {
    const t = this.settings.toggles;
    this.input.setToggle('sprint', t.sprint);
    this.input.setToggle('block', t.block);
    // sneak is a gameplay toggle already; the player reads settings.toggles.sneak directly
  }

  /** Key name for hints, as bold HTML; follows the player's bindings and device. */
  key(action) { return this.ui.keyHtml(action); }

  applySettings() {
    const s = this.settings;
    if (this.camera) {
      this.camera.sensitivity = s.sens;
      this.camera.invertY = s.invertY;
      this.camera.baseFov = s.fov;
      this.camera.shakeEnabled = s.shake;
    }
    this.audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    this.difficulty = DIFFICULTY[s.difficulty] || DIFFICULTY.normal;
    if (this.renderer.quality !== s.quality) {
      this.renderer.setQuality(s.quality);
      this.fx?.setQuality(this.renderer.settings);
    }
  }

  // ------------------------------------------------------------ loading
  async load() {
    this.ui.setLoading(0.05, 'Gathering ash and brimstone…');
    this.tex = await loadTextures(this.renderer.gl, (p) => this.ui.setLoading(0.05 + p * 0.45));
    this.materials = createMaterials(this.tex);
    this.ui.setLoading(0.55, 'Raising the city of Vellano…');
    await new Promise((r) => setTimeout(r, 30));
    this.city = new City({ scene: this.scene, collision: this.collision, materials: this.materials }).build();
    this.ui.setLoading(0.75, 'Opening the rifts…');
    await new Promise((r) => setTimeout(r, 30));
    this.sky = new Sky(this.scene, this.tex);
    this.sky.bakeEnvironment(this.renderer.gl, this.scene, 0.5);
    this.sky.onLightning = () => { this.lightning = 1; if (Math.random() < 0.5) this.audio.play('thunder', { volume: 0.5 }); };
    this.fx = new FX(this);
    this.camera = new ThirdPersonCamera(this.renderer.camera, this.collision, this.input);
    this.player = new Player(this);
    this.player.initCombat();
    this.playerView = new PlayerView(this, this.materials);
    this.director = new Director(this);
    this.pickups = new Pickups(this);
    this.interactions = new Interactions(this);
    this.snares = new Snares(this);
    this.applySettings();
    this.renderer.setQuality(this.settings.quality);
    this.fx.setQuality(this.renderer.settings);
    this.wireEvents();
    this.ui.setLoading(0.9, 'Waking the demons…');
    await new Promise((r) => setTimeout(r, 30));
    // warm up shaders with a first frame from the title camera
    this.titleCam(0);
    this.renderer.updateShadow(this.focus);
    this.renderer.render();
    this.ui.setLoading(1);
    this.state = 'title';
    this.ui.show('title');
  }

  start() { this.loop.start(); }

  hasSave() { return !!storage(() => localStorage.getItem(SAVE_KEY)); }

  // ------------------------------------------------------------ new / continue
  newGame() {
    storage(() => localStorage.removeItem(SAVE_KEY));
    this.progress = freshProgress();
    this.setupWorld(true);
    this.state = 'intro';
    this.ui.show('intro');
  }

  continueGame() {
    const data = storage(() => JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'));
    this.progress = { ...freshProgress(), ...(data || {}) };
    this.progress.stats = { ...freshProgress().stats, ...(this.progress.stats || {}) };
    this.setupWorld(false);
    this.beginPlay();
  }

  setupWorld(fresh) {
    const prog = this.progress;
    for (const r of this.city.rifts) r.closed = !!prog.rifts[r.id];
    this.director.clearAll();
    this.director.buildRifts(prog);
    this.director.populate(prog);
    this.interactions.applyProgress(prog);
    this.pickups.clear();
    this.snares.clear();
    const p = this.player;
    p.upgrades = prog.upgrades;
    p.initCombat();
    p.hp = p.maxHp;
    p.armor = 0;
    p.knives = fresh ? 5 : (prog.knives ?? 5);
    p.tonics = fresh ? 1 : (prog.tonics ?? p.maxTonics);
    const cp = prog.checkpoint || this.city.spawn;
    p.spawn(cp.x, cp.y, cp.z, cp.yaw ?? 0);
    p.sneaking = false;
    this.input.clearLatches();
    this.camera.snapBehind(cp.yaw ?? 0);
    this.camera.cinematic = null;
    this.sightOn = false;
    this.bossIntroDone = !!prog.boss;
    if (prog.boss) this.city.roseWindow.material.color.set(0x6a4a30);
    this.tutorialStep = fresh ? 0 : 99;
    this.tutorialT = 0;
  }

  beginPlay() {
    this.state = 'playing';
    this.ui.show(null);
    this.ui.showHud(true);
    this.input.gameActive = true;
    this.input.releaseAll();
    this.audio.unlock();
    this.input.requestLock();
    this.wantLockHint = true;
    if (this.tutorialStep === 0) {
      this.ui.banner('VELLANO', 'The city burns. The Creed hunts.');
      setTimeout(() => this.ui.hint(`${this.settings.toggles.sprint ? `Press ${this.key('sprint')} to sprint, and again to walk.` : `Hold ${this.key('sprint')} to sprint.`} Run at a wall to climb it, and leap gaps between rooftops automatically.`, 9), 2500);
    }
  }

  // ------------------------------------------------------------ save
  save() {
    const p = this.player;
    this.progress.knives = p.knives;
    this.progress.tonics = p.tonics;
    storage(() => localStorage.setItem(SAVE_KEY, JSON.stringify(this.progress)));
  }

  checkpoint(x, y, z, yaw) {
    this.progress.checkpoint = { x, y, z, yaw };
    this.save();
  }

  isRevealed(x, z) {
    for (const vp of this.city.viewpoints) {
      if (this.progress.viewpoints[vp.id] && Math.hypot(vp.x - x, vp.z - z) < 95) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ objectives
  objective() {
    const prog = this.progress;
    const city = this.city;
    const p = this.player;
    if (!this.player) return { title: '', text: '' };
    if (prog.boss) return { title: 'Free roam', text: 'Vellano is cleansed. Hunt relics and stragglers.', sub: `Relics ${Object.keys(prog.relics).length}/${this.interactions.relics.length}` };
    const A = this.director.arena;
    if (A && !A.done) return { title: A.rift.name, text: 'Survive the onslaught and seal the rift.' };
    const nRifts = Object.values(prog.rifts).filter(Boolean).length;
    if (nRifts >= 3) {
      const c = city.cathedral.arena;
      return { title: 'The Cardinal of Ash', text: 'Confront the Cardinal before the cathedral.', pos: { x: c.x, y: 3, z: c.z } };
    }
    const vp0 = city.viewpoints.find((v) => v.id === 'vp_south');
    if (!prog.viewpoints.vp_south) return { title: 'A View of the Damned', text: `Climb the ${vp0.name} and synchronize.`, sub: 'Viewpoints reveal the city and serve as checkpoints.', pos: { x: vp0.perch.x, y: vp0.perch.y + 1.5, z: vp0.perch.z } };
    // nearest open rift
    let best = null, bd = Infinity;
    for (const r of city.rifts) {
      if (r.closed) continue;
      const d = Math.hypot(r.x - p.pos.x, r.z - p.pos.z);
      if (d < bd) { bd = d; best = r; }
    }
    return { title: `Close the Hell Rifts (${nRifts}/3)`, text: `Strike the Rift Heart at ${best.name}.`, sub: `Synced viewpoints: ${Object.keys(prog.viewpoints).length}/${city.viewpoints.length}`, pos: { x: best.x, y: 6, z: best.z } };
  }

  // ------------------------------------------------------------ world events
  synchronize(vp) {
    const p = this.player;
    this.progress.viewpoints[vp.id] = true;
    this.progress.runes += 1;
    p.setState('sync');
    p.yaw = Math.atan2(0, vp.dir);
    this.camera.cinematic = { yaw: p.yaw + Math.PI, pitch: 0.35, dist: 9, height: 1.2, shoulder: 0, orbit: 0.9, until: 3.6, fov: 60 };
    this.audio.play('sync', { volume: 1 });
    this.ui.banner('SYNCHRONIZED', vp.name);
    this.ui.notify('+1 Ashen Rune', 'loot');
    p.heal(p.maxHp);
    p.tonics = Math.max(p.tonics, Math.min(p.maxTonics, p.tonics + 1));
    this.checkpoint(vp.perch.x, vp.perch.y, vp.perch.z, p.yaw);
    this.fx.magicSwirl(vp.perch.x, vp.perch.y + 1, vp.perch.z, [2.5, 1.9, 0.8], 80, 2.5);
    if (vp.id === 'vp_south' && this.tutorialStep < 3) {
      this.tutorialStep = 3;
      setTimeout(() => this.ui.hint(`Press ${this.key('jump')} (or ${this.key('interact')}) at the end of the beam for a <b>Leap of Faith</b> into the hay below.`, 8), 4200);
    }
  }

  strikeRiftHeart(r) {
    const p = this.player;
    p.anim = { clip: 'h1', t: 0, fast: true };
    this.fx.explosion(r.heart.x, r.heart.y + 1, r.heart.z, 1);
    this.audio.play('hitArmor', { pos: r.heart, volume: 1 });
    this.camera.addShake(0.4);
    this.director.startArena(r);
    this.ui.banner('THE RIFT AWAKENS', 'Hold the circle until it collapses');
  }

  onRiftClosed(rift) {
    this.progress.rifts[rift.id] = true;
    this.progress.runes += 2;
    const p = this.player;
    p.heal(p.maxHp);
    p.knives = p.maxKnives;
    p.tonics = p.maxTonics;
    const n = Object.values(this.progress.rifts).filter(Boolean).length;
    this.ui.banner('RIFT SEALED', `${rift.name} · ${n} of 3`);
    this.ui.notify('+2 Ashen Runes', 'loot');
    this.checkpoint(rift.x + 3, 0, rift.z + 3, p.yaw);
    if (n >= 3) {
      setTimeout(() => {
        this.ui.banner('THE CATHEDRAL CALLS', 'The Cardinal of Ash awaits in the Piazza del Duomo');
        this.audio.play('bell', { volume: 1 });
      }, 3500);
    }
  }

  onBossDefeated() {
    this.progress.boss = true;
    this.save();
    this.sky.vortexUniforms.uOpen.value = 1;
    this.closingSky = 1;
    this.audio.play('riftClose', { volume: 1 });
    setTimeout(() => this.audio.play('bell', { volume: 1 }), 2500);
    this.ui.banner('THE CARDINAL FALLS', 'Vellano is free');
    setTimeout(() => {
      const st = this.progress.stats;
      this.ui.renderVictory({
        'Demons slain': st.kills,
        'Assassinations': st.assassinations,
        'Glory kills': st.gloryKills,
        'Times detected': st.detected,
        'Deaths': st.deaths,
        'Relics': `${Object.keys(this.progress.relics).length}/${this.interactions.relics.length}`,
        'Time': `${Math.floor(st.time / 60)}m ${Math.floor(st.time % 60)}s`,
      });
      this.state = 'victory';
      this.input.exitLock();
      this.ui.show('victory');
      this.setMusic('victory');
    }, 7000);
  }

  respawn() {
    const p = this.player;
    const prog = this.progress;
    prog.stats.deaths++;
    // reset an unfinished arena / boss fight
    const A = this.director.arena;
    if (A && !A.done) {
      for (const e of A.alive) e.removed = true;
      A.barrier.drop();
      A.barrier.dispose();
      A.rift.active = false;
      this.director.arena = null;
    }
    if (this.director.boss && !this.director.boss.dead) {
      this.director.boss.removed = true;
      for (const e of this.director.enemies) if (e.arena && e.arena.boss) e.removed = true;
      this.director.bossBarrier?.drop();
      this.director.bossBarrier?.dispose();
      this.director.boss = null;
      this.bossIntroDone = false;
    }
    this.director.projectiles.clear();
    for (const e of this.director.enemies) {
      if (e.dead) continue;
      e.alerted = false; e.awareness = 0; e.setState('patrol'); e.attack = null; e.telegraph = null; e.anim = null;
    }
    const cp = prog.checkpoint || this.city.spawn;
    p.spawn(cp.x, cp.y, cp.z, cp.yaw ?? 0);
    p.hp = p.maxHp;
    p.armor = 0;
    p.stamina = p.maxStamina;
    p.fury = 0;
    p.lockTarget = null;
    p.sneaking = false;
    this.input.clearLatches();
    p.invuln = 2;
    p.tonics = Math.max(p.tonics, 1);
    this.camera.snapBehind(cp.yaw ?? 0);
    this.camera.cinematic = null;
    this.state = 'playing';
    this.ui.show(null);
    this.input.requestLock();
    this.save();
  }

  // ------------------------------------------------------------ timing fx
  // real-time durations; the loop applies them from the exact step that triggered them
  hitStop(dur) { this.loop.hitStop(dur); }
  slowMo(scale, dur) { this.loop.slowMo(scale, dur); }

  // ------------------------------------------------------------ events
  wireEvents() {
    const ev = this.events;
    const st = () => this.progress.stats;
    ev.on('alerted', (e) => {
      e.alertedAt = this.realTime;
      if (this.state !== 'playing') return;
      if (!this.combatHinted && Math.hypot(e.pos.x - this.player.pos.x, e.pos.z - this.player.pos.z) < 30) {
        this.combatHinted = true;
        setTimeout(() => this.ui.hint(`Demons flash <span style="color:#ffd35a">yellow</span> before a parryable strike: ${this.settings.toggles.block ? `press ${this.key('block')} as it lands to raise your guard and <b>parry</b>; press it again to lower your guard` : `tap ${this.key('block')} as it lands to <b>parry</b> and counter`}. <span style="color:#ff6a5a">Red</span> strikes: ${this.key('dodge')} dodge / ${this.key('jump')} roll. ${this.key('cast')} casts your Sigil.`, 10), 1200);
      }
      if (!this.lastAlertSound || this.realTime - this.lastAlertSound > 4) {
        this.lastAlertSound = this.realTime;
        this.audio.play('alert', { volume: 0.7 });
        st().detected++;
      }
    });
    ev.on('enemyKilled', (e, kind) => {
      st().kills++;
      if (kind === 'assassinate') st().assassinations++;
      if (kind === 'glory') st().gloryKills++;
    });
    ev.on('enemyDamaged', (e, dmg, opts, armored) => {
      if (opts.source === 'player' || opts.type === 'fire') this.ui.damageNumber(e, dmg, armored);
    });
    ev.on('playerDied', () => {
      this.ui.showHud(true);
      setTimeout(() => {
        if (this.state !== 'playing') return;
        this.state = 'dead';
        this.input.exitLock();
        this.ui.show('death');
      }, 2200);
    });
    ev.on('parry', () => { if (this.tutorialStep < 99 && !this.parryHinted) { this.parryHinted = true; this.ui.notify('Parried! Counter-attack', 'loot'); } });
    ev.on('gloryReady', () => {
      if (!this.gloryHinted) { this.gloryHinted = true; this.ui.hint(`A staggered demon glows. Press ${this.key('interact')} for a <b>Glory Kill</b>: it bursts into health.`, 7); }
    });
    ev.on('noStamina', () => this.ui.notify('Not enough stamina', 'bad'));
    ev.on('noKnives', () => this.ui.notify('No throwing knives', 'bad'));
    ev.on('noTonic', () => this.ui.notify(this.player.tonics <= 0 ? 'No Blood Tonics' : 'Already at full health', 'bad'));
    ev.on('assassination', () => {
      if (!this.assassinHinted) { this.assassinHinted = true; this.ui.notify('Assassination: demons drop throwing knives', 'loot'); }
    });
    ev.on('arenaStart', () => this.setMusic('combat'));
    ev.on('wave', (n, total) => this.ui.banner(`WAVE ${n}`, n === total ? 'The rift is failing!' : 'More pour through the rift'));
    ev.on('bossStart', () => {
      this.ui.banner('THE CARDINAL OF ASH', 'Shepherd of the Damned');
      setTimeout(() => this.ui.hint('Jump over his stomp shockwaves, dodge the meteors, and parry his sweeps. <b>Snare</b> and <b>Hex</b> still bite.', 9), 3000);
    });
    ev.on('bossPhase', (ph) => this.ui.banner(ph === 1 ? 'HE BURNS BRIGHTER' : 'THE CARDINAL RAGES', ''));
    ev.on('bossKneel', () => {
      if (!this.kneelHinted) { this.kneelHinted = true; this.ui.hint(`The Cardinal kneels, exhausted! Get close and press ${this.key('interact')} to strike his burning heart.`, 6); }
      else this.ui.notify('The Cardinal kneels: strike now!', 'loot');
    });
  }

  bindGlobal() {
    window.addEventListener('pointerdown', () => { this.audio.unlock(); }, { capture: true });
    window.addEventListener('keydown', () => this.audio.unlock(), { capture: true });
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing') this.pause();
      if (locked) this.wantLockHint = false;
    };
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) {
        this.input.requestLock();
        // if lock is unavailable (sandboxed frame), allow free mouse look instead
        setTimeout(() => { if (!this.input.locked) { this.input.freeLook = true; this.wantLockHint = true; } }, 400);
      }
    });
    this.input.anyKeyCallbacks.push((code) => this.menuKey(code));
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'playing') this.pause(); });
  }

  pause(screen = 'pause') {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.loop.clearEffects();
    this.input.exitLock();
    this.input.releaseAll();
    this.audio.setPaused(true);
    this.ui.show(screen);
  }

  resume() {
    this.state = 'playing';
    this.ui.show(null);
    this.audio.setPaused(false);
    this.input.releaseAll();
    this.input.requestLock();
  }

  /** Menu handling for a key / pad press. Returns true when the menus used it. */
  menuKey(code) {
    const st = this.state;
    const has = (a) => this.input.bindings[a].includes(code);
    if (st === 'playing') {
      if (has('map')) { this.pause('map'); return true; }
      return false;
    }
    if (st === 'loading') return false;
    const ui = this.ui;
    // menus: arrows, D-pad, Enter / Space / A and Esc / B always work, plus the player's own movement keys
    if (ui.screen === 'controls' && ui.controlsKey(code)) return true;
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || code === 'Pad0') ui.activate();
    else if (code === 'ArrowDown' || code === 'Pad13' || has('back')) ui.navigate(1);
    else if (code === 'ArrowUp' || code === 'Pad12' || has('forward')) ui.navigate(-1);
    else if (code === 'ArrowLeft' || code === 'Pad14' || has('left')) ui.navigate(0, -1);
    else if (code === 'ArrowRight' || code === 'Pad15' || has('right')) ui.navigate(0, 1);
    else if (code === 'Escape' || code === 'Pad1' || has('pause') || (has('map') && ui.screen === 'map')) {
      if (st === 'paused') {
        if (ui.screen === 'pause') this.resume();
        else ui.show('pause');
      } else if (st === 'title' && ui.screen !== 'title') ui.show('title');
    } else return false;
    return true;
  }

  menuAction(act, btn) {
    const ui = this.ui;
    switch (act) {
      case 'new': this.newGame(); break;
      case 'continue': this.continueGame(); break;
      case 'begin': this.beginPlay(); break;
      case 'resume': this.resume(); break;
      case 'map': ui.show('map'); break;
      case 'upgrades': ui.show('upgrades'); break;
      case 'controls': ui.show('controls'); break;
      case 'bind': ui.startCapture(btn); break;
      case 'resetBinds': ui.resetBindings(); break;
      case 'holdMode': ui.switchHoldMode(btn); break;
      case 'settings': ui.show('settings'); break;
      case 'back': ui.show(this.state === 'title' ? 'title' : 'pause'); break;
      case 'title': this.toTitle(); break;
      case 'respawn': this.respawn(); break;
      case 'freeroam': this.state = 'playing'; ui.show(null); this.input.requestLock(); this.setMusic('explore'); break;
      case 'buy': this.buyUpgrade(btn.dataset.id); break;
      default: break;
    }
  }

  buyUpgrade(id) {
    const u = UPGRADES.find((x) => x.id === id);
    const prog = this.progress;
    const lvl = prog.upgrades[id] || 0;
    if (!u || lvl >= u.costs.length || prog.runes < u.costs[lvl]) return;
    prog.runes -= u.costs[lvl];
    prog.upgrades[id] = lvl + 1;
    const p = this.player;
    p.upgrades = prog.upgrades;
    const hpF = p.hp / p.maxHp;
    p.applyUpgrades();
    p.hp = Math.max(p.hp, hpF * p.maxHp);
    if (id === 'quiver') p.knives = p.maxKnives;
    if (id === 'tonic') p.tonics = Math.min(p.maxTonics, p.tonics + 1);
    this.audio.play('pickupRune', { volume: 0.8 });
    this.ui.renderUpgrades();
    this.save();
  }

  toTitle() {
    if (this.state === 'playing' || this.state === 'paused' || this.state === 'victory' || this.state === 'dead') this.save();
    this.state = 'title';
    this.input.exitLock();
    this.audio.setPaused(false);
    this.ui.showHud(false);
    this.ui.show('title');
  }

  // ------------------------------------------------------------ loop
  preFrame() {
    this.input.pollGamepad();
  }

  fixedUpdate(dt, t, now) {
    this.input.tick(t, now);
    if (this.state !== 'playing') return;
    this.tick++;
    this.time += dt;
    this.progress.stats.time += dt;
    const p = this.player;
    // Ashen Sight toggle
    if (this.input.pressed('sight')) {
      this.sightOn = !this.sightOn;
      this.audio.play('sigilHex', { volume: 0.35, pitch: 0.6 });
    }
    if (this.input.pressed('pause')) { this.pause(); return; }
    p.savePrev();
    p.update(dt);
    this.director.update(dt);
    this.pickups.update(dt);
    this.interactions.update(dt);
    this.snares.update(dt);
    this.updateTutorial(dt);
    // boss trigger
    if (!this.progress.boss && !this.director.boss && Object.values(this.progress.rifts).filter(Boolean).length >= 3) {
      const c = this.city.cathedral.arena;
      if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < c.r - 2 && p.pos.y < 2 && !p.dead) this.director.startBoss();
    }
    if (this.director.boss && !this.director.boss.dead) this.director.updateBossPhase(this.director.boss);
  }

  updateTutorial(dt) {
    if (this.tutorialStep >= 99) return;
    this.tutorialT += dt;
    const p = this.player;
    const s = this.tutorialStep;
    if (s === 0 && (p.state === 'climb' || this.tutorialT > 25)) {
      this.tutorialStep = 1;
      this.ui.hint(`At a ledge press ${this.key('forward')} to pull up. ${this.key('jump')} leaps upward, ${this.key('back')}+${this.key('jump')} jumps off, ${this.key('sneak')} drops.`, 8);
    } else if (s === 1 && this.tutorialT > 40) {
      this.tutorialStep = 2;
      this.ui.hint(`Demons below? Sneak with ${this.key('sneak')}. Press ${this.key('interact')} behind or above an unaware demon to <b>assassinate</b> it. ${this.key('sight')} toggles Ashen Sight.`, 9);
    }
  }

  /** Ambient beds: city wind everywhere, crackle at the nearest fire. */
  updateAmbience() {
    const a = this.audio;
    if (!a.ready) return;
    if (!this.windLoop) this.windLoop = a.loop('wind', { volume: 0.35 });
    const p = this.player;
    if (!p) return;
    let best = null, bd = 14;
    for (const f of this.city.fires) {
      if (f.candle) continue;
      const d = Math.hypot(f.x - p.pos.x, f.y - p.pos.y, f.z - p.pos.z);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) {
      if (!this.fireLoop) this.fireLoop = a.loop('fireCrackle', { pos: best, volume: 0.6 });
      this.fireLoop.setPos?.(best);
      this.fireLoop.setVolume?.(0.7 * (1 - bd / 14));
    } else if (this.fireLoop) this.fireLoop.setVolume?.(0);
    this.windLoop.setVolume?.(p.pos.y > 8 ? 0.6 : 0.3);
  }

  setMusic(mode) {
    if (this.musicMode === mode) return;
    this.musicMode = mode;
    this.audio.setMusic(mode);
  }

  updateMusic() {
    if (this.state === 'title' || this.state === 'loading') return this.setMusic('title');
    if (this.state === 'victory') return this.setMusic('victory');
    if (this.director.boss && !this.director.boss.dead) return this.setMusic('boss');
    if (this.director.arena && !this.director.arena.done) return this.setMusic('combat');
    const cs = this.director.combatState();
    if (cs.close > 0) { this.combatMusicT = 6; return this.setMusic('combat'); }
    if (this.combatMusicT > 0) return;
    if (cs.suspicious > 0) return this.setMusic('stealth');
    this.setMusic('explore');
  }

  titleCam(dt) {
    const t = this.realTime * 0.05;
    const cam = this.renderer.camera;
    const r = 70;
    cam.position.set(Math.sin(t) * r, 38, Math.cos(t) * r + 10);
    cam.lookAt(0, 18, -10);
    this.focus.set(cam.position.x * 0.5, 0, cam.position.z * 0.5);
    void dt;
  }

  renderFrame(dt, simDt, alpha) {
    this.realTime += dt;
    if (this.state === 'loading') return;
    if (this.combatMusicT > 0) this.combatMusicT -= dt;

    const playing = this.state === 'playing' || this.state === 'paused' || this.state === 'dead' || this.state === 'victory' || this.state === 'intro';
    const p = this.player;
    if (this.state === 'title' || this.state === 'intro') {
      this.titleCam(dt);
      this.renderer.camera.fov = 55;
      this.renderer.camera.updateProjectionMatrix();
      this.camera.fov = 55;
    } else if (playing) {
      const focus = p.renderPos(alpha, this.focus);
      let distance = 3.9, height = 1.58, fovAdd = 0, shoulder = 0.42;
      if (p.state === 'climb') { distance = 4.6; height = 1.35; }
      else if (p.sneaking) { height = 1.2; distance = 3.5; }
      else if (p.state === 'hidden') { height = 0.95; distance = 3.6; }
      else if (p.drawn) { distance = 4.6; height = 1.6; }
      if (p.state === 'dead') { distance = 6; height = 0.8; }
      if (p.sprinting && p.speed2d > 6) fovAdd = 7;
      if ((p.state === 'air' || p.state === 'leap') && p.vel.y < -8) fovAdd = 10;
      if (this.director.boss && !this.director.boss.dead) distance += 2;
      const lock = p.lockTarget && !p.lockTarget.dead ? p.lockTarget.pos : null;
      this.camera.update(this.state === 'playing' ? dt : dt * 0.25, focus, { distance, height, fovAdd, shoulder, lockPos: lock, follow: p.yaw });
      this.playerView.update(simDt, alpha);
    }
    const cam = this.renderer.camera;
    this.audio.setListener(cam.position, cam.getWorldDirection(new THREE.Vector3()));
    const flash = this.sky.update(dt, cam, this.realTime);
    if (this.closingSky) {
      this.closingSky = Math.max(0, this.closingSky - dt * 0.15);
      this.sky.vortexUniforms.uOpen.value = this.closingSky;
    }
    this.director.render(simDt, alpha);
    this.pickups.render(alpha);
    this.fx.update(simDt > 0 ? simDt : dt * 0.0, cam.position, this.focus);
    // sword trail: sample blade base/tip while attacking
    if (playing && p) {
      const sw = this.playerView.model.sword;
      if (sw.parent && this.playerView.swordDrawn) {
        const base = sw.localToWorld(new THREE.Vector3(0, 0, 0.2));
        const tip = sw.localToWorld(new THREE.Vector3(0, 0, 1.05));
        const active = p.state === 'attack' || p.state === 'counter' || p.state === 'glory';
        this.fx.trail.push(base, tip, active);
      }
    }
    // post-processing uniforms
    const g = this.renderer.grade.uniforms;
    this.sightK = damp(this.sightK, this.sightOn && this.state === 'playing' ? 1 : 0, 6, dt);
    g.uSight.value = this.sightK;
    this.renderer.xray.enabled = this.sightK > 0.02;
    this.renderer.xray.intensity = this.sightK;
    g.uTime.value = this.realTime;
    if (p) {
      const hurt = p.lastHitT !== undefined ? clamp(1 - (p.time - p.lastHitT) / 0.6, 0, 1) : 0;
      g.uDamage.value = hurt;
      g.uLowHealth.value = p.hp / p.maxHp < 0.3 && !p.dead ? 1 : 0;
      g.uDesat.value = damp(g.uDesat.value, p.dead ? 0.85 : 0, 2, dt);
    }
    this.lightning = Math.max(0, (this.lightning || 0) - dt * 3);
    g.uFlash.value = flash * 0.05;
    this.renderer.hemi.intensity = 1.2 + flash * 0.8;
    this.renderer.updateShadow(this.focus);
    this.renderer.render();
    if (this.state === 'playing' || this.state === 'paused') this.ui.update(dt);
    this.updateMusic();
    if (this.state === 'playing') this.updateAmbience();
  }
}

export { FIXED_DT };
