import * as THREE from 'three';
import { clamp, damp, dampAngle, approach, angleDiff, wrapAngle, lerp, smoothstep } from '../core/math.js';

// ---------------------------------------------------------------------------
// Player controller: AC-style free running (climb any wall, ledge hang,
// mantle, vault, assisted rooftop leaps, beams, hay, leap of faith) plus the
// hooks the Witcher-style combat module (playerCombat.js) plugs into.
// All logic runs in fixed ticks; render reads interpolated state.
// ---------------------------------------------------------------------------

export const P = {
  R: 0.34,
  H: 1.78,
  STEP: 0.45,
  FOOT_R: 0.16,
  GRAV: 22,
  JUMP_V: 7.0,
  SPEED_SNEAK: 1.9,
  SPEED_RUN: 4.9,
  SPEED_SPRINT: 7.9,
  SPEED_COMBAT: 3.5,
  SPEED_BLOCK: 1.7,
  ACCEL: 42,
  AIR_ACCEL: 7,
  CLIMB_OFF: 0.37,
  CLIMB_UP: 2.5,
  CLIMB_DOWN: 3.2,
  CLIMB_SIDE: 2.1,
  HANG: 1.86, // feet below the ledge top while hanging
};

const climbFilter = (c) => c.climbable && c.kind !== 'bounds';
const overheadFilter = (c) => c.kind !== 'awning' && c.kind !== 'beam' && c.kind !== 'railing';
const _hit = {};

export class Player {
  constructor(game) {
    this.game = game;
    this.col = game.collision;
    this.input = game.input;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.prevYaw = 0;
    this.state = 'ground';
    this.stateTime = 0;
    this.grounded = true;
    this.ground = { y: 0, c: null };
    this.lastGrounded = 0;
    this.fallStartY = 0;
    this.sneaking = false;
    this.sprintMoved = false; // toggled sprint: has the player moved since switching it on
    this.sprintIdle = 0;
    this.sprinting = false;
    this.moveAmount = 0;
    this.speed2d = 0;
    this.wall = { nx: 0, nz: 1, c: null, top: null, hanging: false };
    this.climbBoost = 0;
    this.climbBoostV = 0;
    this.climbSide = 0;
    this.climbSideT = 0;
    this.climbDist = 0;
    this.noCatchUntil = 0;
    this.noCatchNx = 0;
    this.noCatchNz = 0;
    this.trans = null; // mantle / vault / scripted move
    this.visY = 0;
    this.prevVisY = 0;
    this.hay = null;
    this.time = 0;
    this.visible = true;
    this.mv = { x: 0, y: 0 };
    // stats (combat module extends these)
    this.maxHp = 150;
    this.hp = 150;
    this.armor = 0;
    this.maxArmor = 50;
    this.dead = false;
    this.invuln = 0;
    this.noise = 0;
    this.fx = { landing: 0, jump: 0 };
  }

  spawn(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.prev.copy(this.pos);
    this.visY = this.prevVisY = y;
    this.vel.set(0, 0, 0);
    this.yaw = this.prevYaw = yaw;
    this.setState('ground');
    this.dead = false;
    this.visible = true;
    this.trans = null;
    this.hay = null;
  }

  setState(s) {
    if (this.state === s) { this.stateTime = 0; return; }
    const old = this.state;
    this.state = s;
    this.stateTime = 0;
    if (this.onStateChange) this.onStateChange(old, s);
  }

  savePrev() {
    this.prev.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevVisY = this.visY;
  }

  get camYaw() { return this.game.camera.yaw; }

  /** World-space move direction from input relative to the camera. */
  moveDir(out) {
    this.input.moveVector(this.mv);
    const cy = this.camYaw;
    const fx = Math.sin(cy), fz = Math.cos(cy);
    const rx = -Math.cos(cy), rz = Math.sin(cy);
    out.x = rx * this.mv.x + fx * this.mv.y;
    out.z = rz * this.mv.x + fz * this.mv.y;
    out.len = Math.min(1, Math.hypot(out.x, out.z));
    return out;
  }

  // ------------------------------------------------------------ update
  update(dt) {
    this.time += dt;
    this.stateTime += dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.noise = Math.max(0, this.noise - dt * 2);
    const fn = this['st_' + this.state];
    if (fn) fn.call(this, dt);
    if (this.combatTick) this.combatTick(dt);
    // smoothed visual height (stairs / small steps), logic stays exact
    const smooth = (this.state === 'ground' || this.state === 'landroll') && this.grounded;
    if (smooth && Math.abs(this.visY - this.pos.y) < 0.7) this.visY = damp(this.visY, this.pos.y, 22, dt);
    else this.visY = this.pos.y;
    // safety: never fall out of the world
    if (this.pos.y < -20) {
      const sp = this.game.city.spawn;
      this.spawn(sp.x, sp.y, sp.z, sp.yaw);
    }
  }

  // ------------------------------------------------------------ ground
  st_ground(dt) {
    const input = this.input;
    const md = this.moveDir(this._md || (this._md = {}));
    // sneak: a press switches it (default) or it lasts while the key is held (setting; never on touch)
    if (this.game.settings?.toggles?.sneak === false && !input.touchActive) this.sneaking = input.held('sneak');
    else if (input.pressed('sneak')) this.sneaking = !this.sneaking;
    if (input.isToggle('sprint') && input.held('sprint')) {
      // toggled sprint ends when the player starts sneaking or stops moving
      if (input.pressed('sneak')) input.unlatch('sprint');
      else if (md.len > 0.3) { this.sprintMoved = true; this.sprintIdle = 0; }
      else if (this.sprintMoved && (this.sprintIdle += dt) > 0.3) { input.unlatch('sprint'); this.sprintMoved = false; }
    } else { this.sprintMoved = false; this.sprintIdle = 0; }
    const wantsSprint = input.held('sprint') && md.len > 0.3;
    if (wantsSprint) this.sneaking = false;
    this.sprinting = wantsSprint && !this.blocking;
    const combat = this.inCombatStance && this.inCombatStance();
    let speed = this.sprinting ? P.SPEED_SPRINT : this.sneaking ? P.SPEED_SNEAK : combat ? P.SPEED_COMBAT : P.SPEED_RUN;
    if (this.blocking) speed = P.SPEED_BLOCK;
    if (this.onBeam) speed *= this.sprinting ? 0.85 : 0.75;
    speed *= md.len;
    if (this.speedMul) speed *= this.speedMul;
    // accelerate toward desired velocity
    const tx = md.len > 0.05 ? (md.x / md.len) * speed : 0;
    const tz = md.len > 0.05 ? (md.z / md.len) * speed : 0;
    const a = P.ACCEL * dt;
    this.vel.x = approach(this.vel.x, tx, a);
    this.vel.z = approach(this.vel.z, tz, a);
    this.vel.y = 0;
    this.moveAmount = md.len;
    // facing
    const lockYaw = this.facingOverride ? this.facingOverride() : null;
    if (lockYaw !== null && !this.sprinting) this.yaw = dampAngle(this.yaw, lockYaw, 14, dt);
    else if (md.len > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(md.x, md.z), this.sprinting ? 9 : 13, dt);
    this.noise = Math.max(this.noise, this.sprinting ? 1 : this.sneaking ? 0 : speed > 3 ? 0.45 : 0);

    // climbing / vaulting / ledges ahead
    if (this.tryParkourFromGround(md)) return;

    // edge handling for free-running
    if (this.sprinting && md.len > 0.5 && this.handleEdge()) return;

    // jump
    if (input.pressed('jump') && !this.consumeJumpForCombat?.()) {
      if (this.tryClimbStart(true)) return;
      this.doJump();
      return;
    }
    this.integrateGround(dt);
  }

  integrateGround(dt) {
    const col = this.col;
    const oldY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    col.pushOut(this.pos, P.R, this.pos.y + P.STEP, this.pos.y + P.H - 0.05);
    const g = col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, this.pos.y + P.STEP + 0.02, this.ground);
    const drop = this.pos.y - g.y;
    const snap = this.onSlopeOrStairs(g.c) ? 0.9 : 0.42;
    if (drop <= snap) {
      this.pos.y = g.y;
      this.grounded = true;
      this.lastGrounded = this.time;
      this.onBeam = g.c && (g.c.kind === 'beam') ? g.c : null;
      if (this.onBeam) this.balanceOnBeam(dt);
    } else {
      // walked off an edge
      this.grounded = false;
      this.fallStartY = oldY;
      this.vel.y = 0;
      this.setState('air');
    }
    this.speed2d = Math.hypot(this.vel.x, this.vel.z);
  }

  onSlopeOrStairs(c) {
    return c && (c.slope || c.kind === 'stairs');
  }

  balanceOnBeam(dt) {
    const b = this.onBeam;
    const alongX = b.maxX - b.minX > b.maxZ - b.minZ;
    if (alongX) this.pos.z = damp(this.pos.z, (b.minZ + b.maxZ) / 2, 10, dt);
    else this.pos.x = damp(this.pos.x, (b.minX + b.maxX) / 2, 10, dt);
  }

  doJump(target = null) {
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const tgt = target || (speed > 2.5 ? this.findJumpTarget(fwdX, fwdZ) : null);
    if (tgt) {
      this.vel.x = tgt.vx; this.vel.y = tgt.vy; this.vel.z = tgt.vz;
      this.jumpTarget = tgt;
    } else {
      const boost = this.sprinting ? 1.08 : 1;
      this.vel.x *= boost; this.vel.z *= boost;
      this.vel.y = P.JUMP_V;
      this.jumpTarget = null;
    }
    this.fallStartY = this.pos.y;
    this.grounded = false;
    this.fx.jump = 1;
    this.game.audio?.play('jump', { pos: this.pos, volume: 0.5 });
    this.setState('air');
  }

  /**
   * Look ahead for a landing surface across a gap and return the ballistic
   * velocity to reach it (AC-style assisted free-run jumps).
   */
  findJumpTarget(dx, dz, maxD = 8.4) {
    const col = this.col;
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const perpX = -dz, perpZ = dx;
    // is there a gap in front?
    let gapAt = -1;
    for (let d = 0.6; d <= 2.6; d += 0.25) {
      const g = col.groundAt(px + dx * d, pz + dz * d, 0.12, py + 0.6);
      if (g.y < py - 1.1) { gapAt = d; break; }
    }
    if (gapAt < 0) return null;
    const res = {};
    let best = null, bestScore = Infinity;
    for (let d = gapAt + 0.8; d <= maxD; d += 0.4) {
      for (const lat of [0, -0.3, 0.3, -0.6, 0.6, -0.95, 0.95]) {
        const x = px + dx * d + perpX * lat, z = pz + dz * d + perpZ * lat;
        const g = col.groundAt(x, z, 0.1, py + 1.7, res);
        if (g.y < py - 7.5) continue;
        if (g.y < py - 1.6 && !(g.c && g.c.kind === 'haycart')) {
          // big drop: only a target if nothing better (scored worse)
        }
        if (!col.isFree(x, z, 0.22, g.y + 0.25, g.y + 1.6)) continue;
        // must actually be across the gap (ground just before it is lower)
        const before = col.groundAt(px + dx * (d - 0.7) + perpX * lat, pz + dz * (d - 0.7) + perpZ * lat, 0.1, py + 1.7);
        if (before.y > g.y - 0.6 && d - 0.7 > gapAt + 0.2) continue;
        const dy = g.y - py;
        const narrow = g.c && g.c.kind === 'beam';
        const score = d * 0.6 + Math.abs(lat) * 2.2 + (dy < -1.5 ? -dy * 0.5 : 0) + (dy > 0.5 ? dy * 0.6 : 0) - (narrow ? 0.4 : 0);
        if (score < bestScore) {
          const flight = this.ballistic(x, g.y, z, d);
          if (flight) { bestScore = score; best = { x, y: g.y, z, ...flight, c: g.c }; }
        }
      }
      if (best && d > best.dist + 1.2) break;
    }
    return best;
  }

  ballistic(tx, ty, tz, d) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = ty - this.pos.y;
    let tau = clamp(0.36 + dist * 0.06 + Math.max(0, dy) * 0.05, 0.42, 0.95);
    for (let k = 0; k < 4; k++) {
      const vy = (dy + 0.5 * P.GRAV * tau * tau) / tau;
      const vh = dist / tau;
      if (vy <= 9.6 && vh <= 10.8) return { vx: dx / tau, vy, vz: dz / tau, tau, dist: d };
      tau += 0.12;
    }
    return null;
  }

  /** Sprinting toward a roof edge: leap if there's a target, otherwise brake. */
  handleEdge() {
    if (this.time < (this.edgeCooldown || 0)) return this.brakeAtEdge();
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const ahead = P.R + 0.35 + this.speed2d * 0.06;
    const g = this.col.groundAt(this.pos.x + fx * ahead, this.pos.z + fz * ahead, 0.12, this.pos.y + P.STEP);
    if (g.y >= this.pos.y - 1.2) return false;
    const tgt = this.findJumpTarget(fx, fz);
    if (tgt) { this.doJump(tgt); return true; }
    this.edgeCooldown = this.time + 0.2;
    this.edgeDrop = this.pos.y - g.y;
    return this.brakeAtEdge();
  }

  /** No landing target: hold at a high edge unless jump is pressed. */
  brakeAtEdge() {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const ahead = P.R + 0.35 + this.speed2d * 0.06;
    const g = this.col.groundAt(this.pos.x + fx * ahead, this.pos.z + fz * ahead, 0.12, this.pos.y + P.STEP);
    if (g.y >= this.pos.y - 1.2) return false;
    if (this.pos.y - g.y > 4 && !this.input.held('jump')) {
      const vf = this.vel.x * fx + this.vel.z * fz;
      if (vf > 0) { this.vel.x -= fx * vf; this.vel.z -= fz * vf; }
    }
    return false;
  }

  // ------------------------------------------------------------ parkour helpers
  probe(x, y, z, dx, dz, dist) {
    const h = this.col.raycast(x, y, z, dx, 0, dz, dist, climbFilter, _hit);
    if (!h || !h.c || h.t < 1e-4 || Math.abs(h.ny) > 0.5) return null;
    return { x: h.x, y: h.y, z: h.z, nx: h.nx, nz: h.nz, c: h.c, t: h.t };
  }

  /** Height of the top surface just behind a wall contact (null if the wall continues up). */
  wallTop(cx, cz, nx, nz, fromY, depth = 0.18) {
    const x = cx - nx * depth, z = cz - nz * depth;
    const h = this.col.raycast(x, fromY, z, 0, -1, 0, 6, null, _hit);
    if (!h || h.t < 1e-4) return null;
    return h.y;
  }

  /** Free standing room on top of a ledge at (x, top, z)? */
  standRoom(x, top, z) {
    const g = this.col.groundAt(x, z, P.FOOT_R, top + 0.5);
    if (g.y > top + 0.6 || g.y < top - 1.25) return null;
    if (!this.col.isFree(x, z, P.R * 0.8, Math.max(g.y, top) + 0.12, g.y + P.H - 0.05)) return null;
    return g.y;
  }

  tryParkourFromGround(md) {
    if (md.len < 0.3) return false;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const mdx = md.x / md.len, mdz = md.z / md.len;
    if (fx * mdx + fz * mdz < 0.6) return false;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // obstacle directly ahead at knee height?
    const reach = P.R + 0.28;
    const knee = this.probe(this.pos.x, this.pos.y + 0.6, this.pos.z, fx, fz, reach);
    if (!knee) return false;
    if (knee.nx * fx + knee.nz * fz > -0.6) return false;
    const top = this.wallTop(knee.x, knee.z, knee.nx, knee.nz, this.pos.y + 2.4);
    if (top !== null && top - this.pos.y <= 1.4 && top - this.pos.y > P.STEP) {
      if (speed < 2.2 && !this.input.held('jump')) return false;
      return this.startVault(knee, top);
    }
    if (this.sprinting && (top === null || top - this.pos.y > 1.4)) {
      return this.attachWall(knee, 2.1);
    }
    return false;
  }

  /** Jump onto a wall in front (Space while facing a wall). */
  tryClimbStart(fromJump) {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const h = this.probe(this.pos.x, this.pos.y + 1.0, this.pos.z, fx, fz, P.R + 0.6);
    if (!h || h.nx * fx + h.nz * fz > -0.6) return false;
    const top = this.wallTop(h.x, h.z, h.nx, h.nz, this.pos.y + 2.6);
    if (top !== null && top - this.pos.y <= 1.4) return this.startVault(h, top);
    return this.attachWall(h, fromJump ? 1.3 : 0.6);
  }

  startVault(hit, top) {
    const nx = hit.nx, nz = hit.nz;
    // stand on it, or vault over a thin obstacle
    const onX = hit.x - nx * 0.55, onZ = hit.z - nz * 0.55;
    const room = this.standRoom(onX, top, onZ);
    let over = null;
    for (const d of [0.9, 1.3]) {
      const bx = hit.x - nx * d, bz = hit.z - nz * d;
      const g = this.col.groundAt(bx, bz, P.FOOT_R, top - 0.05);
      if (g.y <= top - 0.25 && this.col.isFree(bx, bz, P.R * 0.85, g.y + 0.3, g.y + P.H - 0.1) && top - g.y < 3.5) {
        over = { x: bx, y: g.y, z: bz };
        break;
      }
    }
    const fast = Math.hypot(this.vel.x, this.vel.z) > 3.5;
    if (over && (fast || room === null)) {
      this.beginTrans('vault', { x: over.x, y: over.y, z: over.z }, 0.42, top + 0.15);
      this.game.audio?.play('vault', { pos: this.pos, volume: 0.5 });
      return true;
    }
    if (room !== null) {
      this.beginTrans('mantle', { x: onX, y: room, z: onZ }, 0.3 + (top - this.pos.y) * 0.15, top + 0.05);
      this.game.audio?.play('grab', { pos: this.pos, volume: 0.5 });
      return true;
    }
    return false;
  }

  /** Attach to a wall contact and enter the climb state (boost = run-up metres). */
  attachWall(hit, boost = 0) {
    const n = Math.hypot(hit.nx, hit.nz) || 1;
    this.wall.nx = hit.nx / n;
    this.wall.nz = hit.nz / n;
    this.wall.c = hit.c;
    this.wall.hanging = false;
    this.pos.x = hit.x + this.wall.nx * P.CLIMB_OFF;
    this.pos.z = hit.z + this.wall.nz * P.CLIMB_OFF;
    this.vel.set(0, 0, 0);
    this.climbBoost = boost;
    this.climbBoostV = boost > 0 ? 7 : 0;
    this.yaw = Math.atan2(-this.wall.nx, -this.wall.nz);
    this.grounded = false;
    this.setState('climb');
    this.game.audio?.play('grab', { pos: this.pos, volume: 0.6 });
    return true;
  }

  beginTrans(kind, to, dur, apexY) {
    this.trans = {
      kind,
      from: this.pos.clone(),
      to: new THREE.Vector3(to.x, to.y, to.z),
      dur,
      t: 0,
      apex: apexY,
      yaw: this.yaw,
    };
    this.vel.set(0, 0, 0);
    this.setState(kind === 'vault' ? 'vault' : 'mantle');
  }

  // ------------------------------------------------------------ air
  st_air(dt) {
    const input = this.input;
    const md = this.moveDir(this._md || (this._md = {}));
    // air control
    if (md.len > 0.05) {
      const a = P.AIR_ACCEL * dt * (this.jumpTarget ? 0.3 : 1);
      const maxH = Math.max(P.SPEED_RUN, Math.hypot(this.vel.x, this.vel.z));
      this.vel.x += (md.x / md.len) * a * md.len;
      this.vel.z += (md.z / md.len) * a * md.len;
      const h = Math.hypot(this.vel.x, this.vel.z);
      if (h > maxH) { this.vel.x *= maxH / h; this.vel.z *= maxH / h; }
      if (!this.jumpTarget) this.yaw = dampAngle(this.yaw, Math.atan2(md.x, md.z), 5, dt);
    }
    // coyote jump
    if (input.pressed('jump') && this.time - this.lastGrounded < 0.12 && this.vel.y <= 0) {
      this.doJump();
      return;
    }
    this.vel.y -= P.GRAV * dt;
    if (this.vel.y < -40) this.vel.y = -40;
    const oldY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    if (this.pos.y > this.fallStartY) this.fallStartY = this.pos.y;

    // wall catch (ledges and walls in the direction of travel)
    if (this.tryAirCatch(md)) return;

    const contacts = this._contacts || (this._contacts = []);
    contacts.length = 0;
    this.col.pushOut(this.pos, P.R, this.pos.y + 0.3, this.pos.y + P.H - 0.05, contacts);
    // head bump
    const ceil = this.col.ceilingAt(this.pos.x, this.pos.z, P.R * 0.7, oldY + P.H - 0.3);
    if (this.pos.y + P.H > ceil && this.vel.y > 0) {
      this.pos.y = ceil - P.H;
      this.vel.y = 0;
    }
    // landing
    const g = this.col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, Math.max(this.pos.y, oldY) + 0.05, this.ground);
    if (this.vel.y <= 0 && this.pos.y <= g.y) {
      this.land(g);
    }
  }

  tryAirCatch(md) {
    if (this.vel.y > 4.5) return false;
    let dx = this.vel.x, dz = this.vel.z;
    let len = Math.hypot(dx, dz);
    if (md.len > 0.3) { dx = md.x; dz = md.z; len = md.len; }
    if (len < 0.2) return false;
    dx /= len; dz /= len;
    const y = this.pos.y;
    const reach = P.R + 0.32;
    const chest = this.probe(this.pos.x, y + 1.2, this.pos.z, dx, dz, reach);
    const hands = this.probe(this.pos.x, y + 1.8, this.pos.z, dx, dz, reach);
    const h = chest || hands;
    if (!h) return false;
    if (h.nx * dx + h.nz * dz > -0.55) return false;
    if (this.time < this.noCatchUntil && h.nx * this.noCatchNx + h.nz * this.noCatchNz > 0.9) return false;
    const top = this.wallTop(h.x, h.z, h.nx, h.nz, y + 2.6);
    if (top !== null) {
      if (top < y + 0.5) return false; // we're above it: let it be a landing
      if (top <= y + 1.45) {
        const onX = h.x - h.nx * 0.55, onZ = h.z - h.nz * 0.55;
        const room = this.standRoom(onX, top, onZ);
        if (room !== null) {
          this.landingImpact();
          this.beginTrans('mantle', { x: onX, y: room, z: onZ }, 0.32, top + 0.05);
          return true;
        }
      }
    }
    this.landingImpact();
    this.attachWall(h, 0);
    // clamp to hang if near the top
    if (top !== null && this.pos.y > top - P.HANG) this.pos.y = top - P.HANG;
    return true;
  }

  landingImpact() {
    const fall = this.fallStartY - this.pos.y;
    if (fall > 12) this.takeFallDamage?.(fall);
  }

  land(g) {
    const fall = this.fallStartY - g.y;
    this.pos.y = g.y;
    this.vel.y = 0;
    this.grounded = true;
    this.lastGrounded = this.time;
    this.jumpTarget = null;
    // hay: safe landing + hide
    const hay = this.game.city.nearestHay(this.pos.x, this.pos.z, 1.6);
    if (hay && Math.abs(g.y - hay.top) < 0.6 && fall > 1.5) {
      this.enterHay(hay, true);
      return;
    }
    if (fall > 12) this.takeFallDamage?.(fall);
    if (this.dead) return;
    this.fx.landing = clamp(fall / 8, 0.15, 1);
    this.game.audio?.play(fall > 4 ? 'landHeavy' : 'land', { pos: this.pos, volume: clamp(fall / 6, 0.3, 1) });
    if (fall > 4.5 && Math.hypot(this.vel.x, this.vel.z) > 2) this.setState('landroll');
    else this.setState('ground');
    this.noise = Math.max(this.noise, fall > 3 ? 0.8 : 0.3);
  }

  st_landroll(dt) {
    // short forward roll preserving momentum (no input)
    const f = 1 - smoothstep(0, 0.5, this.stateTime);
    const sp = Math.max(3.5, Math.hypot(this.vel.x, this.vel.z));
    this.vel.x = Math.sin(this.yaw) * sp * (0.6 + 0.4 * f);
    this.vel.z = Math.cos(this.yaw) * sp * (0.6 + 0.4 * f);
    this.integrateGround(dt);
    if (this.state === 'landroll' && this.stateTime > 0.5) this.setState('ground');
  }

  // ------------------------------------------------------------ climb
  st_climb(dt) {
    const input = this.input;
    const col = this.col;
    const w = this.wall;
    const nx = w.nx, nz = w.nz;
    const rx = nz, rz = -nx; // right along the wall (facing it)
    input.moveVector(this.mv);
    let inX = this.mv.x, inY = this.mv.y;
    // camera on the far side of the wall flips left/right
    const camFx = Math.sin(this.camYaw), camFz = Math.cos(this.camYaw);
    if (camFx * -nx + camFz * -nz < -0.2) inX = -inX;

    // eject / leaps
    if (input.pressed('jump')) {
      if (inY < -0.5) return this.wallEject();
      if (Math.abs(inX) > 0.5) { this.climbSide = Math.sign(inX); this.climbSideT = 0.32; }
      else if (!w.hanging || !this.tryMantle()) { this.climbBoost = 1.55; this.climbBoostV = 6.5; }
      this.game.audio?.play('climbLeap', { pos: this.pos, volume: 0.5 });
    }
    if (input.pressed('sneak') || input.pressed('dodge')) return this.dropFromWall();

    let dy = 0, ds = 0;
    if (this.climbBoost > 0) {
      const step = Math.min(this.climbBoost, this.climbBoostV * dt);
      dy += step;
      this.climbBoost -= step;
    } else if (inY > 0.15) dy += inY * P.CLIMB_UP * (input.held('sprint') ? 1.25 : 1) * dt;
    else if (inY < -0.15) dy += inY * P.CLIMB_DOWN * dt;
    if (this.climbSideT > 0) {
      this.climbSideT -= dt;
      ds = this.climbSide * 6.2 * dt;
    } else if (Math.abs(inX) > 0.15) ds = inX * P.CLIMB_SIDE * dt;

    // ---- sideways (with corner wrapping)
    if (ds !== 0) this.climbSideways(ds, rx, rz);

    // ---- vertical
    if (dy > 0 && !col.isFree(this.pos.x - this.wall.nx * 0.05, this.pos.z - this.wall.nz * 0.05, 0.2, this.pos.y + P.H, this.pos.y + P.H + dy + 0.05, overheadFilter)) {
      dy = 0; // overhang above
      this.climbBoost = 0;
    }
    this.pos.y += dy;
    this.climbDist += Math.abs(dy) + Math.abs(ds);
    if (this.climbDist - (this.lastClimbSound || 0) > 0.75) {
      this.lastClimbSound = this.climbDist;
      this.game.audio?.play('climb', { pos: this.pos, volume: 0.45 });
    }

    // ---- surface checks
    const y = this.pos.y;
    const n2x = this.wall.nx, n2z = this.wall.nz;
    const reach = P.CLIMB_OFF + 0.45;
    const hHands = this.probe(this.pos.x, y + 1.82, this.pos.z, -n2x, -n2z, reach);
    const hChest = this.probe(this.pos.x, y + 1.15, this.pos.z, -n2x, -n2z, reach);
    const hKnee = this.probe(this.pos.x, y + 0.45, this.pos.z, -n2x, -n2z, reach);
    const ref = hChest || hHands || hKnee;
    if (!ref) {
      // wall vanished (climbed past the top without a ledge, or it ended)
      this.vel.set(n2x * 0.5, 0, n2z * 0.5);
      this.fallStartY = this.pos.y;
      this.setState('air');
      return;
    }
    // snap to the wall
    this.pos.x = ref.x + ref.nx * P.CLIMB_OFF;
    this.pos.z = ref.z + ref.nz * P.CLIMB_OFF;
    if (ref.nx * n2x + ref.nz * n2z > 0.7) { this.wall.nx = ref.nx; this.wall.nz = ref.nz; this.wall.c = ref.c; }
    this.yaw = dampAngle(this.yaw, Math.atan2(-this.wall.nx, -this.wall.nz), 14, dt);

    // ledge detection: hands above the wall top
    this.wall.hanging = false;
    this.wall.top = null;
    if (!hHands) {
      const top = this.wallTop(ref.x, ref.z, ref.nx, ref.nz, y + 2.3);
      if (top !== null && top > y + 0.7) {
        this.wall.top = top;
        if (this.pos.y > top - P.HANG) { this.pos.y = top - P.HANG; this.climbBoost = 0; }
        this.wall.hanging = this.pos.y >= top - P.HANG - 0.08;
        if (this.wall.hanging && inY > 0.5 && this.stateTime > 0.15) {
          if (this.tryMantle()) return;
        }
      }
    }
    // reached the ground while climbing down
    const g = col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, this.pos.y + 0.3);
    if (this.pos.y - g.y < 0.12 && dy <= 0 && inY < -0.1) {
      this.pos.y = g.y;
      this.yaw = Math.atan2(-this.wall.nx, -this.wall.nz);
      this.setState('ground');
      return;
    }
    if (this.pos.y < g.y) this.pos.y = g.y;
    this.noise = Math.max(this.noise, 0.2);
  }

  climbSideways(ds, rx, rz) {
    const w = this.wall;
    const dir = Math.sign(ds);
    const sx = rx * dir, sz = rz * dir;
    const y = this.pos.y;
    const ny = this.wall.hanging ? y + 1.55 : y + 1.15;
    const nxp = this.pos.x + rx * ds, nzp = this.pos.z + rz * ds;
    // inner corner: a wall blocks the way
    const side = this.probe(this.pos.x, ny, this.pos.z, sx, sz, P.CLIMB_OFF + Math.abs(ds) + 0.02);
    if (side && side.nx * sx + side.nz * sz < -0.85) {
      const nnx = side.nx, nnz = side.nz;
      this.pos.x = side.x + nnx * P.CLIMB_OFF + w.nx * P.CLIMB_OFF;
      this.pos.z = side.z + nnz * P.CLIMB_OFF + w.nz * P.CLIMB_OFF;
      w.nx = nnx; w.nz = nnz; w.c = side.c;
      this.climbSideT = 0;
      return;
    }
    const ahead = this.probe(nxp, ny, nzp, -w.nx, -w.nz, P.CLIMB_OFF + 0.45);
    if (ahead && ahead.nx * w.nx + ahead.nz * w.nz > 0.85) {
      this.pos.x = nxp; this.pos.z = nzp;
      return;
    }
    // outer corner: wrap around the edge
    const ox = this.pos.x + sx * (P.CLIMB_OFF + 0.5) - w.nx * (P.CLIMB_OFF + 0.3);
    const oz = this.pos.z + sz * (P.CLIMB_OFF + 0.5) - w.nz * (P.CLIMB_OFF + 0.3);
    const wrap = this.probe(ox, ny, oz, -sx, -sz, 0.9);
    if (wrap && wrap.nx * sx + wrap.nz * sz > 0.85) {
      this.pos.x = wrap.x + wrap.nx * P.CLIMB_OFF;
      this.pos.z = wrap.z + wrap.nz * P.CLIMB_OFF;
      w.nx = wrap.nx; w.nz = wrap.nz; w.c = wrap.c;
      this.climbSideT = 0;
      return;
    }
    // blocked: stay
    this.climbSideT = 0;
  }

  tryMantle() {
    const w = this.wall;
    if (w.top === null) return false;
    const cx = this.pos.x - w.nx * P.CLIMB_OFF, cz = this.pos.z - w.nz * P.CLIMB_OFF;
    for (const d of [0.5, 0.78, 1.0]) {
      const onX = cx - w.nx * d, onZ = cz - w.nz * d;
      const room = this.standRoom(onX, w.top, onZ);
      if (room !== null) {
        this.beginTrans('mantle', { x: onX, y: room, z: onZ }, 0.62, w.top + 0.05);
        this.game.audio?.play('mantle', { pos: this.pos, volume: 0.6 });
        return true;
      }
    }
    return false;
  }

  wallEject() {
    const w = this.wall;
    this.vel.set(w.nx * 5.2, 5.6, w.nz * 5.2);
    this.yaw = Math.atan2(w.nx, w.nz);
    this.noCatchUntil = this.time + 0.35;
    this.noCatchNx = w.nx; this.noCatchNz = w.nz;
    this.fallStartY = this.pos.y;
    this.jumpTarget = null;
    this.setState('air');
    this.game.audio?.play('jump', { pos: this.pos, volume: 0.5 });
  }

  dropFromWall() {
    const w = this.wall;
    this.vel.set(w.nx * 1.2, 0, w.nz * 1.2);
    this.noCatchUntil = this.time + 0.4;
    this.noCatchNx = w.nx; this.noCatchNz = w.nz;
    this.fallStartY = this.pos.y;
    this.setState('air');
  }

  // ------------------------------------------------------------ transitions
  st_mantle(dt) { this.runTrans(dt); }
  st_vault(dt) { this.runTrans(dt); }

  runTrans(dt) {
    const tr = this.trans;
    if (!tr) { this.setState('ground'); return; }
    tr.t += dt;
    const u = clamp(tr.t / tr.dur, 0, 1);
    const f = tr.from, to = tr.to;
    if (tr.kind === 'vault') {
      const xz = smoothstep(0, 1, u);
      this.pos.x = lerp(f.x, to.x, xz);
      this.pos.z = lerp(f.z, to.z, xz);
      this.pos.y = u < 0.5 ? lerp(f.y, tr.apex, smoothstep(0, 0.5, u)) : lerp(tr.apex, to.y, smoothstep(0.5, 1, u));
    } else {
      // rise first, then move over the edge
      const up = smoothstep(0, 0.62, u);
      const fwd = smoothstep(0.38, 1, u);
      this.pos.y = lerp(f.y, Math.max(to.y, tr.apex), up);
      if (u > 0.85) this.pos.y = lerp(Math.max(to.y, tr.apex), to.y, (u - 0.85) / 0.15);
      this.pos.x = lerp(f.x, to.x, fwd);
      this.pos.z = lerp(f.z, to.z, fwd);
    }
    if (u >= 1) {
      this.pos.copy(to);
      this.trans = null;
      this.grounded = true;
      this.lastGrounded = this.time;
      this.setState('ground');
      // keep running if the player holds forward
      const sp = this.input.held('sprint') ? P.SPEED_SPRINT * 0.7 : 2;
      this.vel.set(Math.sin(this.yaw) * sp * this.moveAmount, 0, Math.cos(this.yaw) * sp * this.moveAmount);
    }
  }

  // ------------------------------------------------------------ hay / leap / sync
  enterHay(hay, fromFall = false) {
    this.hay = hay;
    this.pos.set(hay.x, hay.top - 0.6, hay.z);
    this.vel.set(0, 0, 0);
    this.visible = false;
    this.setState('hidden');
    this.game.audio?.play('hay', { pos: this.pos, volume: fromFall ? 1 : 0.6 });
    this.game.fx?.hayBurst(hay.x, hay.top + 0.3, hay.z, fromFall ? 1 : 0.5);
    this.game.events?.emit('hidden', hay);
  }

  exitHay() {
    const h = this.hay;
    this.hay = null;
    this.visible = true;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // pop out in the facing direction onto free ground
    let px = h.x + fx * 1.7, pz = h.z + fz * 1.7;
    if (!this.col.isFree(px, pz, P.R, 0.3, P.H)) { px = h.x - fx * 1.7; pz = h.z - fz * 1.7; }
    this.pos.set(px, 0, pz);
    const g = this.col.groundAt(px, pz, P.FOOT_R, 1.0);
    this.pos.y = g.y;
    this.prev.copy(this.pos);
    this.setState('ground');
    this.game.audio?.play('hay', { pos: this.pos, volume: 0.5 });
    this.game.fx?.hayBurst(h.x, h.top + 0.3, h.z, 0.4);
  }

  st_hidden(dt) {
    const input = this.input;
    this.vel.set(0, 0, 0);
    input.moveVector(this.mv);
    if (this.stateTime > 0.4 && (input.pressed('jump') || input.pressed('interact') && !this.hayAttackAvailable?.())) {
      this.yaw = this.camYaw;
      this.exitHay();
      return;
    }
    if (this.stateTime > 0.6 && Math.hypot(this.mv.x, this.mv.y) > 0.8) {
      const md = this.moveDir(this._md || (this._md = {}));
      this.yaw = Math.atan2(md.x, md.z);
      this.exitHay();
    }
    void dt;
  }

  /** Leap of faith from a viewpoint perch into its hay cart. */
  leapOfFaith(vp) {
    const h = vp.hay;
    this.leap = { from: this.pos.clone(), to: new THREE.Vector3(h.x, h.top, h.z), t: 0 };
    const d = Math.hypot(h.x - this.pos.x, h.z - this.pos.z);
    const height = this.pos.y - h.top;
    this.leap.dur = Math.sqrt((2 * (height + 1.2)) / P.GRAV) + 0.25;
    this.yaw = Math.atan2(h.x - this.pos.x, h.z - this.pos.z);
    this.invuln = 99;
    this.setState('leap');
    this.game.audio?.play('leap', { pos: this.pos, volume: 1 });
    void d;
  }

  st_leap(dt) {
    const L = this.leap;
    L.t += dt;
    const u = clamp(L.t / L.dur, 0, 1);
    // slight hop up then gravity curve down
    const hop = 1.2;
    this.pos.x = lerp(L.from.x, L.to.x, smoothstep(0, 1, u));
    this.pos.z = lerp(L.from.z, L.to.z, smoothstep(0, 1, u));
    const y0 = L.from.y, y1 = L.to.y;
    this.pos.y = y0 + hop * Math.sin(Math.min(1, u * 3) * Math.PI / 2) * (1 - u) + (y1 - y0) * u * u;
    if (u >= 1) {
      this.invuln = 0.5;
      const hay = this.game.city.nearestHay(L.to.x, L.to.z, 1.5);
      this.fallStartY = this.pos.y;
      if (hay) this.enterHay(hay, true);
      else this.setState('ground');
    }
  }

  st_sync(dt) {
    this.vel.set(0, 0, 0);
    void dt;
    if (this.stateTime > 3.6) this.setState('ground');
  }

  st_cutscene() { this.vel.set(0, 0, 0); }

  st_dead(dt) {
    this.vel.x = damp(this.vel.x, 0, 6, dt);
    this.vel.z = damp(this.vel.z, 0, 6, dt);
    if (!this.grounded) {
      this.vel.y -= P.GRAV * dt;
      this.pos.addScaledVector(this.vel, dt);
      const g = this.col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, this.pos.y + 0.3);
      if (this.pos.y <= g.y) { this.pos.y = g.y; this.grounded = true; this.vel.y = 0; }
    }
  }

  /** Interpolated render transform. */
  renderPos(alpha, out) {
    out.lerpVectors(this.prev, this.pos, alpha);
    out.y = this.prevVisY + (this.visY - this.prevVisY) * alpha;
    return out;
  }

  renderYaw(alpha) {
    return this.prevYaw + angleDiff(this.prevYaw, this.yaw) * alpha;
  }
}

export { wrapAngle };
