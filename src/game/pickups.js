import * as THREE from 'three';
import { rand, clamp } from '../core/math.js';

// Doom-style resource orbs: health (glory kills), armor shards (burning
// kills), crossbow bolts (assassinations). They pop out, bounce, then get
// magnetised to the player. An orb for a resource that's already full
// restores stamina instead, so every orb is worth picking up.

const STAMINA_FROM_ORB = 15;

const KINDS = {
  health: { color: new THREE.Color(0.35, 2.6, 0.5), size: 0.16, value: 10 },
  armor: { color: new THREE.Color(2.6, 1.9, 0.3), size: 0.13, value: 6 },
  bolt: { color: new THREE.Color(1.6, 1.7, 2.2), size: 0.12, value: 2 },
};

export class Pickups {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.meshes = {};
    const geo = new THREE.IcosahedronGeometry(1, 1);
    for (const k in KINDS) {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: KINDS[k].color, toneMapped: false }), 128);
      m.count = 0;
      m.frustumCulled = false;
      game.scene.add(m);
      this.meshes[k] = m;
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  spawn(kind, x, y, z, count = 1, value = null) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1.5, 3.5);
      this.list.push({
        kind, value: value ?? KINDS[kind].value,
        pos: new THREE.Vector3(x, y + 0.6, z), prev: new THREE.Vector3(x, y + 0.6, z),
        vel: new THREE.Vector3(Math.cos(a) * s, rand(3, 6), Math.sin(a) * s),
        age: 0, life: 22,
      });
    }
  }

  update(dt) {
    const p = this.game.player;
    const col = this.game.collision;
    for (const o of this.list) {
      o.prev.copy(o.pos);
      o.age += dt;
      o.life -= dt;
      const dx = p.pos.x - o.pos.x, dy = p.pos.y + 1.0 - o.pos.y, dz = p.pos.z - o.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (o.age > 0.45 && d < 6 && !p.dead) {
        // magnet
        const sp = clamp(14 - d * 1.5, 7, 16);
        o.vel.set(dx / d * sp, dy / d * sp, dz / d * sp);
        o.pos.addScaledVector(o.vel, dt);
        if (d < 0.7) { this.collect(o); continue; }
      } else {
        o.vel.y -= 16 * dt;
        o.vel.x *= Math.exp(-1.5 * dt);
        o.vel.z *= Math.exp(-1.5 * dt);
        o.pos.addScaledVector(o.vel, dt);
        const g = col.groundAt(o.pos.x, o.pos.z, 0.1, o.pos.y + 0.3);
        if (o.pos.y < g.y + 0.25) {
          o.pos.y = g.y + 0.25;
          o.vel.y = Math.abs(o.vel.y) * 0.35;
          if (o.vel.y < 0.6) o.vel.y = 0;
        }
      }
      if (o.life <= 0) o.dead = true;
    }
    this.list = this.list.filter((o) => !o.dead);
  }

  wanted(kind) {
    const p = this.game.player;
    if (kind === 'health') return p.hp < p.maxHp;
    if (kind === 'armor') return p.armor < p.maxArmor;
    if (kind === 'bolt') return p.bolts < p.maxBolts;
    return true;
  }

  collect(o) {
    o.dead = true;
    const game = this.game;
    const p = game.player;
    const full = !this.wanted(o.kind);
    if (full) {
      // already full: the orb restores stamina instead
      p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_FROM_ORB);
      game.audio?.play('pickupRune', { volume: 0.3, pitch: rand(1.3, 1.5) });
    } else if (o.kind === 'health') { p.heal(o.value); game.audio?.play('pickupHealth', { volume: 0.5, pitch: rand(0.95, 1.1) }); }
    else if (o.kind === 'armor') { p.armor = Math.min(p.maxArmor, p.armor + o.value); game.audio?.play('pickupArmor', { volume: 0.5, pitch: rand(0.95, 1.1) }); }
    else if (o.kind === 'bolt') { p.bolts = Math.min(p.maxBolts, p.bolts + o.value); game.audio?.play('pickupKnife', { volume: 0.6 }); }
    if (!game.orbHinted) {
      game.orbHinted = true;
      game.ui?.hint('<b>Orbs:</b> green heal you, gold give armor and silver give crossbow bolts. Walk near one to collect it. If you are already full, it restores stamina instead.', 9);
    }
    game.events.emit('pickup', full ? 'stamina' : o.kind, full ? STAMINA_FROM_ORB : o.value);
  }

  render(alpha) {
    const counts = {};
    for (const k in this.meshes) counts[k] = 0;
    const t = this.game.realTime;
    for (const o of this.list) {
      const m = this.meshes[o.kind];
      const i = counts[o.kind]++;
      if (i >= 128) continue;
      const pos = this._s.lerpVectors(o.prev, o.pos, alpha);
      const s = KINDS[o.kind].size * (1 + Math.sin(t * 8 + o.age * 3) * 0.15) * (o.life < 3 ? o.life / 3 : 1);
      this._m.compose(pos, this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 2 + o.age), new THREE.Vector3(s, s, s));
      m.setMatrixAt(i, this._m);
    }
    for (const k in this.meshes) {
      const m = this.meshes[k];
      m.count = Math.min(128, counts[k]);
      m.instanceMatrix.needsUpdate = true;
    }
    // a soft glow light at the nearest orb cluster
    if (this.list.length) {
      const o = this.list[0];
      this.game.fx.attachedLight({ x: o.pos.x, y: o.pos.y, z: o.pos.z, color: o.kind === 'health' ? 0x40ff60 : o.kind === 'armor' ? 0xffc040 : 0xa0c0ff, intensity: 1.2, distance: 5 });
    }
  }

  clear() { this.list = []; }
}
