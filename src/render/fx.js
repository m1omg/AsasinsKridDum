import * as THREE from 'three';
import { clamp, rand } from '../core/math.js';

// Visual effects: CPU-simulated point-sprite particles (additive + alpha),
// ambient embers, city fire emitters, a pooled set of dynamic point lights,
// and sword trails. Everything here is purely cosmetic and advanced with the
// rendered frame dt (exponential decay -> refresh-rate independent).

const VS = /* glsl */ `
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
uniform float uScale;
void main(){
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * uScale / max(0.1, -mv.z), 0.0, 512.0);
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, uSoft, r);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

class Particles {
  constructor(max, additive, soft = 0.0) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 4);
    this.c1 = new Float32Array(max * 4);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('pcolor', this.aCol);
    g.setAttribute('size', this.aSize);
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 400 }, uSoft: { value: soft } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !additive,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, c0, c1, grav = 0, drag = 0) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max); // overwrite a random one
    const i3 = i * 3, i4 = i * 4;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.c0[i4] = c0[0]; this.c0[i4 + 1] = c0[1]; this.c0[i4 + 2] = c0[2]; this.c0[i4 + 3] = c0[3];
    this.c1[i4] = c1[0]; this.c1[i4 + 1] = c1[1]; this.c1[i4 + 2] = c1[2]; this.c1[i4 + 3] = c1[3];
    this.grav[i] = grav; this.drag[i] = drag;
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) this._move(n, i);
        i--;
        continue;
      }
      const i3 = i * 3, i4 = i * 4;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt; this.vel[i3 + 2] *= dr;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.grav[i] > 0 && this.pos[i3 + 1] < 0.02) { this.pos[i3 + 1] = 0.02; this.vel[i3 + 1] *= -0.25; this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6; }
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      for (let k = 0; k < 4; k++) this.col[i4 + k] = this.c0[i4 + k] + (this.c1[i4 + k] - this.c0[i4 + k]) * t;
    }
    this.count = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    if (n > 0) {
      this.aPos.addUpdateRange(0, n * 3); this.aPos.needsUpdate = true;
      this.aCol.addUpdateRange(0, n * 4); this.aCol.needsUpdate = true;
      this.aSize.addUpdateRange(0, n); this.aSize.needsUpdate = true;
    }
  }

  _move(from, to) {
    const f3 = from * 3, t3 = to * 3, f4 = from * 4, t4 = to * 4;
    for (let k = 0; k < 3; k++) { this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k]; }
    for (let k = 0; k < 4; k++) { this.col[t4 + k] = this.col[f4 + k]; this.c0[t4 + k] = this.c0[f4 + k]; this.c1[t4 + k] = this.c1[f4 + k]; }
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size[to] = this.size[from]; this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
  }
}

// --------------------------------------------------------------- trails
class SwordTrail {
  constructor(color = 0xffc080) {
    this.n = 14;
    this.base = [];
    this.tip = [];
    this.age = [];
    for (let i = 0; i < this.n; i++) { this.base.push(new THREE.Vector3()); this.tip.push(new THREE.Vector3()); this.age.push(9); }
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.n * 2 * 3);
    this.alpha = new Float32Array(this.n * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA * 1.6, vA); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.active = false;
    this.head = 0;
  }

  push(base, tip, active) {
    // shift history
    for (let i = this.n - 1; i > 0; i--) {
      this.base[i].copy(this.base[i - 1]);
      this.tip[i].copy(this.tip[i - 1]);
      this.age[i] = this.age[i - 1];
    }
    this.base[0].copy(base);
    this.tip[0].copy(tip);
    this.age[0] = active ? 0 : 9;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      const a = clamp(1 - this.age[i] / 0.16, 0, 1) * (1 - i / this.n) * 0.7;
      if (a > 0) any = true;
      this.pos.set([this.base[i].x, this.base[i].y, this.base[i].z], i * 6);
      this.pos.set([this.tip[i].x, this.tip[i].y, this.tip[i].z], i * 6 + 3);
      this.alpha[i * 2] = a * 0.15;
      this.alpha[i * 2 + 1] = a;
    }
    this.mesh.visible = any;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
  }
}

// --------------------------------------------------------------- FX hub
export class FX {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.add = new Particles(5000, true, 0.0);
    this.alpha = new Particles(2600, false, 0.25);
    this.scene.add(this.add.points, this.alpha.points);
    this.mult = 1;
    // ambient embers floating around the camera
    this.embers = [];
    this.emberAcc = 0;
    // pooled dynamic lights
    this.lightCount = 6;
    this.lights = [];
    for (let i = 0; i < this.lightCount; i++) {
      const l = new THREE.PointLight(0xff8040, 0, 12, 1.6);
      l.userData.src = null;
      this.scene.add(l);
      this.lights.push(l);
    }
    this.dynLights = []; // {x,y,z,color,intensity,distance,life,maxLife}
    this.trail = new SwordTrail(0xffd2a0);
    this.scene.add(this.trail.mesh);
    this.fireAcc = 0;
    this.time = 0;
    this._v = new THREE.Vector3();
  }

  setQuality(settings) {
    this.mult = settings.particles;
    const n = settings.particles < 0.8 ? 3 : 6;
    this.lights.forEach((l, i) => { l.visible = i < n; });
  }

  // ----------------------------------------------------------- emitters
  sparks(x, y, z, n = 14, color = [1, 0.75, 0.3], speed = 7) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = rand(-0.4, 1.2);
      const s = speed * rand(0.4, 1);
      this.add.emit(x, y, z, Math.cos(a) * s * Math.cos(b), Math.sin(b) * s + 1, Math.sin(a) * s * Math.cos(b), rand(0.15, 0.4), 0.09, 0.02, [color[0] * 3, color[1] * 3, color[2] * 3, 1], [color[0], color[1] * 0.4, 0, 0], 14, 2.5);
    }
    this.flash(x, y, z, 0xffa040, 4, 6, 0.1);
  }

  blood(x, y, z, dx = 0, dz = 0, n = 18, scale = 1) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const s = rand(1.5, 5) * scale;
      this.alpha.emit(x + rand(-0.1, 0.1), y + rand(-0.1, 0.1), z + rand(-0.1, 0.1), dx * s + rand(-2, 2), rand(0.5, 4), dz * s + rand(-2, 2), rand(0.4, 0.9), rand(0.08, 0.16) * scale, rand(0.12, 0.25) * scale, [0.35, 0.02, 0.01, 0.95], [0.18, 0.0, 0.0, 0.0], 13, 1.0);
    }
    // ember-ish demon ichor glow
    for (let i = 0; i < n / 3; i++) {
      this.add.emit(x, y, z, rand(-2, 2) + dx * 2, rand(0.5, 3), rand(-2, 2) + dz * 2, rand(0.3, 0.6), 0.06, 0.01, [2.2, 0.5, 0.1, 1], [0.6, 0.05, 0, 0], 6, 1);
    }
  }

  gibs(x, y, z, n = 26, scale = 1) {
    this.blood(x, y, z, 0, 0, n * 1.5, scale * 1.4);
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 7) * scale;
      this.alpha.emit(x, y, z, Math.cos(a) * s, rand(2, 8), Math.sin(a) * s, rand(0.8, 1.4), rand(0.14, 0.3) * scale, 0.1, [0.3, 0.05, 0.04, 1], [0.1, 0.02, 0.02, 0.0], 16, 0.4);
    }
    this.flash(x, y, z, 0xff3010, 6, 8, 0.2);
  }

  fireBurst(x, y, z, dirX, dirZ, spread = 0.55, range = 6, n = 70) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dirX, dirZ) + rand(-spread, spread);
      const s = rand(0.6, 1.0) * range * 1.6;
      this.add.emit(x, y + rand(-0.2, 0.3), z, Math.sin(a) * s, rand(-0.3, 1.5), Math.cos(a) * s, rand(0.35, 0.65), 0.25, rand(0.8, 1.4), [3, 1.6, 0.5, 1], [0.8, 0.12, 0.02, 0], -1.5, 3.2);
    }
    this.flash(x + dirX * 2, y, z + dirZ * 2, 0xff7020, 9, 12, 0.5);
  }

  windBurst(x, y, z, dirX, dirZ, spread = 0.7, range = 7) {
    const n = Math.ceil(60 * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(dirX, dirZ) + rand(-spread, spread);
      const s = rand(0.7, 1) * range * 2.2;
      this.alpha.emit(x, y + rand(-0.4, 0.6), z, Math.sin(a) * s, rand(-0.5, 1), Math.cos(a) * s, rand(0.3, 0.55), 0.2, 1.2, [0.75, 0.82, 0.95, 0.35], [0.7, 0.8, 1.0, 0], 0, 4);
    }
    const n2 = Math.ceil(30 * this.mult);
    for (let i = 0; i < n2; i++) {
      const a = Math.atan2(dirX, dirZ) + rand(-spread, spread);
      const s = rand(0.6, 1) * range * 2.5;
      this.add.emit(x, y + rand(-0.3, 0.5), z, Math.sin(a) * s, rand(0, 1), Math.cos(a) * s, rand(0.2, 0.4), 0.08, 0.02, [0.8, 1.0, 1.6, 1], [0.2, 0.3, 0.6, 0], 0, 3);
    }
  }

  magicSwirl(x, y, z, color = [0.6, 0.9, 2.0], n = 30, radius = 0.8) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = radius * rand(0.5, 1);
      this.add.emit(x + Math.cos(a) * r, y + rand(-0.3, 0.5), z + Math.sin(a) * r, -Math.sin(a) * 2, rand(0.5, 2.5), Math.cos(a) * 2, rand(0.4, 0.8), 0.12, 0.02, [color[0], color[1], color[2], 1], [color[0] * 0.3, color[1] * 0.3, color[2] * 0.3, 0], -0.5, 1);
    }
  }

  ringBurst(x, y, z, radius, color = [2, 0.6, 0.2], n = 60) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.add.emit(x + Math.cos(a) * 0.3, y, z + Math.sin(a) * 0.3, Math.cos(a) * radius * 2.5, rand(0, 1.5), Math.sin(a) * radius * 2.5, 0.45, 0.35, 0.1, [color[0], color[1], color[2], 1], [color[0] * 0.2, color[1] * 0.1, 0, 0], 0, 2.5);
    }
  }

  dust(x, y, z, n = 10, scale = 1) {
    n = Math.ceil(n * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(0.5, 2.5) * scale;
      this.alpha.emit(x, y + 0.1, z, Math.cos(a) * s, rand(0.2, 1.2), Math.sin(a) * s, rand(0.5, 1.0), 0.25 * scale, 0.9 * scale, [0.45, 0.38, 0.32, 0.45], [0.35, 0.3, 0.27, 0], -0.3, 2.5);
    }
  }

  hayBurst(x, y, z, k = 1) {
    const n = Math.ceil(30 * k * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1, 4) * k;
      this.alpha.emit(x, y, z, Math.cos(a) * s, rand(2, 6) * k, Math.sin(a) * s, rand(0.6, 1.2), 0.08, 0.06, [0.85, 0.7, 0.3, 1], [0.6, 0.48, 0.2, 0], 9, 2);
    }
  }

  explosion(x, y, z, scale = 1) {
    const n = Math.ceil(60 * scale * this.mult);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = rand(-0.2, 1.3), s = rand(2, 8) * scale;
      this.add.emit(x, y, z, Math.cos(a) * Math.cos(b) * s, Math.sin(b) * s, Math.sin(a) * Math.cos(b) * s, rand(0.3, 0.7), 0.4 * scale, 1.4 * scale, [3, 1.4, 0.4, 1], [0.6, 0.1, 0.02, 0], -1, 3);
    }
    for (let i = 0; i < n / 2; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(1, 4) * scale;
      this.alpha.emit(x, y, z, Math.cos(a) * s, rand(1, 4), Math.sin(a) * s, rand(0.8, 1.6), 0.5 * scale, 2.2 * scale, [0.15, 0.1, 0.08, 0.6], [0.1, 0.08, 0.07, 0], -0.8, 1.5);
    }
    this.sparks(x, y, z, 20 * scale, [1, 0.6, 0.2], 10 * scale);
    this.flash(x, y + 1, z, 0xff6020, 14 * scale, 16 * scale, 0.45);
  }

  /** Short-lived dynamic light (takes priority in the light pool). */
  flash(x, y, z, color, intensity, distance, life) {
    if (this.dynLights.length > 12) this.dynLights.shift();
    this.dynLights.push({ x, y, z, color, intensity, distance, life, maxLife: life, dyn: true });
  }

  /** Continuous light attached to an object (call every frame). */
  attachedLight(src) {
    this._attached.push(src);
  }

  // ----------------------------------------------------------- update
  update(dt, camPos, focus) {
    this.time += dt;
    this._attached = this._attached || [];
    // fires around the city
    const city = this.game.city;
    this.fireAcc += dt;
    if (this.fireAcc > 1 / 45) {
      const step = this.fireAcc;
      this.fireAcc = 0;
      for (const f of city.fires) {
        const dx = f.x - camPos.x, dz = f.z - camPos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 55 * 55) continue;
        const rate = (f.candle ? 6 : 26 * f.size) * this.mult;
        let n = rate * step;
        while (n > 0) {
          if (n < 1 && Math.random() > n) break;
          n -= 1;
          const s = f.size;
          if (f.candle) {
            this.add.emit(f.x + rand(-0.01, 0.01), f.y + 0.02, f.z + rand(-0.01, 0.01), 0, rand(0.15, 0.3), 0, rand(0.15, 0.3), 0.05, 0.015, [3, 1.6, 0.5, 1], [1, 0.3, 0.05, 0], 0, 0);
            continue;
          }
          this.add.emit(f.x + rand(-0.4, 0.4) * s, f.y + rand(0, 0.2), f.z + rand(-0.4, 0.4) * s, rand(-0.3, 0.3), rand(1.2, 2.6) * (0.6 + s * 0.5), rand(-0.3, 0.3), rand(0.45, 0.9), 0.45 * s + 0.1, 0.08, [2.6, 1.2, 0.35, 1], [0.7, 0.08, 0.01, 0], -0.6, 0.8);
          if (Math.random() < 0.12) this.add.emit(f.x, f.y + 0.5 * s, f.z, rand(-0.6, 0.6), rand(2, 4), rand(-0.6, 0.6), rand(1.2, 2.4), 0.05, 0.02, [3, 1.2, 0.3, 1], [1, 0.2, 0, 0], -0.4, 0.3);
          if (s > 0.4 && Math.random() < 0.15) this.alpha.emit(f.x, f.y + 0.9 * s, f.z, rand(-0.2, 0.2), rand(1, 2), rand(-0.2, 0.2), rand(1.5, 2.5), 0.4 * s, 1.6 * s, [0.12, 0.09, 0.08, 0.35], [0.08, 0.06, 0.06, 0], -0.15, 0.4);
        }
      }
      // ambient embers + ash drifting around the camera
      const amb = Math.ceil(10 * step * 60 * 0.12 * this.mult);
      for (let i = 0; i < amb; i++) {
        const x = camPos.x + rand(-28, 28), z = camPos.z + rand(-28, 28), y = camPos.y + rand(-8, 14);
        if (Math.random() < 0.6) this.add.emit(x, y, z, rand(-0.4, 0.4) + 0.3, rand(0.2, 0.8), rand(-0.4, 0.4), rand(3, 6), 0.05, 0.02, [2.2, 0.7, 0.15, 1], [1.2, 0.2, 0.05, 0], -0.05, 0.1);
        else this.alpha.emit(x, y, z, rand(-0.3, 0.3) + 0.2, rand(-0.6, -0.2), rand(-0.3, 0.3), rand(4, 7), 0.05, 0.05, [0.18, 0.16, 0.15, 0.7], [0.15, 0.13, 0.12, 0], 0, 0.2);
      }
    }
    this.add.uniforms.uScale.value = this.game.renderer.pixelHeight / (2 * Math.tan((this.game.renderer.camera.fov * Math.PI) / 360));
    this.alpha.uniforms.uScale.value = this.add.uniforms.uScale.value;
    this.add.update(dt);
    this.alpha.update(dt);
    this.trail.update(dt);
    this.updateLights(dt, focus);
    this._attached.length = 0;
  }

  updateLights(dt, focus) {
    for (const d of this.dynLights) d.life -= dt;
    this.dynLights = this.dynLights.filter((d) => d.life > 0);
    const cand = [];
    for (const d of this.dynLights) cand.push({ s: -1000 + Math.hypot(d.x - focus.x, d.z - focus.z), src: d });
    for (const d of this._attached) cand.push({ s: -500 + Math.hypot(d.x - focus.x, d.z - focus.z), src: d });
    const city = this.game.city;
    for (const l of city.lights) {
      const dx = l.x - focus.x, dz = l.z - focus.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 45 * 45) continue;
      cand.push({ s: Math.sqrt(d2) - l.intensity * 0.6, src: l });
    }
    cand.sort((a, b) => a.s - b.s);
    const n = this.lights.filter((l) => l.visible).length;
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const c = i < n ? cand[i] : null;
      if (!c) { L.intensity = 0; continue; }
      const s = c.src;
      if (L.userData.src !== s) { L.color.set(s.color); L.userData.src = s; }
      L.position.set(s.x, s.y, s.z);
      L.distance = s.distance;
      let inten = s.intensity;
      if (s.dyn) inten *= clamp(s.life / s.maxLife, 0, 1);
      if (s.flicker) inten *= 1 - s.flicker * (0.5 + 0.5 * Math.sin(this.time * 13 + s.x * 3.1) * Math.sin(this.time * 7.3 + s.z));
      L.intensity = inten * 4;
    }
  }
}
