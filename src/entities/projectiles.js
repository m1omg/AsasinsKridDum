import * as THREE from 'three';
import { clamp, rand, angleDiff } from '../core/math.js';
import { sightFilter } from '../world/collision.js';

// Projectiles & hazard volumes. Logic in fixed ticks; meshes interpolated.

const _v = new THREE.Vector3();
const geoSphere = new THREE.SphereGeometry(1, 12, 8);
// crossbow bolt: shaft along +Z (the tip at the front), steel head, fletching
const geoBolt = (() => {
  const shaft = new THREE.CylinderGeometry(0.009, 0.009, 0.38, 6);
  shaft.rotateX(Math.PI / 2);
  const head = new THREE.ConeGeometry(0.02, 0.07, 6);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, 0.22);
  const fin1 = new THREE.BoxGeometry(0.05, 0.002, 0.07);
  fin1.translate(0, 0, -0.16);
  const fin2 = new THREE.BoxGeometry(0.002, 0.05, 0.07);
  fin2.translate(0, 0, -0.16);
  const parts = [shaft, head, fin1, fin2].map((g) => g.toNonIndexed());
  const pos = [], nrm = [];
  for (const g of parts) { pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
})();

function distPointSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz || 1;
  const t = clamp((apx * abx + apy * aby + apz * abz) / ab2, 0, 1);
  const dx = ax + abx * t - px, dy = ay + aby * t - py, dz = az + abz * t - pz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class Projectiles {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.hazards = []; // beams, breath, meteors, shockwaves
    this.matFire = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.3, 0.35), toneMapped: false });
    this.matOrb = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 1.6), toneMapped: false });
    this.matBolt = new THREE.MeshStandardMaterial({ color: 0x9a8a6a, metalness: 0.35, roughness: 0.45, emissive: new THREE.Color(0.5, 0.32, 0.12), emissiveIntensity: 0.6 });
    this.stuck = []; // bolts left in walls
    this.matBeam = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.5, 0.2), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.matWarn = new THREE.MeshBasicMaterial({ color: 0xff2000, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    this.matRing = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.9, 0.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  }

  get scene() { return this.game.scene; }

  spawn(p) {
    p.prev = p.pos.clone();
    p.life = p.life ?? 4;
    p.age = 0;
    this.list.push(p);
    return p;
  }

  // ------------------------------------------------------------- creators
  fireball(from, target, dmg, owner) {
    const pos = new THREE.Vector3(from.x, from.y, from.z);
    const tp = new THREE.Vector3(target.pos.x, target.pos.y + 1.1, target.pos.z);
    // lead the target a little
    tp.x += (target.vel?.x || 0) * 0.35;
    tp.z += (target.vel?.z || 0) * 0.35;
    const vel = tp.sub(pos).normalize().multiplyScalar(16);
    const mesh = new THREE.Mesh(geoSphere, this.matFire);
    mesh.scale.setScalar(0.28);
    this.scene.add(mesh);
    this.game.audio?.play('fireballCast', { pos, volume: 0.7 });
    return this.spawn({ kind: 'fireball', pos, vel, dmg, owner, radius: 0.32, homing: 1.1, hostile: true, mesh, parryable: true, splash: 1.6 });
  }

  orb(from, target, dmg, owner, spread = 0) {
    const pos = new THREE.Vector3(from.x, from.y, from.z);
    const tp = new THREE.Vector3(target.pos.x, target.pos.y + 1.1, target.pos.z);
    const vel = tp.sub(pos).normalize();
    vel.applyAxisAngle(new THREE.Vector3(0, 1, 0), spread).multiplyScalar(10.5);
    const mesh = new THREE.Mesh(geoSphere, this.matOrb);
    mesh.scale.setScalar(0.22);
    this.scene.add(mesh);
    return this.spawn({ kind: 'orb', pos, vel, dmg, owner, radius: 0.28, homing: 1.8, hostile: true, mesh, parryable: true, life: 5 });
  }

  /** Crossbow bolt; with a target it steers onto it (aim assist). */
  bolt(from, dir, dmg, target = null) {
    const pos = new THREE.Vector3(from.x, from.y, from.z);
    const vel = dir.clone().normalize().multiplyScalar(62);
    const mesh = new THREE.Mesh(geoBolt, this.matBolt);
    mesh.castShadow = false;
    this.scene.add(mesh);
    return this.spawn({ kind: 'bolt', pos, vel, dmg, owner: 'player', radius: 0.14, hostile: false, mesh, gravity: 1.2, life: 1.6, target, seek: 9 });
  }

  beam(owner, a) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 8, 1, true), this.matBeam);
    mesh.geometry.translate(0, 0.5, 0);
    mesh.geometry.rotateX(Math.PI / 2);
    this.scene.add(mesh);
    const p = this.game.player.pos;
    const h = { kind: 'beam', owner, dmg: a.dmg, t: 0, dur: a.active, mesh, aim: new THREE.Vector3(p.x, p.y + 1, p.z), tick: 0 };
    this.hazards.push(h);
    h.loop = this.game.audio?.loop('beamLoop', { pos: owner.pos, volume: 0.9 });
    return h;
  }

  breath(owner, a) {
    const h = { kind: 'breath', owner, dmg: a.dmg, t: 0, dur: a.active, tick: 0 };
    this.hazards.push(h);
    this.game.audio?.play('sigilFire', { pos: owner.pos, volume: 1, pitch: 0.6 });
    return h;
  }

  meteors(owner, a) {
    const p = this.game.player.pos;
    for (let i = 0; i < 9; i++) {
      const ang = Math.random() * Math.PI * 2, r = i === 0 ? 0 : rand(2, 9);
      const x = p.x + Math.cos(ang) * r + (this.game.player.vel.x || 0) * 0.6 * (i === 0 ? 1 : 0);
      const z = p.z + Math.sin(ang) * r + (this.game.player.vel.z || 0) * 0.6 * (i === 0 ? 1 : 0);
      const g = this.game.collision.groundAt(x, z, 0.3, 40);
      const warn = new THREE.Mesh(new THREE.RingGeometry(0.2, 2.4, 32), this.matWarn.clone());
      warn.rotation.x = -Math.PI / 2;
      warn.position.set(x, g.y + 0.06, z);
      this.scene.add(warn);
      this.hazards.push({ kind: 'meteor', owner, dmg: a.dmg, t: -i * 0.16, dur: 1.5, x, y: g.y, z, warn, fell: false, rock: null });
    }
  }

  shockwave(x, y, z, dmg, maxR = 14) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), this.matRing.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + 0.15, z);
    this.scene.add(mesh);
    this.hazards.push({ kind: 'shock', x, y, z, r: 1, maxR, dmg, mesh, hit: false, t: 0 });
  }

  // ------------------------------------------------------------- update
  update(dt) {
    const game = this.game;
    const col = game.collision;
    const player = game.player;
    for (const p of this.list) {
      p.prev.copy(p.pos);
      p.age += dt;
      p.life -= dt;
      // homing
      if (p.homing && p.hostile && !p.reflected) {
        const tx = player.pos.x - p.pos.x, ty = player.pos.y + 1.1 - p.pos.y, tz = player.pos.z - p.pos.z;
        const sp = p.vel.length();
        const want = _v.set(tx, ty, tz).normalize().multiplyScalar(sp);
        const k = Math.min(1, p.homing * dt);
        p.vel.lerp(want, k).setLength(sp);
      }
      if (p.reflected && p.owner && !p.owner.dead) {
        const o = p.owner;
        const sp = p.vel.length();
        const want = _v.set(o.pos.x - p.pos.x, o.pos.y + 1 - p.pos.y, o.pos.z - p.pos.z).normalize().multiplyScalar(sp);
        p.vel.lerp(want, Math.min(1, 4 * dt)).setLength(sp);
      }
      if (p.seek && p.target && !p.target.dead) {
        const t = p.target, sp = p.vel.length();
        const ty = t.pos.y + (t.def.flies ? 0 : t.def.height * (t.def.modelScale || 1) * 0.62);
        const want = _v.set(t.pos.x - p.pos.x, ty - p.pos.y, t.pos.z - p.pos.z).normalize().multiplyScalar(sp);
        p.vel.lerp(want, Math.min(1, p.seek * dt)).setLength(sp);
      } else if (p.gravity) p.vel.y -= p.gravity * dt;
      const step = p.vel.length() * dt;
      const dir = _v.copy(p.vel).normalize();
      // world hit
      const h = col.raycast(p.pos.x, p.pos.y, p.pos.z, dir.x, dir.y, dir.z, step + p.radius, sightFilter);
      p.pos.addScaledVector(p.vel, dt);
      if (h) {
        p.pos.set(h.x - dir.x * 0.05, h.y - dir.y * 0.05, h.z - dir.z * 0.05);
        this.impact(p, null);
        continue;
      }
      // hostile -> player
      if (p.hostile && !p.dead) {
        const d = distPointSegment(p.pos.x, p.pos.y, p.pos.z, player.pos.x, player.pos.y + 0.3, player.pos.z, player.pos.x, player.pos.y + 1.6, player.pos.z);
        if (d < p.radius + 0.35 && !player.dead && player.visible) {
          const res = player.receiveHit ? player.receiveHit({ name: p.kind, dmg: p.dmg, projectile: p, parryable: p.parryable, ranged: true }, p.owner) : 'hit';
          if (res === 'parried' && p.parryable) { this.reflect(p); continue; }
          if (res === 'dodged') continue;
          this.impact(p, 'player');
          continue;
        }
      }
      // friendly -> demons (swept along this tick's path, so fast bolts can't skip a body)
      if (!p.hostile && !p.dead) {
        const n = Math.max(1, Math.ceil(step / 0.3));
        for (let k = 1; k <= n && !p.dead; k++) {
          const f = k / n;
          const sx = p.prev.x + (p.pos.x - p.prev.x) * f, sy = p.prev.y + (p.pos.y - p.prev.y) * f, sz = p.prev.z + (p.pos.z - p.prev.z) * f;
          for (const e of game.director.enemies) {
            if (e.dead || e.state === 'spawn') continue;
            const h = e.def.height * (e.def.modelScale || 1);
            const ey0 = e.pos.y + (e.def.flies ? -0.6 : 0), ey1 = e.pos.y + (e.def.flies ? 0.6 : h);
            const d = distPointSegment(sx, sy, sz, e.pos.x, ey0, e.pos.z, e.pos.x, ey1, e.pos.z);
            if (d < p.radius + e.radius) {
              p.pos.set(sx, sy, sz);
              this.hitEnemy(p, e);
              break;
            }
          }
        }
      }
      if (p.life <= 0 && !p.dead) this.impact(p, null, true);
    }
    for (const p of this.list) if (p.dead && p.mesh) { this.scene.remove(p.mesh); p.mesh = null; }
    for (const b of this.stuck) if ((b.t -= dt) <= 0) this.scene.remove(b.mesh);
    if (this.stuck.length && this.stuck[0].t <= 0) this.stuck = this.stuck.filter((b) => b.t > 0);
    this.list = this.list.filter((p) => !p.dead);
    this.updateHazards(dt);
  }

  reflect(p) {
    p.hostile = false;
    p.reflected = true;
    p.vel.multiplyScalar(-1.4);
    p.dmg = p.kind === 'fireball' ? 60 : 40;
    p.life = 3;
    this.game.fx?.sparks(p.pos.x, p.pos.y, p.pos.z, 24, [1, 0.7, 0.3], 8);
    this.game.audio?.play('parry', { pos: p.pos, volume: 1 });
    this.game.events.emit('reflected', p);
  }

  hitEnemy(p, e) {
    const dx = p.vel.x, dz = p.vel.z, l = Math.hypot(dx, dz) || 1;
    if (p.kind === 'bolt') {
      // unaware lesser demons die outright (AC style); unaware others take double
      const unaware = !e.alerted;
      const instakill = unaware && (e.type === 'thrall' || e.type === 'imp');
      const dmg = instakill ? e.hp + 1 : p.dmg * (unaware ? 2 : 1);
      e.takeHit(dmg, { type: 'pierce', poise: 25, dirX: dx / l, dirZ: dz / l, source: 'player', knockback: 1, killKind: 'bolt', stagger: e.type === 'imp' || e.type === 'thrall' });
      // a bolt knocks a Gazer out of the air: it crawls on the ground, open to the sword
      if (!e.dead && e.def.flies) {
        if (e.groundedT <= 0) this.game.fx?.magicSwirl(e.pos.x, e.pos.y, e.pos.z, [2.4, 1.6, 0.6], 18, 0.6);
        e.groundedT = Math.max(e.groundedT, 6);
        e.stagger?.(0.7);
      }
      this.game.fx?.blood(p.pos.x, p.pos.y, p.pos.z, dx / l, dz / l, 12, 0.8);
      this.game.audio?.play('boltHit', { pos: p.pos, volume: 0.9 });
      this.game.events.emit('boltHit', e);
      p.dead = true;
      return;
    }
    e.takeHit(p.dmg, { type: 'fire', poise: 40, dirX: dx / l, dirZ: dz / l, source: 'player', knockback: 3, stagger: true });
    this.impact(p, 'enemy');
  }

  impact(p, what, fizzle = false) {
    p.dead = true;
    const fx = this.game.fx;
    if (p.kind === 'fireball') {
      fx?.explosion(p.pos.x, p.pos.y, p.pos.z, fizzle ? 0.4 : 0.7);
      this.game.audio?.play('explosion', { pos: p.pos, volume: 0.7 });
      // splash damage to the player if near (when it hit the world)
      if (what === null && p.hostile && p.splash) {
        const pl = this.game.player;
        const d = Math.hypot(pl.pos.x - p.pos.x, pl.pos.y + 0.9 - p.pos.y, pl.pos.z - p.pos.z);
        if (d < p.splash) pl.receiveHit?.({ name: 'splash', dmg: p.dmg * 0.5, ranged: true, unblockable: true, splash: true }, p.owner);
      }
      if (p.reflected) {
        for (const e of this.game.director.enemies) {
          if (e.dead) continue;
          const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
          if (d < 2.5) e.takeHit(20, { type: 'fire', poise: 10, source: 'player' });
        }
      }
    } else if (p.kind === 'orb') {
      fx?.sparks(p.pos.x, p.pos.y, p.pos.z, 14, [1, 0.3, 0.9], 5);
    } else if (p.kind === 'bolt') {
      fx?.sparks(p.pos.x, p.pos.y, p.pos.z, 6, [1, 0.9, 0.7], 3);
      if (!fizzle) {
        this.game.audio?.play('boltHit', { pos: p.pos, volume: 0.5, pitch: 1.4 });
        // leave it stuck in the wall for a while
        if (what === null && p.mesh) {
          p.mesh.position.copy(p.pos);
          p.mesh.lookAt(p.pos.x + p.vel.x, p.pos.y + p.vel.y, p.pos.z + p.vel.z);
          this.stuck.push({ mesh: p.mesh, t: 6 });
          if (this.stuck.length > 12) this.scene.remove(this.stuck.shift().mesh);
          p.mesh = null;
        }
      }
    }
  }

  updateHazards(dt) {
    const game = this.game;
    const player = game.player;
    const col = game.collision;
    for (const h of this.hazards) {
      h.t += dt;
      if (h.kind === 'beam') {
        const o = h.owner;
        if (o.dead || o.state !== 'attack') { h.done = true; continue; }
        const ex = o.pos.x + Math.sin(o.yaw) * 0.6, ey = o.pos.y + 0.05, ez = o.pos.z + Math.cos(o.yaw) * 0.6;
        // aim slowly follows the player
        const tx = player.pos.x, ty = player.pos.y + 1.0, tz = player.pos.z;
        const k = Math.min(1, 1.5 * dt);
        h.aim.x += (tx - h.aim.x) * k; h.aim.y += (ty - h.aim.y) * k; h.aim.z += (tz - h.aim.z) * k;
        let dx = h.aim.x - ex, dy = h.aim.y - ey, dz = h.aim.z - ez;
        const L = Math.hypot(dx, dy, dz) || 1;
        dx /= L; dy /= L; dz /= L;
        const ray = col.raycast(ex, ey, ez, dx, dy, dz, 40, sightFilter);
        const len = ray ? ray.t : 40;
        h.mesh.position.set(ex, ey, ez);
        h.mesh.lookAt(ex + dx, ey + dy, ez + dz);
        h.mesh.scale.set(1 + Math.sin(h.t * 40) * 0.25, 1 + Math.sin(h.t * 40) * 0.25, len);
        h.loop?.setPos?.(o.pos);
        if (ray) game.fx?.sparks(ray.x, ray.y, ray.z, 2, [1, 0.5, 0.2], 4);
        game.fx?.attachedLight({ x: ex + dx * 2, y: ey + dy * 2, z: ez + dz * 2, color: 0xff4020, intensity: 3, distance: 10 });
        h.tick -= dt;
        const d = distPointSegment(player.pos.x, player.pos.y + 1, player.pos.z, ex, ey, ez, ex + dx * len, ey + dy * len, ez + dz * len);
        if (d < 0.7 && h.tick <= 0) {
          h.tick = 0.2;
          player.receiveHit?.({ name: 'beam', dmg: h.dmg * 0.2, ranged: true, unblockable: true, beam: true }, o);
        }
        if (h.t > h.dur) h.done = true;
      } else if (h.kind === 'breath') {
        const o = h.owner;
        if (o.dead) { h.done = true; continue; }
        const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
        const hx = o.pos.x + fx * 2.2, hy = o.pos.y + o.def.height * 0.8, hz = o.pos.z + fz * 2.2;
        game.fx?.fireBurst(hx, hy - 1.5, hz, fx, fz, 0.38, 10, 18);
        h.tick -= dt;
        const px = player.pos.x - o.pos.x, pz = player.pos.z - o.pos.z;
        const pd = Math.hypot(px, pz);
        const ang = Math.abs(angleDiff(o.yaw, Math.atan2(px, pz)));
        if (pd < 14 && ang < 0.42 && player.pos.y - o.pos.y < 4 && h.tick <= 0) {
          h.tick = 0.25;
          player.receiveHit?.({ name: 'breath', dmg: h.dmg * 0.25, ranged: true, unblockable: false, fire: true }, o);
        }
        if (h.t > h.dur) h.done = true;
      } else if (h.kind === 'meteor') {
        if (h.t < 0) { h.warn.visible = false; continue; }
        h.warn.visible = true;
        const u = clamp(h.t / 1.2, 0, 1);
        h.warn.scale.setScalar(0.3 + u * 0.7);
        h.warn.material.opacity = 0.25 + 0.5 * u * (0.6 + 0.4 * Math.sin(h.t * 20));
        if (h.t > 0.7 && !h.rock) {
          h.rock = new THREE.Mesh(geoSphere, this.matFire);
          h.rock.scale.setScalar(0.7);
          this.scene.add(h.rock);
        }
        if (h.rock) {
          const f = clamp((h.t - 0.7) / 0.5, 0, 1);
          h.rock.position.set(h.x + (1 - f) * 6, h.y + (1 - f) * 40, h.z + (1 - f) * 3);
          game.fx?.add.emit(h.rock.position.x, h.rock.position.y, h.rock.position.z, 0, 0, 0, 0.4, 0.8, 0.1, [3, 1.2, 0.3, 1], [0.6, 0.1, 0, 0], 0, 0);
        }
        if (h.t >= 1.2 && !h.fell) {
          h.fell = true;
          game.fx?.explosion(h.x, h.y + 0.3, h.z, 1.1);
          game.audio?.play('explosion', { pos: { x: h.x, y: h.y, z: h.z }, volume: 0.9 });
          game.camera?.addShake(0.25);
          const d = Math.hypot(player.pos.x - h.x, player.pos.z - h.z);
          if (d < 2.6 && player.pos.y - h.y < 2.5) player.receiveHit?.({ name: 'meteor', dmg: h.dmg, ranged: true, unblockable: true, knockdown: true }, h.owner);
          for (const e of game.director.enemies) {
            if (e.dead || e.def.boss) continue;
            if (Math.hypot(e.pos.x - h.x, e.pos.z - h.z) < 2.6) e.takeHit(30, { type: 'fire', poise: 30 });
          }
        }
        if (h.t > 1.4) h.done = true;
      } else if (h.kind === 'shock') {
        h.r += dt * 11;
        h.mesh.scale.setScalar(h.r);
        h.mesh.material.opacity = 0.9 * (1 - h.r / h.maxR);
        const d = Math.hypot(player.pos.x - h.x, player.pos.z - h.z);
        if (!h.hit && Math.abs(d - h.r) < 0.7 && player.grounded && player.pos.y - h.y < 0.6) {
          h.hit = true;
          player.receiveHit?.({ name: 'shock', dmg: h.dmg, ranged: true, unblockable: true, knockdown: true }, null);
        }
        if (h.r >= h.maxR) h.done = true;
      }
    }
    for (const h of this.hazards) {
      if (!h.done) continue;
      if (h.mesh) { this.scene.remove(h.mesh); h.mesh.geometry.dispose(); if (h.mesh.material !== this.matBeam) h.mesh.material.dispose?.(); }
      if (h.warn) { this.scene.remove(h.warn); h.warn.geometry.dispose(); h.warn.material.dispose(); }
      if (h.rock) this.scene.remove(h.rock);
      h.loop?.stop?.();
    }
    this.hazards = this.hazards.filter((h) => !h.done);
  }

  /** Interpolated mesh placement + trails (render frame). */
  render(alpha, dt) {
    const fx = this.game.fx;
    for (const p of this.list) {
      if (!p.mesh) continue;
      p.mesh.position.lerpVectors(p.prev, p.pos, alpha);
      if (p.kind === 'bolt') {
        p.mesh.lookAt(p.mesh.position.x + p.vel.x, p.mesh.position.y + p.vel.y, p.mesh.position.z + p.vel.z);
        continue;
      }
      const s = p.mesh.position;
      const k = p.kind === 'fireball' ? [3, 1.3, 0.35, 1] : [2.2, 0.4, 1.6, 1];
      const n = Math.ceil(dt * 90);
      for (let i = 0; i < n; i++) fx?.add.emit(s.x + rand(-0.1, 0.1), s.y + rand(-0.1, 0.1), s.z + rand(-0.1, 0.1), rand(-0.5, 0.5), rand(0, 0.8), rand(-0.5, 0.5), rand(0.2, 0.4), p.kind === 'fireball' ? 0.45 : 0.32, 0.05, k, [k[0] * 0.2, k[1] * 0.1, k[2] * 0.1, 0], -0.5, 1);
      fx?.attachedLight({ x: s.x, y: s.y, z: s.z, color: p.kind === 'fireball' ? 0xff6020 : 0xff40c0, intensity: 2.5, distance: 7 });
    }
  }

  clear() {
    for (const p of this.list) if (p.mesh) this.scene.remove(p.mesh);
    this.list = [];
    for (const b of this.stuck) this.scene.remove(b.mesh);
    this.stuck = [];
    for (const h of this.hazards) h.done = true;
    this.updateHazards(0);
  }
}
