import * as THREE from 'three';
import { clamp, damp, dampAngle, wrapAngle } from '../core/math.js';
import { cameraFilter } from '../world/collision.js';

// Third-person orbit camera. Updated every rendered frame with real frame
// time (mouse look is applied immediately for responsiveness); all smoothing
// is exponential with dt so it behaves the same at any refresh rate.

export class ThirdPersonCamera {
  constructor(camera, collision, input) {
    this.cam = camera;
    this.col = collision;
    this.input = input;
    this.yaw = 0;
    this.pitch = 0.18;
    this.dist = 3.8;
    this.curDist = 3.8;
    this.pivot = new THREE.Vector3();
    this.smPivot = new THREE.Vector3();
    this.fov = 65;
    this.trauma = 0;
    this.t = 0;
    this.sensitivity = 1;
    this.invertY = false;
    this.lastLookInput = 0;
    this.cinematic = null;
    this.baseFov = 65;
    this.shakeEnabled = true;
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  snapBehind(yaw) {
    this.yaw = yaw;
    this.pitch = 0.2;
  }

  addShake(amount) {
    if (!this.shakeEnabled) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * focus: interpolated player position (feet). o: { mode, lockPos, sprint,
   * height, distance, fovAdd }
   */
  update(dt, focus, o = {}) {
    this.t += dt;
    const input = this.input;
    // ---- look input
    const [mx, my] = input.takeMouse();
    const sens = 0.0022 * this.sensitivity;
    let dyaw = -mx * sens;
    let dpitch = my * sens * (this.invertY ? -1 : 1);
    const pad = input.pad;
    let stick = 0;
    if (pad.connected) {
      dyaw -= pad.rx * 3.0 * this.sensitivity * dt;
      dpitch += pad.ry * 2.1 * this.sensitivity * dt * (this.invertY ? -1 : 1);
      stick = Math.abs(pad.rx) + Math.abs(pad.ry);
    }
    const a = input.actions;
    if (a.lookLeft.down) dyaw += 2.4 * dt;
    if (a.lookRight.down) dyaw -= 2.4 * dt;
    if (a.lookUp.down) dpitch -= 1.6 * dt;
    if (a.lookDown.down) dpitch += 1.6 * dt;
    if (dyaw || dpitch || stick) this.lastLookInput = this.t;
    if (!this.cinematic) {
      this.yaw = wrapAngle(this.yaw + dyaw);
      this.pitch = clamp(this.pitch + dpitch, -1.2, 1.25);
    }

    // ---- lock-on framing: keep the target in view
    if (o.lockPos && !this.cinematic) {
      const ty = Math.atan2(o.lockPos.x - focus.x, o.lockPos.z - focus.z);
      if (this.t - this.lastLookInput > 0.25) this.yaw = dampAngle(this.yaw, ty, 4.5, dt);
      this.pitch = damp(this.pitch, clamp(this.pitch, 0.05, 0.45), 3, dt);
    } else if (o.follow && pad.connected && this.t - this.lastLookInput > 2.0) {
      // gentle auto-follow for gamepads
      this.yaw = dampAngle(this.yaw, o.follow, 0.8, dt);
    }

    // ---- desired distance / pivot
    let dist = o.distance ?? 3.8;
    let h = o.height ?? 1.58;
    let shoulder = o.shoulder ?? 0.42;
    let fov = this.baseFov + (o.fovAdd || 0);
    let yaw = this.yaw, pitch = this.pitch;
    if (this.cinematic) {
      const c = this.cinematic;
      c.t = (c.t || 0) + dt;
      if (c.orbit) c.yaw += c.orbit * dt;
      yaw = c.yaw; pitch = c.pitch; dist = c.dist; h = c.height ?? h; shoulder = c.shoulder ?? 0;
      this.yaw = dampAngle(this.yaw, yaw, 6, dt);
      this.pitch = damp(this.pitch, pitch, 6, dt);
      yaw = this.yaw; pitch = this.pitch;
      if (c.fov) fov = c.fov;
      if (c.until && c.t >= c.until) this.cinematic = null;
    }
    this.fov = damp(this.fov, fov, 6, dt);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }

    const target = this._tmp.set(focus.x, focus.y + h, focus.z);
    if (this.cinematic && this.cinematic.focus) target.copy(this.cinematic.focus);
    // smooth vertical pivot a bit (stairs, landings), x/z follow tightly
    this.smPivot.x = target.x;
    this.smPivot.z = target.z;
    this.smPivot.y = Math.abs(this.smPivot.y - target.y) > 3 ? target.y : damp(this.smPivot.y, target.y, 14, dt);

    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = Math.sin(yaw) * cp, fy = -sp, fz = Math.cos(yaw) * cp;
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    // shoulder offset (collision checked)
    const head = this.smPivot;
    let sx = rx * shoulder, sz = rz * shoulder;
    if (shoulder > 0) {
      const hs = this.col.raycast(head.x, head.y, head.z, rx, 0, rz, shoulder + 0.25, cameraFilter);
      if (hs) { const k = Math.max(0, hs.t - 0.25) / shoulder; sx *= k; sz *= k; }
    }
    this.pivot.set(head.x + sx, head.y, head.z + sz);
    // boom collision
    const hit = this.col.raycast(this.pivot.x, this.pivot.y, this.pivot.z, -fx, -fy, -fz, dist + 0.3, cameraFilter);
    let want = dist;
    if (hit) want = Math.max(0.6, hit.t - 0.3);
    this.curDist = want < this.curDist ? damp(this.curDist, want, 30, dt) : damp(this.curDist, want, 3.5, dt);
    if (want < this.curDist - 0.5) this.curDist = want;
    const d = this.curDist;
    let px = this.pivot.x - fx * d, py = this.pivot.y - fy * d, pz = this.pivot.z - fz * d;
    if (py < 0.25) py = 0.25;

    // ---- shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma;
    let roll = 0;
    if (s > 0) {
      const t = this.t * 30;
      px += (Math.sin(t * 1.1) + Math.sin(t * 2.3) * 0.5) * 0.12 * s;
      py += (Math.sin(t * 1.7 + 1) + Math.sin(t * 2.9) * 0.5) * 0.12 * s;
      pz += (Math.sin(t * 1.3 + 2) + Math.sin(t * 3.1) * 0.5) * 0.12 * s;
      roll = Math.sin(t * 0.9) * 0.05 * s;
    }
    this.cam.position.set(px, py, pz);
    this.cam.up.set(Math.sin(roll) * Math.cos(yaw), Math.cos(roll), -Math.sin(roll) * Math.sin(yaw));
    this.cam.lookAt(this.pivot.x, this.pivot.y + (this.cinematic?.lookUp || 0), this.pivot.z);
  }

  /** Forward vector on the ground plane. */
  forward(out) {
    out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    return out;
  }
}
