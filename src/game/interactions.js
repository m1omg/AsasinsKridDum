import * as THREE from 'three';
import { makeRng, clamp, angleDiff, yawTo } from '../core/math.js';
import { LAYER_XRAY_GOLD } from '../render/renderer.js';

// World interactions: loot chests, viewpoint synchronization + leap of faith,
// hiding in hay, striking Rift Hearts, collecting hidden Creed relics.

const LOOT_RNG = makeRng(1503);

export class Interactions {
  constructor(game) {
    this.game = game;
    const city = game.city;
    this.chests = city.chests.map((c, i) => this.makeChest(c, i));
    this.relics = city.relics.map((r, i) => this.makeRelic(r, i));
    this.time = 0;
  }

  makeChest(c, i) {
    const g = new THREE.Group();
    const mats = this.game.materials;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.55), mats.wood);
    body.position.y = 0.25;
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.5, -0.275);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.9, 10, 1, false, 0, Math.PI), mats.wood);
    lid.rotation.z = Math.PI / 2;
    lid.rotation.y = Math.PI / 2;
    lid.position.z = 0.275;
    lidPivot.add(lid);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.08, 0.6), mats.gold);
    band.position.y = 0.35;
    g.add(body, lidPivot, band);
    g.position.set(c.x, c.y, c.z);
    g.rotation.y = c.yaw;
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.layers.enable(LAYER_XRAY_GOLD); } });
    // vertex colors are expected by the wood/gold materials
    for (const m of [body, lid]) {
      const n = m.geometry.attributes.position.count;
      m.geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0.75), 3));
    }
    this.game.scene.add(g);
    this.game.collision.box(c.x - 0.5, c.y, c.z - 0.5, c.x + 0.5, c.y + 0.55, c.z + 0.5, { kind: 'chest', blocksSight: false, blocksCamera: false });
    const roll = LOOT_RNG();
    let loot;
    if (c.starter) loot = { tonic: 1, knives: 3, note: true };
    else if (c.where === 'rift' || c.where === 'loggia' || c.where === 'house' || roll < 0.42) loot = { rune: 1, knives: 2 };
    else if (roll < 0.7) loot = { tonic: 1, knives: 3 };
    else loot = { knives: 4, armor: 25 };
    return { id: 'c' + i, data: c, group: g, lid: lidPivot, open: false, openT: 0, loot };
  }

  makeRelic(r, i) {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshStandardMaterial({ color: 0xffd070, emissive: new THREE.Color(1, 0.7, 0.25), emissiveIntensity: 2.2, metalness: 0.6, roughness: 0.3 }));
    m.position.set(r.x, r.y, r.z);
    m.layers.enable(LAYER_XRAY_GOLD);
    this.game.scene.add(m);
    const light = { x: r.x, y: r.y + 0.5, z: r.z, color: 0xffc060, intensity: 1.2, distance: 6, flicker: 0.1 };
    this.game.city.lights.push(light);
    return { id: 'r' + i, mesh: m, taken: false, light, ...r };
  }

  /** Apply saved progress (opened chests, collected relics). */
  applyProgress(progress) {
    for (const c of this.chests) {
      c.open = !!progress.chests?.[c.id];
      c.lid.rotation.x = c.open ? -1.9 : 0;
      c.openT = c.open ? 1 : 0;
    }
    for (const r of this.relics) {
      r.taken = !!progress.relics?.[r.id];
      r.mesh.visible = !r.taken;
      r.light.intensity = r.taken ? 0 : 1.2;
    }
  }

  /** Best interaction prompt for the player (or null). */
  nearest(p) {
    const game = this.game;
    const st = p.state;
    const city = game.city;
    // viewpoint perch
    if (st === 'ground') {
      for (const vp of city.viewpoints) {
        const d = Math.hypot(p.pos.x - vp.perch.x, p.pos.z - vp.perch.z);
        if (d < 1.1 && Math.abs(p.pos.y - vp.perch.y) < 0.7) {
          if (!game.progress.viewpoints[vp.id]) return { kind: 'sync', label: 'Synchronize', run: () => game.synchronize(vp) };
          return { kind: 'leap', label: 'Leap of Faith', run: () => p.leapOfFaith(vp) };
        }
      }
    }
    if (st !== 'ground') return null;
    // rift heart
    for (const r of city.rifts) {
      if (r.closed || r.active) continue;
      const d = Math.hypot(p.pos.x - r.heart.x, p.pos.z - r.heart.z);
      if (d < 2.6 && Math.abs(p.pos.y - r.heart.y) < 2) return { kind: 'rift', label: 'Destroy the Rift Heart', run: () => game.strikeRiftHeart(r) };
    }
    // chests
    for (const c of this.chests) {
      if (c.open) continue;
      const d = Math.hypot(p.pos.x - c.data.x, p.pos.z - c.data.z);
      if (d < 1.7 && Math.abs(p.pos.y - c.data.y) < 1.2) return { kind: 'chest', label: 'Open Chest', run: () => this.openChest(c) };
    }
    // hay
    const hay = city.nearestHay(p.pos.x, p.pos.z, 1.9);
    if (hay && p.pos.y < 1.2) return { kind: 'hay', label: 'Hide in Hay', run: () => p.enterHay(hay) };
    return null;
  }

  openChest(c) {
    const game = this.game;
    const p = game.player;
    c.open = true;
    game.progress.chests[c.id] = true;
    game.audio?.play('chestOpen', { pos: c.group.position, volume: 1 });
    const L = c.loot;
    const parts = [];
    if (L.rune) { game.progress.runes += L.rune; parts.push(`${L.rune} Ashen Rune`); game.audio?.play('pickupRune', { volume: 0.8 }); }
    if (L.knives) { p.knives = Math.min(p.maxKnives, p.knives + L.knives); parts.push(`${L.knives} knives`); }
    if (L.tonic) { p.tonics = Math.min(p.maxTonics, p.tonics + L.tonic); parts.push('Blood Tonic'); }
    if (L.armor) { p.armor = Math.min(p.maxArmor, p.armor + L.armor); parts.push(`${L.armor} armor`); }
    game.ui?.notify('Chest: ' + parts.join(', '), 'loot');
    if (L.note) game.ui?.hint('A rune-sealed tonic from the Brotherhood. Press H to drink it when wounded.', 7);
    game.fx.magicSwirl(c.data.x, c.data.y + 0.6, c.data.z, [2.4, 1.8, 0.6], 25, 0.5);
    game.save();
  }

  update(dt) {
    this.time += dt;
    const game = this.game;
    const p = game.player;
    for (const c of this.chests) {
      if (c.open && c.openT < 1) {
        c.openT = Math.min(1, c.openT + dt * 2.5);
        c.lid.rotation.x = -1.9 * (1 - Math.pow(1 - c.openT, 3));
      }
    }
    for (const r of this.relics) {
      if (r.taken) continue;
      r.mesh.rotation.y += dt * 1.5;
      r.mesh.position.y = r.y + Math.sin(this.time * 2 + r.x) * 0.15;
      if (Math.random() < dt * 6) game.fx.add.emit(r.x + (Math.random() - 0.5) * 0.5, r.y, r.z + (Math.random() - 0.5) * 0.5, 0, 0.6, 0, 1, 0.06, 0.01, [2.5, 1.8, 0.6, 1], [1, 0.5, 0.1, 0], 0, 0);
      if (!p.dead && Math.hypot(p.pos.x - r.x, p.pos.y + 1 - r.y, p.pos.z - r.z) < 1.4) {
        r.taken = true;
        r.mesh.visible = false;
        r.light.intensity = 0;
        game.progress.relics[r.id] = true;
        const n = Object.keys(game.progress.relics).length;
        game.audio?.play('relic', { volume: 1 });
        game.fx.magicSwirl(r.x, r.y, r.z, [2.5, 1.8, 0.6], 40, 0.8);
        game.ui?.notify(`Creed Relic ${n}/${this.relics.length}`, 'relic');
        if (n === this.relics.length) { game.progress.runes += 3; game.ui?.notify('All relics found: +3 Ashen Runes', 'relic'); }
        else if (n % 3 === 0) { game.progress.runes += 1; game.ui?.notify('+1 Ashen Rune', 'loot'); }
        game.save();
      }
    }
    void clamp; void angleDiff; void yawTo;
  }
}

// ---------------------------------------------------------------- snares
const SNARE_FS = /* glsl */ `
uniform float uTime, uLife;
varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float ring = smoothstep(0.03, 0.0, abs(r - 0.93)) + smoothstep(0.02, 0.0, abs(r - 0.8)) * 0.8;
  float runes = step(0.82, r) * step(r, 0.91) * step(0.55, fract(a * 3.0 + uTime * 0.5)) * step(fract(a * 12.0 - uTime), 0.6);
  float inner = smoothstep(0.8, 0.0, r) * 0.08 * (0.6 + 0.4 * sin(uTime * 4.0 + r * 10.0));
  float v = (ring + runes * 0.9 + inner) * uLife;
  gl_FragColor = vec4(vec3(0.7, 0.35, 1.0) * v * 2.2, v);
}`;

export class Snares {
  constructor(game) {
    this.game = game;
    this.list = [];
  }

  add(x, y, z, r, dur) {
    const g = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLife: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: SNARE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    g.rotation.x = -Math.PI / 2;
    g.position.set(x, y + 0.06, z);
    this.game.scene.add(g);
    if (this.list.length >= 2) this.remove(this.list[0]);
    this.list.push({ x, y, z, r, t: 0, dur, mesh: g });
  }

  remove(s) {
    this.game.scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mesh.material.dispose();
    this.list.splice(this.list.indexOf(s), 1);
  }

  update(dt) {
    for (const s of [...this.list]) {
      s.t += dt;
      const life = clamp(Math.min(s.t / 0.3, (s.dur - s.t) / 0.8), 0, 1);
      s.mesh.material.uniforms.uTime.value = s.t;
      s.mesh.material.uniforms.uLife.value = life;
      for (const e of this.game.director.enemies) {
        if (e.dead) continue;
        const d = Math.hypot(e.pos.x - s.x, e.pos.z - s.z);
        if (d > s.r + e.radius) continue;
        e.slowed = Math.max(e.slowed, 0.3);
        if (e.def.flies) {
          if (e.groundedT <= 0) this.game.fx.magicSwirl(e.pos.x, e.pos.y, e.pos.z, [1.4, 0.6, 2.4], 20, 0.8);
          e.groundedT = Math.max(e.groundedT, 4);
        }
        if (e.def.boss && Math.random() < dt) e.takeHit(6, { type: 'magic', poise: 0, dot: true, silent: true });
      }
      if (s.t >= s.dur) this.remove(s);
    }
  }

  clear() { for (const s of [...this.list]) this.remove(s); }
}
