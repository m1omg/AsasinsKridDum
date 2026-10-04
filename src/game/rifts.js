import * as THREE from 'three';

// Hell Rift visuals (portal ring, vortex, heart crystal, floating debris) and
// the ring of hellfire that seals an arena during a wave fight.

const PORTAL_FS = /* glsl */ `
uniform float uTime, uOpen;
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float sw = a * 2.0 + log(r + 0.03) * 5.0 - uTime * 1.6;
  float n = n2(vec2(sw * 1.5, r * 6.0 - uTime)) * 0.7 + n2(vec2(a * 3.0, r * 12.0 + uTime * 2.0)) * 0.3;
  vec3 col = mix(vec3(0.6, 0.02, 0.0), vec3(1.0, 0.45, 0.08), n);
  col = mix(col, vec3(0.05, 0.0, 0.0), smoothstep(0.35, 0.0, r) * 0.9);
  col += vec3(1.0, 0.6, 0.2) * smoothstep(0.75, 1.0, r) * 1.5;
  float alpha = smoothstep(1.0, 0.92, r) * uOpen;
  gl_FragColor = vec4(col * 2.2 * alpha, alpha);
}`;

const FIREWALL_FS = /* glsl */ `
uniform float uTime, uOn;
varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
void main(){
  float y = vUv.y;
  float n = n2(vec2(vUv.x * 60.0, y * 3.0 - uTime * 2.5)) * 0.6 + n2(vec2(vUv.x * 140.0, y * 7.0 - uTime * 4.0)) * 0.4;
  float flame = smoothstep(0.0, 0.15, y) * (1.0 - smoothstep(0.15 + n * 0.75, 1.0, y));
  vec3 col = mix(vec3(1.0, 0.25, 0.02), vec3(1.0, 0.85, 0.4), n * (1.0 - y));
  float a = flame * uOn;
  gl_FragColor = vec4(col * a * 2.0, a);
}`;

const VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export class RiftVisual {
  constructor(game, rift) {
    this.game = game;
    this.rift = rift;
    this.group = new THREE.Group();
    this.group.position.set(rift.x, 0, rift.z);
    game.scene.add(this.group);
    const mats = game.materials;
    // flesh/rock ring standing upright
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.55, 10, 32), mats.flesh);
    this.ring.position.y = 4.9;
    this.ring.castShadow = true;
    this.group.add(this.ring);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.4, 6), mats.bone);
      spike.position.set(Math.cos(a) * 3.9, 4.9 + Math.sin(a) * 3.9, 0);
      spike.rotation.z = a - Math.PI / 2;
      this.group.add(spike);
    }
    this.uniforms = { uTime: { value: 0 }, uOpen: { value: 1 } };
    this.portal = new THREE.Mesh(new THREE.CircleGeometry(3.4, 48), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: PORTAL_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.portal.position.y = 4.9;
    this.group.add(this.portal);
    // heart crystal
    this.heartMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: new THREE.Color(1, 0.12, 0.04), emissiveIntensity: 2.5, roughness: 0.25, metalness: 0.2 });
    this.heart = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), this.heartMat);
    this.heart.position.set(rift.heart.x - rift.x, rift.heart.y + 1.0, rift.heart.z - rift.z);
    this.heart.scale.set(0.8, 1.4, 0.8);
    this.group.add(this.heart);
    const veins = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.45, 1.1, 7), mats.flesh);
    veins.position.set(this.heart.position.x, rift.heart.y + 0.1, this.heart.position.z);
    this.group.add(veins);
    // floating debris
    this.debris = [];
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + Math.random() * 0.35, 0), mats.hellrock);
      m.userData = { a: Math.random() * Math.PI * 2, r: 4.5 + Math.random() * 3, h: 2 + Math.random() * 6, s: 0.2 + Math.random() * 0.4 };
      this.group.add(m);
      this.debris.push(m);
    }
    this.light = { x: rift.x, y: 4.9, z: rift.z, color: 0xff2a08, intensity: 5, distance: 24, flicker: 0.25 };
    game.city.lights.push(this.light);
    this.time = 0;
    this.closing = 0;
    this.closed = false;
    this.hum = null;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    this.uniforms.uTime.value = t;
    const p = this.game.player.pos;
    const dist = Math.hypot(p.x - this.rift.x, p.z - this.rift.z);
    // face the portal toward the player softly (billboard around Y)
    const yaw = Math.atan2(p.x - this.rift.x, p.z - this.rift.z);
    this.ring.rotation.y = yaw;
    this.portal.rotation.y = yaw;
    for (const c of this.group.children) if (c.geometry && c.geometry.type === 'ConeGeometry') c.visible = !this.closed;
    if (!this.closed) {
      this.heart.rotation.y += dt * 0.8;
      const pulse = 1 + Math.sin(t * 3) * 0.06 + (this.rift.active ? Math.sin(t * 9) * 0.05 : 0);
      this.heart.scale.set(0.8 * pulse, 1.4 * pulse, 0.8 * pulse);
      this.heartMat.emissiveIntensity = 2 + Math.sin(t * 3) * 0.8 + (this.rift.active ? 2 : 0);
      for (const d of this.debris) {
        const u = d.userData;
        u.a += dt * u.s;
        d.position.set(Math.cos(u.a) * u.r, u.h + Math.sin(t + u.r) * 0.4, Math.sin(u.a) * u.r);
        d.rotation.x += dt * u.s; d.rotation.y += dt * u.s * 0.7;
      }
      // ambient sparks rising into the vortex
      if (dist < 70 && Math.random() < dt * 25) {
        const a = Math.random() * Math.PI * 2;
        this.game.fx.add.emit(this.rift.x + Math.cos(a) * 3.5, 0.5, this.rift.z + Math.sin(a) * 3.5, -Math.cos(a) * 0.8, 2.5 + Math.random() * 2, -Math.sin(a) * 0.8, 1.6, 0.12, 0.03, [3, 0.8, 0.2, 1], [1, 0.1, 0, 0], -0.2, 0.3);
      }
      if (!this.hum && dist < 45 && this.game.audio?.ready) this.hum = this.game.audio.loop('riftHum', { pos: { x: this.rift.x, y: 4, z: this.rift.z }, volume: 0.8 });
      else if (this.hum && dist > 55) { this.hum.stop?.(1); this.hum = null; }
    }
    if (this.closing > 0) {
      this.closing += dt;
      const u = Math.min(1, this.closing / 2.5);
      this.uniforms.uOpen.value = 1 - u;
      this.ring.scale.setScalar(1 - u * 0.8);
      this.heart.scale.multiplyScalar(1 - u);
      this.light.intensity = 5 * (1 - u) + Math.sin(u * Math.PI) * 15;
      if (u >= 1 && !this.closed) this.finishClose();
    }
  }

  close() {
    this.closing = 0.001;
    this.game.audio?.play('riftClose', { pos: { x: this.rift.x, y: 4, z: this.rift.z }, volume: 1 });
    this.game.fx.explosion(this.rift.x, 4.9, this.rift.z, 2.2);
    this.game.camera.addShake(0.6);
  }

  finishClose() {
    this.closed = true;
    this.portal.visible = false;
    this.heart.visible = false;
    this.ring.visible = false;
    for (const d of this.debris) d.visible = false;
    this.light.intensity = 0;
    if (this.hum) { this.hum.stop?.(1); this.hum = null; }
    // a pillar of light marks the cleansed site
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.4, 120, 16, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.9, 0.5), transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    beam.position.set(0, 60, 0);
    this.group.add(beam);
    this.pillar = beam;
  }

  setClosedInstant() {
    this.finishClose();
    this.uniforms.uOpen.value = 0;
  }
}

export class FireBarrier {
  constructor(game, x, z, r, height = 7) {
    this.game = game;
    this.x = x; this.z = z; this.r = r;
    this.uniforms = { uTime: { value: 0 }, uOn: { value: 0 } };
    const geo = new THREE.CylinderGeometry(r, r, height, 96, 1, true);
    geo.translate(0, height / 2, 0);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FIREWALL_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    this.mesh.position.set(x, 0, z);
    game.scene.add(this.mesh);
    this.colliders = [];
    const n = 56;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      const x0 = x + Math.cos(a0) * r, z0 = z + Math.sin(a0) * r;
      const x1 = x + Math.cos(a1) * r, z1 = z + Math.sin(a1) * r;
      const c = game.collision.box(Math.min(x0, x1) - 0.25, 0, Math.min(z0, z1) - 0.25, Math.max(x0, x1) + 0.25, 60, Math.max(z0, z1) + 0.25, { kind: 'barrier', climbable: false, blocksSight: false, blocksCamera: false });
      this.colliders.push(c);
    }
    this.on = true;
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const l = { x: x + Math.cos(a) * r, y: 2, z: z + Math.sin(a) * r, color: 0xff5010, intensity: 4, distance: 16, flicker: 0.35 };
      game.city.lights.push(l);
      this.lights.push(l);
    }
    this.loop = game.audio?.loop('fireCrackle', { pos: { x, y: 2, z }, volume: 1 });
    game.audio?.play('riftOpen', { pos: { x, y: 2, z }, volume: 1 });
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
    const target = this.on ? 1 : 0;
    this.uniforms.uOn.value += (target - this.uniforms.uOn.value) * Math.min(1, dt * 3);
    if (!this.on && this.uniforms.uOn.value < 0.02) this.dispose();
  }

  drop() {
    if (!this.on) return;
    this.on = false;
    for (const c of this.colliders) this.game.collision.remove(c);
    this.colliders = [];
    for (const l of this.lights) l.intensity = 0;
    this.loop?.stop?.(1);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.game.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    const L = this.game.city.lights;
    for (const l of this.lights) { const i = L.indexOf(l); if (i >= 0) L.splice(i, 1); }
  }
}
