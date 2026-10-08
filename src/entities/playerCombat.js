import * as THREE from 'three';
import { Player, P } from './player.js';
import { clamp, damp, dampAngle, angleDiff, approach, yawTo, rand, lerp, smoothstep } from '../core/math.js';

// ---------------------------------------------------------------------------
// Witcher-3 style combat for the player, mixed into Player.prototype:
//  * fast attacks (combo of 4, long lunges at distant targets) and strong
//    attacks (hold for a charged "Rend"), hard lock-on, soft targeting
//  * hold block, timed parry -> riposte counter; dodge & roll with i-frames
//  * five Sigils (Pyre/Gust/Aegis/Snare/Hex) costing stamina
//  * adrenaline "Fury" pips, a hand crossbow, healing tonic
//  * AC assassinations (ground, from above, from hay, ledge) with the hidden
//    blade, and Doom glory kills on staggered demons (health orbs).
// ---------------------------------------------------------------------------

export const SIGILS = [
  { id: 'pyre', name: 'Pyre', desc: 'Cone of hellfire. Burning demons drop armor shards.', color: '#ff7a2a', cost: 50 },
  { id: 'gust', name: 'Gust', desc: 'Telekinetic blast. Knocks down lesser demons.', color: '#9fd0ff', cost: 50 },
  { id: 'aegis', name: 'Aegis', desc: 'Protective ward that absorbs a heavy blow.', color: '#ffd36a', cost: 50 },
  { id: 'snare', name: 'Snare', desc: 'Glyph trap: slows demons. Cast at a Gazer to drag it down.', color: '#c78bff', cost: 50 },
  { id: 'hex', name: 'Hex', desc: 'Stuns a demon, leaving it open to a finisher.', color: '#7dffb0', cost: 50 },
];

// Fast attack combo (normalized clips: windup -> strike -> follow-through)
const LIGHT = [
  { dur: 0.46, hit: [0.36, 0.56], dmg: 18, reach: 2.45, arc: 2.2, poise: 8, clip: 'l1', lunge: 0.9 },
  { dur: 0.44, hit: [0.34, 0.54], dmg: 18, reach: 2.45, arc: 2.2, poise: 8, clip: 'l2', lunge: 0.9 },
  { dur: 0.5, hit: [0.38, 0.6], dmg: 22, reach: 2.7, arc: 1.2, poise: 12, clip: 'l3', lunge: 1.4 },
  { dur: 0.62, hit: [0.36, 0.62], dmg: 28, reach: 2.6, arc: 6.3, poise: 16, clip: 'l4', lunge: 0.6, spin: true },
];
const HEAVY = [
  { dur: 0.86, hit: [0.48, 0.66], dmg: 46, reach: 2.7, arc: 2.0, poise: 32, clip: 'h1', lunge: 1.1 },
  { dur: 0.9, hit: [0.42, 0.68], dmg: 52, reach: 2.8, arc: 6.3, poise: 36, clip: 'h2', lunge: 0.7, spin: true },
];
const REND = { dur: 0.9, hit: [0.3, 0.52], dmg: 120, reach: 3.1, arc: 2.4, poise: 90, clip: 'h1', lunge: 2.2, rend: true };

export const PLAYER_CLIPS = {
  l1: [
    { t: 0, pose: { armR: [-1.5, -0.5, -1.1], foreR: [-0.7, 0, 0], handR: [0.3, 0, 0], spine: [0.1, -0.55, 0], chest: [0.05, -0.35, 0], armL: [-0.4, 0, 0.55], foreL: [-1.1, 0, 0], thighL: [-0.5, 0, 0.1], shinL: [0.5, 0, 0], thighR: [0.25, 0, -0.1], shinR: [0.35, 0, 0] } },
    { t: 0.35, pose: { armR: [-1.6, -0.4, -1.25], foreR: [-0.5, 0, 0], handR: [0.2, 0, 0], spine: [0.12, -0.65, 0], chest: [0.05, -0.4, 0], armL: [-0.4, 0, 0.55], foreL: [-1.1, 0, 0], thighL: [-0.55, 0, 0.1], shinL: [0.55, 0, 0], thighR: [0.25, 0, -0.1], shinR: [0.35, 0, 0] } },
    { t: 0.55, pose: { armR: [-1.45, 0.9, -0.35], foreR: [-0.1, 0, 0], handR: [0, 0, 0], spine: [0.18, 0.55, 0], chest: [0.08, 0.4, 0], armL: [-0.1, 0, 0.7], foreL: [-0.9, 0, 0], thighL: [-0.7, 0, 0.1], shinL: [0.6, 0, 0], thighR: [0.35, 0, -0.1], shinR: [0.4, 0, 0] } },
    { t: 1, pose: { armR: [-0.9, 1.0, -0.2], foreR: [-0.5, 0, 0], spine: [0.15, 0.45, 0], chest: [0.06, 0.25, 0], armL: [-0.2, 0, 0.55], foreL: [-1.0, 0, 0], thighL: [-0.55, 0, 0.1], shinL: [0.55, 0, 0], thighR: [0.25, 0, -0.1], shinR: [0.35, 0, 0] } },
  ],
  l2: [
    { t: 0, pose: { armR: [-1.4, 0.95, -0.25], foreR: [-0.6, 0, 0], spine: [0.12, 0.55, 0], chest: [0.05, 0.35, 0], armL: [-0.2, 0, 0.5], foreL: [-1.0, 0, 0], thighL: [-0.3, 0, 0.1], thighR: [0.3, 0, -0.1], shinL: [0.4, 0, 0], shinR: [0.45, 0, 0] } },
    { t: 0.33, pose: { armR: [-1.5, 1.05, -0.2], foreR: [-0.4, 0, 0], spine: [0.12, 0.65, 0], chest: [0.05, 0.4, 0], armL: [-0.2, 0, 0.5], foreL: [-1.0, 0, 0], thighL: [-0.3, 0, 0.1], thighR: [0.3, 0, -0.1] } },
    { t: 0.54, pose: { armR: [-1.4, -0.6, -1.2], foreR: [-0.1, 0, 0], spine: [0.15, -0.6, 0], chest: [0.08, -0.4, 0], armL: [-0.5, 0, 0.6], foreL: [-1.2, 0, 0], thighL: [-0.6, 0, 0.1], thighR: [0.4, 0, -0.1], shinL: [0.6, 0, 0], shinR: [0.35, 0, 0] } },
    { t: 1, pose: { armR: [-1.0, -0.5, -0.9], foreR: [-0.6, 0, 0], spine: [0.12, -0.45, 0], chest: [0.05, -0.25, 0], armL: [-0.4, 0, 0.55], foreL: [-1.1, 0, 0], thighL: [-0.5, 0, 0.1], thighR: [0.3, 0, -0.1] } },
  ],
  l3: [
    { t: 0, pose: { armR: [-0.7, 0, -0.25], foreR: [-1.6, 0, 0], handR: [0.6, 0, 0], spine: [0.0, -0.3, 0], chest: [0, -0.2, 0], armL: [-0.6, 0, 0.4], foreL: [-1.2, 0, 0], thighL: [-0.3, 0, 0], thighR: [0.3, 0, 0] } },
    { t: 0.36, pose: { armR: [-0.6, 0, -0.2], foreR: [-1.8, 0, 0], handR: [0.7, 0, 0], spine: [-0.05, -0.35, 0], chest: [0, -0.2, 0], thighL: [-0.4, 0, 0], thighR: [0.3, 0, 0] } },
    { t: 0.56, pose: { armR: [-1.6, 0.1, -0.05], foreR: [-0.05, 0, 0], handR: [0.1, 0, 0], spine: [0.42, 0.2, 0], chest: [0.15, 0.1, 0], armL: [0.3, 0, 0.5], foreL: [-0.6, 0, 0], thighL: [-1.0, 0, 0.05], shinL: [0.9, 0, 0], thighR: [0.55, 0, 0], shinR: [0.3, 0, 0] } },
    { t: 1, pose: { armR: [-1.2, 0.2, -0.1], foreR: [-0.4, 0, 0], spine: [0.3, 0.15, 0], armL: [0.1, 0, 0.5], thighL: [-0.8, 0, 0.05], shinL: [0.8, 0, 0], thighR: [0.45, 0, 0] } },
  ],
  l4: [
    { t: 0, pose: { armR: [-1.3, -0.4, -1.3], foreR: [-0.3, 0, 0], spine: [0.1, -0.5, 0], armL: [-0.2, 0, 1.0], foreL: [-0.3, 0, 0], thighL: [-0.4, 0, 0.2], thighR: [0.3, 0, -0.2], shinL: [0.6, 0, 0], shinR: [0.5, 0, 0] } },
    { t: 0.5, pose: { armR: [-1.5, 0.2, -1.45], foreR: [0, 0, 0], spine: [0.15, 0.2, 0], armL: [-0.2, 0, 1.2], foreL: [-0.2, 0, 0], thighL: [-0.5, 0, 0.25], thighR: [0.3, 0, -0.25], shinL: [0.7, 0, 0], shinR: [0.5, 0, 0] } },
    { t: 1, pose: { armR: [-1.1, 0.6, -0.9], foreR: [-0.4, 0, 0], spine: [0.15, 0.4, 0], armL: [-0.2, 0, 0.7], foreL: [-0.6, 0, 0], thighL: [-0.4, 0, 0.1], thighR: [0.3, 0, -0.1] } },
  ],
  h1: [
    { t: 0, pose: { armR: [-2.9, 0.1, -0.35], foreR: [-0.9, 0, 0], handR: [-0.2, 0, 0], armL: [-2.6, 0, 0.2], foreL: [-1.1, 0, 0], spine: [-0.25, -0.15, 0], chest: [-0.15, 0, 0], head: [0.15, 0, 0], thighL: [-0.5, 0, 0.1], thighR: [0.3, 0, -0.1], shinL: [0.5, 0, 0], shinR: [0.4, 0, 0] } },
    { t: 0.45, pose: { armR: [-3.05, 0.1, -0.3], foreR: [-1.05, 0, 0], handR: [-0.35, 0, 0], armL: [-2.7, 0, 0.2], foreL: [-1.2, 0, 0], spine: [-0.32, -0.2, 0], chest: [-0.2, 0, 0], head: [0.2, 0, 0], thighL: [-0.5, 0, 0.1], thighR: [0.3, 0, -0.1] } },
    { t: 0.62, pose: { armR: [-0.85, 0.05, -0.1], foreR: [-0.05, 0, 0], handR: [0.5, 0, 0], armL: [-0.6, 0, 0.3], foreL: [-0.5, 0, 0], spine: [0.75, 0.05, 0], chest: [0.25, 0, 0], head: [-0.4, 0, 0], thighL: [-1.1, 0, 0.1], shinL: [1.2, 0, 0], thighR: [0.6, 0, -0.1], shinR: [0.6, 0, 0] } },
    { t: 1, pose: { armR: [-0.7, 0.05, -0.2], foreR: [-0.4, 0, 0], armL: [-0.4, 0, 0.4], foreL: [-0.8, 0, 0], spine: [0.5, 0, 0], chest: [0.15, 0, 0], head: [-0.3, 0, 0], thighL: [-0.9, 0, 0.1], shinL: [1.0, 0, 0], thighR: [0.5, 0, -0.1], shinR: [0.5, 0, 0] } },
  ],
  h2: [
    { t: 0, pose: { armR: [-1.0, -0.6, -1.4], foreR: [-0.4, 0, 0], spine: [0.15, -0.7, 0], chest: [0.05, -0.4, 0], armL: [-0.3, 0, 0.9], foreL: [-0.6, 0, 0], thighL: [-0.6, 0, 0.25], thighR: [0.3, 0, -0.25], shinL: [0.9, 0, 0], shinR: [0.6, 0, 0] } },
    { t: 0.5, pose: { armR: [-1.45, 0.2, -1.5], foreR: [0, 0, 0], spine: [0.2, 0.1, 0], chest: [0.05, 0.1, 0], armL: [-0.2, 0, 1.3], foreL: [-0.2, 0, 0], thighL: [-0.7, 0, 0.3], thighR: [0.35, 0, -0.3], shinL: [1.0, 0, 0], shinR: [0.6, 0, 0] } },
    { t: 1, pose: { armR: [-1.0, 0.6, -0.9], foreR: [-0.4, 0, 0], spine: [0.2, 0.5, 0], armL: [-0.3, 0, 0.6], foreL: [-0.7, 0, 0], thighL: [-0.5, 0, 0.1], thighR: [0.3, 0, -0.1] } },
  ],
  block: [
    { t: 0, pose: { armR: [-1.05, 1.15, -0.2], foreR: [-1.05, 0, 0], handR: [0.2, 0, 0.3], armL: [-0.9, 0, 0.55], foreL: [-1.5, 0, 0], spine: [0.14, -0.1, 0], chest: [0.05, -0.1, 0], head: [-0.1, 0.1, 0], thighL: [-0.5, -0.2, 0.12], shinL: [0.65, 0, 0], thighR: [0.15, -0.3, -0.12], shinR: [0.5, 0, 0] } },
  ],
  parry: [
    { t: 0, pose: { armR: [-1.6, 1.2, -0.4], foreR: [-0.7, 0, 0], handR: [0.3, 0, 0.5], spine: [0.0, 0.25, 0], chest: [-0.05, 0.15, 0], armL: [-0.6, 0, 0.6], foreL: [-1.2, 0, 0] } },
    { t: 1, pose: { armR: [-1.05, 1.15, -0.2], foreR: [-1.05, 0, 0], handR: [0.2, 0, 0.3], armL: [-0.9, 0, 0.55], foreL: [-1.5, 0, 0], spine: [0.14, -0.1, 0] } },
  ],
  counter: [
    { t: 0, pose: { armR: [-1.6, 1.2, -0.4], foreR: [-0.7, 0, 0], spine: [0.0, 0.3, 0] } },
    { t: 0.4, pose: { armR: [-0.8, 0, -0.2], foreR: [-1.7, 0, 0], handR: [0.6, 0, 0], spine: [0.05, -0.35, 0], thighL: [-0.5, 0, 0], thighR: [0.3, 0, 0] } },
    { t: 0.6, pose: { armR: [-1.6, 0.05, -0.05], foreR: [-0.05, 0, 0], handR: [0.1, 0, 0], spine: [0.45, 0.15, 0], chest: [0.15, 0, 0], armL: [0.3, 0, 0.5], thighL: [-1.0, 0, 0.05], shinL: [0.9, 0, 0], thighR: [0.55, 0, 0] } },
    { t: 1, pose: { armR: [-1.2, 0.2, -0.1], foreR: [-0.4, 0, 0], spine: [0.3, 0.15, 0], thighL: [-0.7, 0, 0.05], shinL: [0.7, 0, 0], thighR: [0.4, 0, 0] } },
  ],
  dodge: [
    { t: 0, pose: { spine: [0.2, 0, 0], thighL: [-0.6, 0, 0.35], thighR: [-0.1, 0, -0.45], shinL: [0.9, 0, 0], shinR: [0.6, 0, 0], armL: [-0.4, 0, 0.6], armR: [-0.6, 0.3, -0.5], foreR: [-1.0, 0, 0] } },
    { t: 1, pose: { spine: [0.12, 0, 0], thighL: [-0.45, 0, 0.12], thighR: [0.15, 0, -0.12], shinL: [0.6, 0, 0], shinR: [0.45, 0, 0], armL: [-0.3, 0, 0.42], armR: [-0.55, 0.1, -0.32], foreR: [-1.15, 0, 0] } },
  ],
  roll: [
    { t: 0, pose: { spine: [0.9, 0, 0], chest: [0.4, 0, 0], head: [0.5, 0, 0], thighL: [-1.9, 0, 0.1], thighR: [-1.9, 0, -0.1], shinL: [2.4, 0, 0], shinR: [2.4, 0, 0], armL: [-1.1, 0, 0.3], armR: [-1.1, 0, -0.3], foreL: [-1.5, 0, 0], foreR: [-1.5, 0, 0] } },
    { t: 1, pose: { spine: [0.9, 0, 0], chest: [0.4, 0, 0], head: [0.5, 0, 0], thighL: [-1.9, 0, 0.1], thighR: [-1.9, 0, -0.1], shinL: [2.4, 0, 0], shinR: [2.4, 0, 0], armL: [-1.1, 0, 0.3], armR: [-1.1, 0, -0.3], foreL: [-1.5, 0, 0], foreR: [-1.5, 0, 0] } },
  ],
  cast: [
    { t: 0, pose: { armL: [-0.6, 0, 0.6], foreL: [-2.0, 0, 0], handL: [0, 0, 0], spine: [0.0, -0.35, 0], chest: [0, -0.2, 0], armR: [-0.3, 0, -0.5], foreR: [-0.9, 0, 0] } },
    { t: 0.35, pose: { armL: [-1.65, 0.3, 0.15], foreL: [-0.05, 0, 0], handL: [-0.6, 0, 0], spine: [0.12, 0.35, 0], chest: [0.05, 0.2, 0], armR: [0.2, 0, -0.5], foreR: [-0.6, 0, 0], thighL: [-0.7, 0, 0.1], shinL: [0.6, 0, 0], thighR: [0.4, 0, -0.1] } },
    { t: 1, pose: { armL: [-1.4, 0.2, 0.25], foreL: [-0.3, 0, 0], handL: [-0.4, 0, 0], spine: [0.1, 0.25, 0], armR: [0.1, 0, -0.5], foreR: [-0.7, 0, 0], thighL: [-0.6, 0, 0.1], shinL: [0.5, 0, 0], thighR: [0.35, 0, -0.1] } },
  ],
  hit: [
    { t: 0, pose: { spine: [-0.4, 0.2, 0], chest: [-0.2, 0, 0], head: [-0.4, 0, 0], armL: [0.3, 0, 0.7], armR: [0.3, 0, -0.7], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0], thighL: [-0.2, 0, 0], shinL: [0.4, 0, 0], thighR: [0.3, 0, 0] } },
    { t: 1, pose: { spine: [0.1, 0, 0], armL: [-0.3, 0, 0.4], armR: [-0.5, 0, -0.3], foreL: [-1.0, 0, 0], foreR: [-1.0, 0, 0] } },
  ],
  knockdown: [
    { t: 0, pose: { spine: [-0.3, 0, 0], head: [0.4, 0, 0], armL: [-0.5, 0, 1.0], armR: [-0.5, 0, -1.0], thighL: [-0.6, 0, 0.2], shinL: [1.2, 0, 0], thighR: [-0.3, 0, -0.2], shinR: [0.6, 0, 0] } },
    { t: 0.8, pose: { spine: [-0.3, 0, 0], head: [0.4, 0, 0], armL: [-0.5, 0, 1.0], armR: [-0.5, 0, -1.0], thighL: [-0.6, 0, 0.2], shinL: [1.2, 0, 0], thighR: [-0.3, 0, -0.2], shinR: [0.6, 0, 0] } },
    { t: 1, pose: { spine: [0.6, 0, 0], thighL: [-1.4, 0, 0.1], shinL: [2.0, 0, 0], thighR: [-0.4, 0, -0.1], shinR: [1.2, 0, 0], armL: [0.3, 0, 0.3], armR: [0.3, 0, -0.3] } },
  ],
  assassinate: [
    { t: 0, pose: { armL: [-0.4, 0, 0.3], foreL: [-1.9, 0, 0], handL: [0.4, 0, 0], armR: [-1.2, 0, -0.1], foreR: [-0.7, 0, 0], spine: [0.15, -0.2, 0], thighL: [-0.6, 0, 0.1], shinL: [0.8, 0, 0], thighR: [0.2, 0, -0.1] } },
    { t: 0.4, pose: { armL: [-1.7, 0.2, 0.05], foreL: [-0.2, 0, 0], handL: [-0.3, 0, 0], armR: [-1.45, 0, 0.25], foreR: [-0.9, 0, 0], spine: [0.3, 0.25, 0], chest: [0.1, 0.1, 0], thighL: [-0.9, 0, 0.1], shinL: [1.0, 0, 0], thighR: [0.4, 0, -0.1], shinR: [0.4, 0, 0] } },
    { t: 1, pose: { armL: [-1.5, 0.2, 0.1], foreL: [-0.4, 0, 0], armR: [-1.0, 0, 0.1], foreR: [-0.8, 0, 0], spine: [0.35, 0.15, 0], thighL: [-0.8, 0, 0.1], shinL: [1.0, 0, 0], thighR: [0.3, 0, -0.1] } },
  ],
  airAssassinate: [
    { t: 0, pose: { armL: [-2.8, 0, 0.3], foreL: [-0.4, 0, 0], armR: [-2.4, 0, -0.6], foreR: [-0.6, 0, 0], spine: [-0.2, 0, 0], thighL: [-1.4, 0, 0.1], shinL: [1.8, 0, 0], thighR: [-0.6, 0, -0.1], shinR: [1.0, 0, 0] } },
    { t: 0.6, pose: { armL: [-1.2, 0, 0.2], foreL: [-0.1, 0, 0], armR: [-1.0, 0, -0.5], foreR: [-0.5, 0, 0], spine: [0.7, 0, 0], chest: [0.2, 0, 0], thighL: [-1.8, 0, 0.15], shinL: [2.3, 0, 0], thighR: [-1.4, 0, -0.15], shinR: [2.0, 0, 0] } },
    { t: 1, pose: { armL: [-1.0, 0, 0.2], foreL: [-0.2, 0, 0], armR: [-0.6, 0, -0.5], foreR: [-0.5, 0, 0], spine: [0.75, 0, 0], chest: [0.2, 0, 0], thighL: [-1.8, 0, 0.15], shinL: [2.3, 0, 0], thighR: [-1.5, 0, -0.15], shinR: [2.2, 0, 0] } },
  ],
  glory1: [
    { t: 0, pose: { armL: [-1.2, 0, 0.4], foreL: [-0.6, 0, 0], armR: [-0.5, 0, -0.3], foreR: [-1.8, 0, 0], handR: [0.8, 0, 0], spine: [0.0, -0.35, 0], thighL: [-0.6, 0, 0.1], shinL: [0.6, 0, 0], thighR: [0.3, 0, -0.1] } },
    { t: 0.3, pose: { armL: [-1.4, 0, 0.3], foreL: [-0.3, 0, 0], armR: [-1.65, 0, -0.05], foreR: [-0.05, 0, 0], handR: [0.1, 0, 0], spine: [0.45, 0.2, 0], chest: [0.15, 0, 0], thighL: [-1.0, 0, 0.1], shinL: [0.9, 0, 0], thighR: [0.55, 0, -0.1] } },
    { t: 0.55, pose: { armL: [-1.3, 0, 0.3], armR: [-1.7, 0, -0.1], foreR: [-0.1, 0, 0], spine: [0.5, 0.25, 0], chest: [0.2, 0.1, 0], thighL: [-1.0, 0, 0.1], shinL: [0.9, 0, 0], thighR: [0.55, 0, -0.1] } },
    { t: 0.75, pose: { armR: [-3.0, 0.2, -0.3], foreR: [-0.3, 0, 0], handR: [-0.3, 0, 0], armL: [-0.4, 0, 0.6], spine: [-0.15, -0.15, 0], chest: [-0.1, 0, 0], thighL: [-0.6, 0, 0.1], thighR: [0.3, 0, -0.1] } },
    { t: 1, pose: { armR: [-1.2, 0.3, -0.3], foreR: [-0.6, 0, 0], armL: [-0.4, 0, 0.5], foreL: [-1.0, 0, 0], spine: [0.2, 0.2, 0] } },
  ],
  glory2: [
    { t: 0, pose: { armR: [-1.4, -0.6, -1.3], foreR: [-0.3, 0, 0], spine: [0.15, -0.6, 0], chest: [0.05, -0.3, 0], armL: [-0.8, 0, 0.6], foreL: [-1.3, 0, 0], thighL: [-0.6, 0, 0.2], shinL: [0.8, 0, 0], thighR: [0.3, 0, -0.2] } },
    { t: 0.4, pose: { armR: [-1.5, 1.0, -0.4], foreR: [0, 0, 0], spine: [0.2, 0.7, 0], chest: [0.1, 0.4, 0], armL: [-0.3, 0, 0.8], foreL: [-0.8, 0, 0], thighL: [-0.8, 0, 0.2], shinL: [0.9, 0, 0], thighR: [0.5, 0, -0.2] } },
    { t: 0.6, pose: { armR: [-2.8, 0.3, -0.5], foreR: [-0.5, 0, 0], spine: [-0.1, 0.2, 0], armL: [-0.5, 0, 0.7] } },
    { t: 0.8, pose: { armR: [-0.7, 0.1, -0.2], foreR: [0, 0, 0], spine: [0.7, 0, 0], chest: [0.3, 0, 0], thighL: [-1.2, 0, 0.1], shinL: [1.3, 0, 0], thighR: [0.6, 0, -0.1] } },
    { t: 1, pose: { armR: [-0.8, 0.2, -0.3], foreR: [-0.5, 0, 0], spine: [0.4, 0, 0] } },
  ],
  // hand crossbow in the left hand: raise, aim along the arm, kick, lower.
  // The torso turns right to bring the left shoulder forward; armL z swings the
  // arm back onto the target line (playerView adds the up/down aim).
  shoot: [
    { t: 0, pose: { hips: [0, 0.1, 0], armL: [-0.7, 0, 0.3], foreL: [-0.9, 0, 0], spine: [0, -0.1, 0], chest: [0, -0.05, 0] } },
    { t: 0.3, pose: { hips: [0, 0, 0], armL: [-1.55, 0, 0.44], foreL: [-0.06, 0, 0], handL: [0.1, 0, 0], spine: [0.02, -0.25, 0], chest: [0, -0.2, 0], head: [0, 0.4, 0] } },
    { t: 0.4, pose: { hips: [0, 0, 0], armL: [-1.66, 0, 0.44], foreL: [-0.12, 0, 0], handL: [-0.1, 0, 0], spine: [-0.02, -0.25, 0], chest: [-0.04, -0.2, 0], head: [0, 0.4, 0] } },
    { t: 0.75, pose: { hips: [0, 0, 0], armL: [-1.52, 0, 0.42], foreL: [-0.1, 0, 0], spine: [0.02, -0.22, 0], chest: [0, -0.18, 0], head: [0, 0.35, 0] } },
    { t: 1, pose: { hips: [0, 0.15, 0], armL: [-0.4, 0, 0.15], foreL: [-0.6, 0, 0] } },
  ],
  tonic: [
    { t: 0, pose: { armL: [-0.6, 0, 0.3], foreL: [-1.6, 0, 0], head: [0, 0, 0] } },
    { t: 0.3, pose: { armL: [-0.9, 0.3, 0.1], foreL: [-2.3, 0, 0], handL: [-0.6, 0, 0], head: [-0.45, 0, 0], spine: [-0.1, 0, 0] } },
    { t: 0.8, pose: { armL: [-0.9, 0.3, 0.1], foreL: [-2.3, 0, 0], handL: [-0.6, 0, 0], head: [-0.5, 0, 0], spine: [-0.12, 0, 0] } },
    { t: 1, pose: { armL: [-0.3, 0, 0.3], foreL: [-1.0, 0, 0] } },
  ],
  rend: [
    { t: 0, pose: { armR: [-3.0, 0.1, -0.35], foreR: [-1.1, 0, 0], handR: [-0.4, 0, 0], armL: [-2.6, 0, 0.25], foreL: [-1.2, 0, 0], spine: [-0.35, -0.25, 0], chest: [-0.2, 0, 0], thighL: [-0.7, 0, 0.15], shinL: [0.9, 0, 0], thighR: [0.4, 0, -0.15], shinR: [0.7, 0, 0] } },
  ],
};

const _v = new THREE.Vector3();
const BOLTS = 10; // crossbow bolts carried without upgrades
const BOLT_SPEED = 62;

// ------------------------------------------------------------------ mixin
const C = {
  initCombat() {
    this.maxStamina = 100;
    this.stamina = 100;
    this.staminaDelay = 0;
    this.fury = 0;
    this.furyHits = 0;
    this.bolts = BOLTS;
    this.maxBolts = BOLTS;
    this.tonics = 3;
    this.maxTonics = 3;
    this.sigil = 0;
    this.lockTarget = null;
    this.combo = 0;
    this.comboT = 0;
    this.attackDef = null;
    this.attackHits = new Set();
    this.queued = null;
    this.blocking = false;
    this.blockStart = -9;
    this.aegis = 0; // ward hit points
    this.aegisT = 0;
    this.lastHitT = -9;
    this.combatT = 0;
    this.drawn = false;
    this.anim = null;
    this.hiddenBladeOut = false;
    this.healOverTime = 0;
    this.upgrades = this.upgrades || {};
    this.dmgMul = 1;
    this.sigilMul = 1;
    this.stealthMul = 1;
    this.applyUpgrades();
    this.prompt = null;
  },

  applyUpgrades() {
    const u = this.upgrades || {};
    this.maxHp = 150 + (u.vitality || 0) * 30;
    this.maxStamina = 100 + (u.vigor || 0) * 30;
    this.staminaRegen = 22 + (u.vigor || 0) * 7;
    this.dmgMul = 1 + (u.blade || 0) * 0.18;
    this.sigilMul = 1 + (u.sigils || 0) * 0.3;
    this.maxBolts = BOLTS + (u.quiver || 0) * 4;
    this.maxTonics = 3 + (u.tonic || 0);
    this.stealthMul = 1 - (u.shadow || 0) * 0.2;
    this.hp = Math.min(this.hp, this.maxHp);
  },

  heal(v) { this.hp = Math.min(this.maxHp, this.hp + v); },

  inCombatStance() {
    return this.drawn && (this.state === 'ground' || this.state === 'landroll');
  },

  isAttacking() {
    return this.state === 'attack' || this.state === 'counter';
  },

  facingOverride() {
    if (this.lockTarget && !this.lockTarget.dead && this.drawn) return yawTo(this.pos.x, this.pos.z, this.lockTarget.pos.x, this.lockTarget.pos.z);
    return null;
  },

  // Witcher: Space rolls while fighting up close (locked on or a demon within
  // a few metres). Sprinting always jumps, so rooftop escapes stay possible.
  consumeJumpForCombat() {
    // Space at a synced perch = Leap of Faith (AC muscle memory)
    if (this.prompt && this.prompt.kind === 'leap') { this.prompt.run(); return true; }
    if (!this.drawn || this.sprinting) return false;
    const locked = this.lockTarget && !this.lockTarget.dead && this.distTo(this.lockTarget) < 9;
    if (!locked && this.nearestThreat(5.5) === null) return false;
    this.startDodge(true);
    return true;
  },

  nearestThreat(range) {
    let best = null, bd = range;
    for (const e of this.game.director.enemies) {
      if (e.dead || !e.alerted) continue;
      const d = this.distTo(e);
      if (d < bd && Math.abs(e.pos.y - this.pos.y) < 2.5) { bd = d; best = e; }
    }
    return best;
  },

  // ------------------------------------------------------------ per tick
  combatTick(dt) {
    const input = this.input;
    const game = this.game;
    // resources
    this.staminaDelay -= dt;
    if (this.staminaDelay <= 0 && this.state !== 'sprint') this.stamina = Math.min(this.maxStamina, this.stamina + this.staminaRegen * dt);
    if (this.healOverTime > 0) {
      const h = Math.min(this.healOverTime, 25 * dt);
      this.healOverTime -= h;
      this.heal(h);
    }
    if (this.aegisT > 0) { this.aegisT -= dt; if (this.aegisT <= 0) this.aegis = 0; }
    if (this.dead) return;

    // combat stance management (draw when demons are hunting us)
    const cs = game.director.combatState();
    this.combatT = cs.close > 0 ? 3 : Math.max(0, this.combatT - dt);
    const wantDrawn = cs.close > 0 || this.combatT > 0 || this.isAttacking() || this.state === 'block';
    if (wantDrawn !== this.drawn && (this.state === 'ground' || this.state === 'attack')) {
      this.drawn = wantDrawn;
      game.playerView?.setDrawn(wantDrawn);
      if (wantDrawn) game.audio?.play('swing', { pos: this.pos, volume: 0.25, pitch: 1.6 });
    }
    // lock-on target
    if (this.lockTarget && (this.lockTarget.dead || this.distTo(this.lockTarget) > 22)) this.lockTarget = null;
    if (input.pressed('lock')) {
      if (this.lockTarget) this.lockTarget = this.nextLockTarget(this.lockTarget);
      else this.lockTarget = this.bestTarget(18, 1.2, true, true);
      if (!this.lockTarget && input.actions.lock.down) this.lockTarget = null;
    }
    // sigil selection
    if (input.pressed('sigilNext')) this.sigil = (this.sigil + 1) % SIGILS.length;
    if (input.pressed('sigilPrev')) this.sigil = (this.sigil + SIGILS.length - 1) % SIGILS.length;
    for (let i = 0; i < 5; i++) if (input.pressed('sigil' + (i + 1))) this.sigil = i;

    this.updatePrompt();
    const st = this.state;
    const free = st === 'ground' || st === 'landroll';
    if (free) {
      // context action: glory kill / assassination / interaction
      if (input.pressed('interact') && this.prompt) { this.doPrompt(); return; }
      if (input.buffered('attack', 0.18)) {
        input.consume('attack');
        if (input.held('sprint') && this.speed2d > 5.5 && !this.drawn) this.startAttack('heavy');
        else this.startAttack(input.keyHeld('sprint') ? 'heavy' : 'light');
        return;
      }
      if (input.buffered('heavy', 0.18)) { input.consume('heavy'); this.startAttack('heavy'); return; }
      if (input.pressed('dodge')) { this.startDodge(false); return; }
      if (input.pressed('cast')) { this.castSigil(); return; }
      if (input.pressed('crossbow')) { this.shootCrossbow(); return; }
      if (input.pressed('tonic')) { this.drinkTonic(); return; }
      if (input.held('block')) {
        if (this.drawn) { this.setState('block'); this.blockStart = this.time; this.blocking = true; this.anim = { clip: 'block', t: 0 }; return; }
        // toggled block with nothing to guard against doesn't stay switched on
        input.unlatch('block');
      }
    } else if (st === 'air' || st === 'climb') {
      if (input.pressed('interact') && this.prompt && (this.prompt.kind === 'airAssassinate' || this.prompt.kind === 'ledgeAssassinate')) { this.doPrompt(); return; }
      if (st === 'air' && input.pressed('crossbow')) this.shootCrossbow(true);
    } else if (st === 'hidden') {
      if (input.pressed('interact') && this.prompt && this.prompt.kind === 'hayAssassinate') { this.doPrompt(); return; }
    }
  },

  distTo(e) { return Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z); },

  /**
   * Best target in front of the player / camera within range. Melee looks at
   * about the player's own height; `ranged` (crossbow, lock-on, Hex) takes any
   * demon in sight: Gazers overhead, or demons in the street below a rooftop.
   */
  bestTarget(range = 6, cone = 1.4, useMove = true, ranged = false) {
    let best = null, bestScore = Infinity;
    let dirYaw = this.camYaw;
    if (useMove) {
      const md = this.moveDir(this._mdc || (this._mdc = {}));
      if (md.len > 0.3) dirYaw = Math.atan2(md.x, md.z);
    }
    for (const e of this.game.director.enemies) {
      if (e.dead || e.state === 'spawn') continue;
      const dy = e.pos.y - this.pos.y;
      if (ranged ? dy > 16 || dy < -22 : Math.abs(dy) > (e.def.flies ? 6 : 2.5)) continue;
      const d = this.distTo(e);
      if (d > range) continue;
      const ang = Math.abs(angleDiff(dirYaw, yawTo(this.pos.x, this.pos.z, e.pos.x, e.pos.z)));
      if (ang > cone && d > 2.2) continue;
      const score = d + ang * 3 - (e.alerted ? 1 : 0) + (ranged ? Math.abs(dy) * 0.1 : 0);
      if (score >= bestScore) continue;
      if (ranged && !this.canSee(e)) continue;
      bestScore = score; best = e;
    }
    return best;
  },

  /** Where to aim at a demon: the body of a Gazer, the chest of anything that walks. */
  aimPoint(e, out) {
    return out.set(e.pos.x, e.pos.y + (e.def.flies ? 0 : e.def.height * (e.def.modelScale || 1) * 0.62), e.pos.z);
  },

  /** Clear line from the player's eyes to a demon. */
  canSee(e) {
    const a = this.aimPoint(e, _v);
    return this.game.collision.lineClear(this.pos.x, this.pos.y + 1.55, this.pos.z, a.x, a.y, a.z);
  },

  nextLockTarget(cur) {
    const list = this.game.director.enemies.filter((e) => !e.dead && e !== cur && this.distTo(e) < 18);
    if (!list.length) return null;
    list.sort((a, b) => this.distTo(a) - this.distTo(b));
    return list[0];
  },

  // ------------------------------------------------------------ prompts
  updatePrompt() {
    const game = this.game;
    this.prompt = null;
    const st = this.state;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let best = null, bestD = 99;
    for (const e of game.director.enemies) {
      if (e.dead || e.state === 'spawn' || e.state === 'grabbed') continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const dy = e.pos.y - this.pos.y;
      if (d > 7) continue;
      // the kneeling Cardinal: climb up and strike his heart
      if (e.def.boss && e.state === 'dazed' && (st === 'ground' || st === 'landroll') && d < 5.5) {
        best = { kind: 'glory', enemy: e, label: 'Strike the Heart', boss: true };
        bestD = -1;
        continue;
      }
      // glory kill (Doom)
      if ((st === 'ground' || st === 'landroll') && e.gloryable && d < 3.2 + (e.def.heavy ? 0.8 : 0) && Math.abs(dy) < 2.5) {
        if (d < bestD + 1) { best = { kind: 'glory', enemy: e, label: 'Glory Kill' }; bestD = d - 1; }
        continue;
      }
      if (!e.def.canAssassinate) continue;
      const unaware = !e.alerted || e.state === 'stagger' || e.state === 'dazed';
      // ground assassination: from behind/side or unaware, close
      if ((st === 'ground' || st === 'landroll') && Math.abs(dy) < 1.2 && d < 2.4 && (unaware || e.state === 'knockdown')) {
        const behind = Math.cos(angleDiff(e.yaw, Math.atan2(-dx, -dz))) < 0.3 || !e.alerted;
        if (behind && d < bestD) { best = { kind: 'assassinate', enemy: e, label: 'Assassinate' }; bestD = d; }
      }
      // air assassination: enemy below within a cone
      if ((st === 'air' || st === 'ground') && dy < -1.4 && dy > -12 && d < Math.max(2.5, -dy * 0.75) && d < 6) {
        if (st === 'ground') {
          // standing on a ledge above: must face roughly toward it
          const fdot = (dx * fx + dz * fz) / (d || 1);
          if (fdot < 0.3 && d > 1.2) continue;
          if (!this.col.lineClear(this.pos.x, this.pos.y + 1.2, this.pos.z, e.pos.x, e.pos.y + 1.2, e.pos.z)) continue;
        }
        if (d - dy * 0.1 < bestD) { best = { kind: 'airAssassinate', enemy: e, label: 'Air Assassinate' }; bestD = d; }
      }
      // ledge assassination: hanging on a wall, enemy above at the top edge
      if (st === 'climb' && this.wall.hanging && dy > 0.6 && dy < 2.6 && d < 2.2) {
        best = { kind: 'ledgeAssassinate', enemy: e, label: 'Ledge Assassinate' };
        bestD = d;
      }
      // from hay
      if (st === 'hidden' && d < 2.6 && Math.abs(dy) < 1.5) {
        best = { kind: 'hayAssassinate', enemy: e, label: 'Assassinate' };
        bestD = d;
      }
    }
    if (best) { this.prompt = best; return; }
    if (st === 'hidden') { this.prompt = { kind: 'leaveHay', label: 'Leave the hay', run: () => this.exitHay() }; return; }
    // world interactions
    const it = game.interactions?.nearest(this);
    if (it) this.prompt = it;
  },

  hayAttackAvailable() {
    return !!(this.prompt && this.prompt.kind === 'hayAssassinate');
  },

  doPrompt() {
    const pr = this.prompt;
    if (!pr) return;
    if (pr.kind === 'glory') return this.startGlory(pr.enemy);
    if (pr.kind === 'assassinate' || pr.kind === 'hayAssassinate') return this.startAssassinate(pr.enemy, pr.kind === 'hayAssassinate' ? 'hay' : 'ground');
    if (pr.kind === 'airAssassinate') return this.startAssassinate(pr.enemy, 'air');
    if (pr.kind === 'ledgeAssassinate') return this.startAssassinate(pr.enemy, 'ledge');
    if (pr.run) pr.run();
  },

  // ------------------------------------------------------------ attacks
  startAttack(kind) {
    const game = this.game;
    if (!this.drawn) { this.drawn = true; game.playerView?.setDrawn(true); }
    this.combatT = 4;
    let def;
    if (kind === 'heavy') {
      const idx = this.lastAttackKind === 'heavy' && this.time - this.lastAttackEnd < 0.5 ? (this.heavyIdx + 1) % HEAVY.length : 0;
      this.heavyIdx = idx;
      def = HEAVY[idx];
      this.charging = true;
    } else {
      const chain = this.lastAttackKind === 'light' && this.time - this.lastAttackEnd < 0.42;
      this.combo = chain ? (this.combo + 1) % LIGHT.length : 0;
      def = LIGHT[this.combo];
      this.charging = false;
    }
    this.attackKind = kind;
    this.attackDef = def;
    this.attackHits.clear();
    this.queued = null;
    this.chargeT = 0;
    // soft targeting / lock: turn toward the target and lunge if far
    const tgt = this.lockTarget && !this.lockTarget.dead ? this.lockTarget : this.bestTarget(kind === 'heavy' ? 7 : 8.5, 1.3);
    this.attackTarget = tgt;
    this.lungeDist = 0;
    if (tgt) {
      const d = this.distTo(tgt);
      this.yaw = yawTo(this.pos.x, this.pos.z, tgt.pos.x, tgt.pos.z);
      const want = d - (tgt.radius + 1.0);
      this.lungeDist = clamp(want, 0, kind === 'light' ? 6.5 : 4.5);
    } else {
      const md = this.moveDir(this._mdc || (this._mdc = {}));
      if (md.len > 0.3) this.yaw = Math.atan2(md.x, md.z);
      this.lungeDist = def.lunge;
    }
    this.vel.set(0, 0, 0);
    this.setState('attack');
    this.anim = { clip: def.clip, t: 0, rate: 1 / def.dur, fast: true };
    this.swingPlayed = false;
  },

  st_attack(dt) {
    const input = this.input;
    let def = this.attackDef;
    // charging a strong attack -> Rend: held past the first moments, it charges for as long as it's held
    if (this.attackKind === 'heavy' && this.charging) {
      const holding = input.held('heavy') || (input.held('attack') && input.keyHeld('sprint'));
      if (holding && (this.chargeT > 0 || this.stateTime > 0.18)) {
        this.chargeT += dt;
        this.anim = { clip: 'rend', t: 0, fast: true };
        if (this.chargeT > 0.25 && Math.random() < 0.6) {
          const hp = this.game.playerView.bonePos('handR', _v);
          this.game.fx.add.emit(hp.x, hp.y, hp.z, rand(-1, 1), rand(0, 2), rand(-1, 1), 0.3, 0.12, 0.02, [3, 1.0, 0.25, 1], [1, 0.2, 0, 0], 0, 1);
        }
        if (this.chargeT >= 0.85 && !this.rendReady) { this.rendReady = true; this.game.audio?.play('sigilShield', { pos: this.pos, volume: 0.5, pitch: 1.5 }); }
        this.stateTime = 0;
        this.vel.x = damp(this.vel.x, 0, 10, dt); this.vel.z = damp(this.vel.z, 0, 10, dt);
        if (this.lockTarget && !this.lockTarget.dead) this.yaw = dampAngle(this.yaw, yawTo(this.pos.x, this.pos.z, this.lockTarget.pos.x, this.lockTarget.pos.z), 10, dt);
        else { const md = this.moveDir(this._mdc || (this._mdc = {})); if (md.len > 0.3) this.yaw = dampAngle(this.yaw, Math.atan2(md.x, md.z), 8, dt); }
        return this.integrateCombatMove(dt);
      }
      // let go: the strike goes ahead, as Rend if fully charged (still held: the windup continues)
      if (!holding) {
        this.charging = false;
        if (this.rendReady) {
          this.rendReady = false;
          this.attackDef = def = REND;
          this.anim = { clip: 'h1', t: 0, rate: 1 / REND.dur, fast: true };
          this.stateTime = 0;
          this.lungeDist = REND.lunge;
          const tgt = this.lockTarget && !this.lockTarget.dead ? this.lockTarget : this.bestTarget(6, 1.0);
          if (tgt) { this.yaw = yawTo(this.pos.x, this.pos.z, tgt.pos.x, tgt.pos.z); this.lungeDist = clamp(this.distTo(tgt) - (tgt.radius + 0.9), 0, 5); }
        }
      }
    }
    const u = this.stateTime / def.dur;
    if (this.anim) { this.anim.t = Math.min(1, u); this.anim.rate = 1 / def.dur; }
    // lunge movement during the windup into the strike
    const moveEnd = def.hit[0] + 0.05;
    if (u < moveEnd && this.lungeDist > 0) {
      const sp = this.lungeDist / (def.dur * moveEnd);
      this.vel.x = Math.sin(this.yaw) * sp;
      this.vel.z = Math.cos(this.yaw) * sp;
      // stop when touching the target
      const t = this.attackTarget;
      if (t && !t.dead && this.distTo(t) < t.radius + 0.95) { this.vel.x = 0; this.vel.z = 0; }
    } else {
      this.vel.x = damp(this.vel.x, 0, 14, dt);
      this.vel.z = damp(this.vel.z, 0, 14, dt);
    }
    if (u >= def.hit[0] - 0.12 && !this.swingPlayed) {
      this.swingPlayed = true;
      this.game.audio?.play(this.attackKind === 'heavy' || def.rend ? 'swingHeavy' : 'swing', { pos: this.pos, volume: 0.8 });
    }
    // hit window
    if (u >= def.hit[0] && u <= def.hit[1]) this.meleeSweep(def);
    // combo queue (Witcher: chain fast attacks)
    if (u > 0.3) {
      if (input.buffered('attack', 0.3)) { this.queued = input.keyHeld('sprint') ? 'heavy' : 'light'; input.consume('attack'); }
      if (input.buffered('heavy', 0.3)) { this.queued = 'heavy'; input.consume('heavy'); }
    }
    // cancel into dodge / roll after the strike
    if (u > def.hit[1] && (input.pressed('dodge') || (input.pressed('jump') && this.drawn))) {
      this.endAttack();
      return this.startDodge(input.pressed('jump'));
    }
    if (u >= 1 || (this.queued && u > def.hit[1] + 0.12)) {
      const q = this.queued;
      this.endAttack();
      if (q) this.startAttack(q);
      return;
    }
    this.integrateCombatMove(dt);
  },

  endAttack() {
    this.lastAttackKind = this.attackKind;
    this.lastAttackEnd = this.time;
    this.anim = null;
    this.attackDef = null;
    this.queued = null;
    this.setState('ground');
  },

  integrateCombatMove(dt) {
    this.integrateGround(dt);
  },

  /** Damage everything inside the swing arc this tick (once per target per swing). */
  meleeSweep(def) {
    const game = this.game;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let hitAny = false;
    for (const e of game.director.enemies) {
      if (e.dead || this.attackHits.has(e) || e.state === 'spawn' || e.state === 'grabbed') continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const ey0 = e.pos.y + (e.def.flies ? -0.7 : 0), ey1 = e.pos.y + (e.def.flies ? 0.7 : e.def.height);
      if (ey1 < this.pos.y - 0.3 || ey0 > this.pos.y + 2.4) continue;
      if (d - e.radius > def.reach) continue;
      if (def.arc < 6.2) {
        const ang = Math.abs(angleDiff(this.yaw, Math.atan2(dx, dz)));
        if (ang > def.arc / 2 && d > e.radius + 0.6) continue;
      }
      this.attackHits.add(e);
      hitAny = true;
      const dirX = d > 0.01 ? dx / d : fx, dirZ = d > 0.01 ? dz / d : fz;
      const furyMul = 1 + this.fury * 0.12;
      const sneak = !e.alerted;
      let dmg = def.dmg * this.dmgMul * furyMul * (game.difficulty?.dealt ?? 1);
      const dealt = e.takeHit(dmg, { type: def.rend ? 'heavy' : this.attackKind === 'heavy' ? 'heavy' : 'slash', poise: def.poise, dirX, dirZ, knockback: this.attackKind === 'heavy' ? 2.5 : 0.8, source: 'player', sneak, stagger: def.rend });
      const hx = e.pos.x - dirX * e.radius * 0.6, hy = this.pos.y + 1.2, hz = e.pos.z - dirZ * e.radius * 0.6;
      game.fx.blood(hx, Math.max(hy, e.pos.y + 0.6), hz, dirX, dirZ, this.attackKind === 'heavy' ? 26 : 16, e.def.heavy ? 1.3 : 1);
      game.fx.sparks(hx, Math.max(hy, e.pos.y + 0.6), hz, 6, [1, 0.6, 0.25], 5);
      game.audio?.play('hitFlesh', { pos: e.pos, volume: 0.9, pitch: rand(0.9, 1.1) });
      // fury (Witcher adrenaline): builds with hits, lost when hurt
      this.furyHits++;
      if (this.furyHits >= 4) { this.furyHits = 0; this.fury = Math.min(3, this.fury + 1); }
      // burning demons shed armor shards when struck (Doom flame belch)
      if (e.burning > 0 && Math.random() < 0.35) game.pickups.spawn('armor', e.pos.x, e.pos.y + 1, e.pos.z, 1);
      game.events.emit('playerHit', e, dealt);
    }
    if (hitAny) {
      // hit-stop: freeze a hair for impact (sim time scale dip)
      game.hitStop(this.attackKind === 'heavy' || def.rend ? 0.085 : 0.05);
      game.camera.addShake(this.attackKind === 'heavy' || def.rend ? 0.28 : 0.14);
    }
  },

  // ------------------------------------------------------------ block / parry
  st_block(dt) {
    const input = this.input;
    this.blocking = true;
    // a toggled guard lowers itself once no demons are near
    if (this.combatT <= 0) input.unlatch('block');
    if (!input.held('block')) { this.blocking = false; this.anim = null; this.setState('ground'); return; }
    // slow walk while guarding, face the target
    const md = this.moveDir(this._mdc || (this._mdc = {}));
    const sp = P.SPEED_BLOCK * md.len;
    this.vel.x = approach(this.vel.x, md.len > 0.05 ? (md.x / md.len) * sp : 0, 30 * dt);
    this.vel.z = approach(this.vel.z, md.len > 0.05 ? (md.z / md.len) * sp : 0, 30 * dt);
    const t = this.lockTarget && !this.lockTarget.dead ? this.lockTarget : this.bestTarget(10, 3.2, false);
    if (t) this.yaw = dampAngle(this.yaw, yawTo(this.pos.x, this.pos.z, t.pos.x, t.pos.z), 12, dt);
    this.anim = { clip: 'block', t: 0 };
    if (input.pressed('attack')) { this.blocking = false; input.consume('attack'); this.setState('ground'); return this.startAttack('light'); }
    if (input.pressed('dodge')) { this.blocking = false; this.setState('ground'); return this.startDodge(false); }
    this.integrateGround(dt);
  },

  st_counter(dt) {
    // riposte after a perfect parry
    const u = this.stateTime / 0.55;
    if (this.anim) this.anim.t = Math.min(1, u);
    const t = this.counterTarget;
    if (u < 0.35 && t && !t.dead) {
      this.yaw = yawTo(this.pos.x, this.pos.z, t.pos.x, t.pos.z);
      const d = this.distTo(t) - (t.radius + 0.9);
      const sp = clamp(d, 0, 3) / 0.2;
      this.vel.x = Math.sin(this.yaw) * sp; this.vel.z = Math.cos(this.yaw) * sp;
    } else { this.vel.x = damp(this.vel.x, 0, 14, dt); this.vel.z = damp(this.vel.z, 0, 14, dt); }
    if (u >= 0.5 && !this.counterDone && t && !t.dead) {
      this.counterDone = true;
      const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
      t.takeHit(40 * this.dmgMul, { type: 'heavy', poise: 40, dirX: dx / d, dirZ: dz / d, knockback: 1.5, source: 'player', stagger: true, staggerDur: 1.4 });
      this.game.fx.blood(t.pos.x, this.pos.y + 1.2, t.pos.z, dx / d, dz / d, 24, 1.2);
      this.game.audio?.play('counter', { pos: this.pos, volume: 1 });
      this.game.hitStop(0.09);
      this.game.camera.addShake(0.25);
      this.fury = Math.min(3, this.fury + 1);
    }
    if (u >= 1) { this.anim = null; this.setState(this.input.held('block') ? 'block' : 'ground'); return; }
    this.integrateGround(dt);
  },

  /**
   * Called by demons/projectiles. Returns 'hit' | 'blocked' | 'parried' |
   * 'dodged' | 'warded'.
   */
  receiveHit(a, src) {
    const game = this.game;
    if (this.dead) return 'dodged';
    if (this.invuln > 0 || this.state === 'glory' || this.state === 'assassinate' || this.state === 'leap' || this.state === 'sync') return 'dodged';
    if (this.state === 'hidden' && !a.splash) return 'dodged';
    if ((this.state === 'dodge' || this.state === 'roll') && this.iframe > 0) {
      game.events.emit('perfectDodge');
      return 'dodged';
    }
    // facing check for block/parry
    let facing = true;
    if (src && src.pos) {
      const yawTo = Math.atan2(src.pos.x - this.pos.x, src.pos.z - this.pos.z);
      facing = Math.abs(angleDiff(this.yaw, yawTo)) < 1.3;
    }
    const canDefend = !a.unblockable && facing && (this.state === 'block' || this.state === 'counter');
    const sinceBlock = this.time - this.blockStart;
    if (canDefend && (sinceBlock < (game.difficulty?.parry ?? 0.26) || this.state === 'counter') && (a.parryable !== false)) {
      // perfect parry -> riposte (melee) or deflect (projectile)
      game.fx.sparks(this.pos.x + Math.sin(this.yaw) * 0.6, this.pos.y + 1.3, this.pos.z + Math.cos(this.yaw) * 0.6, 26, [1, 0.85, 0.5], 9);
      game.audio?.play('parry', { pos: this.pos, volume: 1 });
      game.hitStop(0.12);
      game.camera.addShake(0.2);
      game.events.emit('parry', src);
      if (!a.ranged && src && src.def && !src.def.boss) {
        this.counterTarget = src;
        this.counterDone = false;
        this.setState('counter');
        this.anim = { clip: 'counter', t: 0, rate: 1 / 0.55, fast: true };
      } else if (!a.ranged && src && src.def?.boss) {
        src.takeHit(25, { type: 'heavy', poise: 0, source: 'player' });
      }
      this.stamina = Math.min(this.maxStamina, this.stamina + 10);
      return 'parried';
    }
    if (canDefend && this.state === 'block') {
      // regular block: big reduction, costs stamina
      const dmg = a.dmg * 0.18 * (game.difficulty?.taken ?? 1);
      this.applyDamage(dmg, a, src, true);
      this.stamina = Math.max(0, this.stamina - a.dmg * 0.6);
      this.staminaDelay = 0.6;
      game.fx.sparks(this.pos.x + Math.sin(this.yaw) * 0.6, this.pos.y + 1.3, this.pos.z + Math.cos(this.yaw) * 0.6, 10, [1, 0.7, 0.4], 6);
      game.audio?.play('block', { pos: this.pos, volume: 0.9 });
      this.knockBack(src, 1.2);
      if (this.stamina <= 0) { this.blocking = false; this.stagger(0.6); }
      return 'blocked';
    }
    // Aegis ward absorbs the blow
    if (this.aegis > 0) {
      this.aegis -= a.dmg;
      game.audio?.play('sigilShield', { pos: this.pos, volume: 0.8, pitch: 0.7 });
      game.fx.magicSwirl(this.pos.x, this.pos.y + 1.1, this.pos.z, [2.2, 1.6, 0.4], 30, 0.9);
      if (this.aegis <= 0) {
        this.aegis = 0; this.aegisT = 0;
        game.audio?.play('sigilShieldBreak', { pos: this.pos, volume: 1 });
        // the shattering ward pushes demons back
        for (const e of game.director.enemies) {
          if (e.dead || this.distTo(e) > 4) continue;
          const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
          e.takeHit(8, { type: 'magic', poise: 20, dirX: dx / d, dirZ: dz / d, knockback: 4, source: 'player' });
        }
      }
      return 'warded';
    }
    const dmg = a.dmg * (game.difficulty?.taken ?? 1);
    this.applyDamage(dmg, a, src, false);
    if (this.dead) return 'hit';
    if (a.knockdown) this.knockdownPlayer(src);
    else if (a.dmg >= 14 && !a.beam && !a.fire && !a.splash) this.stagger(a.dmg >= 25 ? 0.55 : 0.35);
    this.knockBack(src, a.knockback || (a.dmg >= 25 ? 3 : 1.2));
    return 'hit';
  },

  applyDamage(dmg, a, src, blocked) {
    const game = this.game;
    // armor absorbs half of incoming damage
    if (this.armor > 0) {
      const absorb = Math.min(this.armor, dmg * 0.5);
      this.armor -= absorb;
      dmg -= absorb;
    }
    this.hp -= dmg;
    this.lastHitT = this.time;
    this.fury = Math.max(0, this.fury - (blocked ? 0 : 1));
    this.furyHits = 0;
    game.events.emit('playerDamaged', dmg, a, src, blocked);
    if (!blocked) {
      game.audio?.play('playerHurt', { volume: 0.8 });
      game.camera.addShake(clamp(dmg / 40, 0.15, 0.5));
      game.fx.blood(this.pos.x, this.pos.y + 1.2, this.pos.z, 0, 0, 8, 0.7);
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.die();
    }
  },

  knockBack(src, k) {
    if (!src || !src.pos) return;
    const dx = this.pos.x - src.pos.x, dz = this.pos.z - src.pos.z, d = Math.hypot(dx, dz) || 1;
    this.vel.x += (dx / d) * k * 2;
    this.vel.z += (dz / d) * k * 2;
  },

  stagger(dur) {
    if (this.state === 'climb' || this.state === 'air' || this.state === 'hidden') return;
    this.staggerDur = dur;
    this.anim = { clip: 'hit', t: 0, fast: true };
    this.blocking = false;
    this.setState('hit');
  },

  st_hit(dt) {
    if (this.anim) this.anim.t = Math.min(1, this.stateTime / this.staggerDur);
    this.vel.x = damp(this.vel.x, 0, 6, dt);
    this.vel.z = damp(this.vel.z, 0, 6, dt);
    this.integrateGround(dt);
    if (this.stateTime >= this.staggerDur && this.state === 'hit') { this.anim = null; this.setState('ground'); }
  },

  knockdownPlayer(src) {
    if (this.state === 'climb' || this.state === 'hidden') return;
    this.anim = { clip: 'knockdown', t: 0, fast: true };
    this.blocking = false;
    this.knockBack(src, 4);
    this.setState('knocked');
    this.game.camera.addShake(0.45);
  },

  st_knocked(dt) {
    if (this.anim) this.anim.t = Math.min(1, this.stateTime / 1.3);
    this.vel.x = damp(this.vel.x, 0, 4, dt);
    this.vel.z = damp(this.vel.z, 0, 4, dt);
    this.integrateGround(dt);
    // roll out early (Witcher)
    if (this.stateTime > 0.5 && (this.input.pressed('dodge') || this.input.pressed('jump'))) { this.anim = null; this.setState('ground'); return this.startDodge(true); }
    if (this.stateTime > 1.3 && this.state === 'knocked') { this.anim = null; this.setState('ground'); this.invuln = 0.4; }
  },

  takeFallDamage(fall) {
    const dmg = (fall - 12) * 7;
    if (dmg <= 0) return;
    this.hp -= dmg;
    this.game.events.emit('playerDamaged', dmg, { name: 'fall' }, null, false);
    this.game.audio?.play('landHeavy', { volume: 1 });
    this.game.camera.addShake(0.5);
    if (this.hp <= 0) { this.hp = 0; this.die(); }
  },

  die() {
    if (this.dead) return;
    this.dead = true;
    this.anim = null;
    this.blocking = false;
    this.lockTarget = null;
    this.grounded = this.state !== 'air' && this.state !== 'climb';
    this.setState('dead');
    this.game.audio?.play('playerDeath', { volume: 1 });
    this.game.events.emit('playerDied');
  },

  // ------------------------------------------------------------ dodge / roll
  startDodge(roll) {
    const cost = roll ? 12 : 6;
    this.stamina = Math.max(0, this.stamina - cost);
    this.staminaDelay = 0.4;
    const md = this.moveDir(this._mdc || (this._mdc = {}));
    let dir;
    if (md.len > 0.2) dir = Math.atan2(md.x, md.z);
    else dir = this.yaw + Math.PI; // backstep
    this.dodgeDir = dir;
    this.dodgeRoll = roll;
    this.iframe = roll ? 0.42 : 0.28;
    this.blocking = false;
    // keep facing the lock target during a dodge; a roll turns to its direction
    if (roll) this.yaw = dir;
    this.anim = roll ? { clip: 'roll', t: 0, fast: true, rootPitch: (u) => u * Math.PI * 2, bob: -0.35 } : { clip: 'dodge', t: 0, fast: true };
    this.setState(roll ? 'roll' : 'dodge');
    this.game.audio?.play(roll ? 'roll' : 'dodge', { pos: this.pos, volume: 0.7 });
    this.noise = Math.max(this.noise, 0.3);
  },

  st_dodge(dt) { this.dodgeTick(dt, 0.34, 9.5); },
  st_roll(dt) { this.dodgeTick(dt, 0.62, 8.5); },

  dodgeTick(dt, dur, speed) {
    this.iframe -= dt;
    const u = this.stateTime / dur;
    if (this.anim) { this.anim.t = Math.min(1, u); this.anim.rate = 1 / dur; }
    const sp = speed * (1 - smoothstep(0.55, 1, u));
    this.vel.x = Math.sin(this.dodgeDir) * sp;
    this.vel.z = Math.cos(this.dodgeDir) * sp;
    if (!this.dodgeRoll) {
      const lock = this.facingOverride();
      if (lock !== null) this.yaw = dampAngle(this.yaw, lock, 12, dt);
    }
    this.integrateGround(dt);
    if (this.state !== 'dodge' && this.state !== 'roll') { this.anim = null; return; }
    if (u >= 1) {
      this.anim = null;
      this.setState('ground');
    }
  },

  // ------------------------------------------------------------ sigils
  castSigil() {
    const game = this.game;
    const s = SIGILS[this.sigil];
    if (this.stamina < s.cost * 0.98) {
      game.audio?.play('noStamina', { volume: 0.7 });
      game.events.emit('noStamina');
      return;
    }
    this.stamina -= s.cost;
    this.staminaDelay = 1.0;
    const tgt = this.lockTarget && !this.lockTarget.dead ? this.lockTarget : this.bestTarget(14, 1.0, true, true);
    const snareFlyer = s.id === 'snare' && tgt && tgt.def.flies;
    if (tgt && s.id !== 'aegis' && (s.id !== 'snare' || snareFlyer)) this.yaw = yawTo(this.pos.x, this.pos.z, tgt.pos.x, tgt.pos.z);
    else { const md = this.moveDir(this._mdc || (this._mdc = {})); if (md.len > 0.3 && s.id !== 'aegis') this.yaw = Math.atan2(md.x, md.z); }
    this.castId = s.id;
    this.castDone = false;
    this.castTarget = tgt;
    this.anim = { clip: 'cast', t: 0, rate: 1 / 0.5, fast: true };
    this.vel.set(0, 0, 0);
    this.combatT = Math.max(this.combatT, 2);
    this.setState('cast');
  },

  st_cast(dt) {
    const u = this.stateTime / 0.5;
    if (this.anim) this.anim.t = Math.min(1, u);
    if (u >= 0.3 && !this.castDone) { this.castDone = true; this.releaseSigil(this.castId); }
    this.vel.x = damp(this.vel.x, 0, 12, dt); this.vel.z = damp(this.vel.z, 0, 12, dt);
    this.integrateGround(dt);
    if (u >= 1 && this.state === 'cast') { this.anim = null; this.setState('ground'); }
  },

  releaseSigil(id) {
    const game = this.game;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const hand = game.playerView.bonePos('handL', new THREE.Vector3());
    const mul = this.sigilMul;
    const cone = (range, arc, fn) => {
      for (const e of game.director.enemies) {
        if (e.dead || e.state === 'spawn') continue;
        const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z, d = Math.hypot(dx, dz);
        if (d > range + e.radius) continue;
        if (Math.abs(e.pos.y - this.pos.y) > (e.def.flies ? 9 : 3)) continue;
        if (Math.abs(angleDiff(this.yaw, Math.atan2(dx, dz))) > arc / 2 && d > 1.5) continue;
        fn(e, dx / (d || 1), dz / (d || 1), d);
      }
    };
    if (id === 'pyre') {
      game.fx.fireBurst(hand.x, hand.y, hand.z, fx, fz, 0.5, 6.5 * Math.sqrt(mul), 90);
      game.audio?.play('sigilFire', { pos: this.pos, volume: 1 });
      cone(7 * Math.sqrt(mul), 1.25, (e, dx, dz) => e.takeHit(22 * mul, { type: 'fire', poise: 10, dirX: dx, dirZ: dz, knockback: 1, source: 'player' }));
      this.noise = 1;
    } else if (id === 'gust') {
      game.fx.windBurst(hand.x, hand.y, hand.z, fx, fz, 0.7, 7.5 * Math.sqrt(mul));
      game.audio?.play('sigilWind', { pos: this.pos, volume: 1 });
      game.camera.addShake(0.2);
      cone(8 * Math.sqrt(mul), 1.5, (e, dx, dz) => {
        e.takeHit(10 * mul, { type: 'force', poise: 0, dirX: dx, dirZ: dz, knockback: 7 * mul, source: 'player' });
        if (!e.dead) {
          if (e.def.heavy) e.stagger(0.8);
          else if (e.def.flies) { e.stagger(1.2); e.pos.y += 1.5; }
          else e.knockdown();
        }
      });
      this.noise = 1;
    } else if (id === 'aegis') {
      this.aegis = 45 * mul;
      this.aegisT = 25;
      game.fx.magicSwirl(this.pos.x, this.pos.y + 1, this.pos.z, [2.4, 1.8, 0.5], 60, 1.0);
      game.audio?.play('sigilShield', { pos: this.pos, volume: 1 });
    } else if (id === 'snare') {
      // at a Gazer: the glyph opens under it and drags it down; otherwise at your feet
      const t = this.castTarget;
      if (t && !t.dead && t.def.flies && this.distTo(t) < 18) {
        const g = game.collision.groundAt(t.pos.x, t.pos.z, 0.3, t.pos.y);
        game.snares.add(t.pos.x, g.y, t.pos.z, 4.2 * Math.sqrt(mul), 11);
        game.fx.magicSwirl(t.pos.x, t.pos.y, t.pos.z, [1.4, 0.6, 2.4], 30, 0.9);
      } else game.snares.add(this.pos.x, this.pos.y, this.pos.z, 4.2 * Math.sqrt(mul), 11);
      game.audio?.play('sigilTrap', { pos: this.pos, volume: 1 });
    } else if (id === 'hex') {
      const t = this.castTarget && !this.castTarget.dead && this.distTo(this.castTarget) < 14 ? this.castTarget : this.bestTarget(14, 0.9, false, true);
      game.audio?.play('sigilHex', { pos: this.pos, volume: 1 });
      if (t) {
        game.fx.magicSwirl(t.pos.x, t.pos.y + (t.def.flies ? 0 : t.def.height * 0.7), t.pos.z, [0.6, 2.4, 1.0], 40, 0.7);
        if (t.def.boss) t.takeHit(30 * mul, { type: 'magic', poise: 0, source: 'player' });
        else t.daze((t.def.heavy ? 3 : 5) * mul);
      } else game.fx.magicSwirl(hand.x, hand.y, hand.z, [0.6, 2.4, 1.0], 20, 0.4);
    }
    game.events.emit('sigil', id);
  },

  // ------------------------------------------------------------ crossbow / tonic
  /** Hand crossbow: aims itself at the best demon in sight, at any height. */
  shootCrossbow(inAir = false) {
    const game = this.game;
    if (this.time < (this.reloadUntil || 0)) return;
    if (this.bolts <= 0) { game.audio?.play('noStamina', { volume: 0.5 }); game.events.emit('noBolts'); return; }
    const tgt = this.lockTarget && !this.lockTarget.dead ? this.lockTarget
      : this.bestTarget(40, 0.6, false, true) || this.bestTarget(40, 1.0, true, true);
    if (tgt) this.yaw = yawTo(this.pos.x, this.pos.z, tgt.pos.x, tgt.pos.z);
    else this.yaw = this.camYaw;
    this.shotTarget = tgt;
    this.reloadUntil = this.time + 0.6;
    this.combatT = Math.max(this.combatT, 1.5);
    if (inAir) { this.fireBolt(); return; }
    this.shotFired = false;
    this.anim = { clip: 'shoot', t: 0, rate: 1 / 0.55, fast: true };
    this.vel.multiplyScalar(0.25);
    this.setState('shoot');
  },

  fireBolt() {
    const game = this.game;
    if (this.bolts <= 0) return;
    this.bolts--;
    const tgt = this.shotTarget && !this.shotTarget.dead ? this.shotTarget : null;
    // launched from the outstretched left hand (simulation state only, never the rendered pose)
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const from = new THREE.Vector3(this.pos.x + fx * 0.75 + fz * 0.12, this.pos.y + 1.42, this.pos.z + fz * 0.75 - fx * 0.12);
    let dir;
    if (tgt) {
      const a = this.aimPoint(tgt, new THREE.Vector3());
      const t = a.distanceTo(from) / BOLT_SPEED;
      a.x += (tgt.vel?.x || 0) * t; a.z += (tgt.vel?.z || 0) * t; // lead a moving demon
      dir = a.sub(from);
    } else {
      const cy = this.camYaw, cp = game.camera.pitch;
      dir = new THREE.Vector3(Math.sin(cy) * Math.cos(cp), -Math.sin(cp) + 0.04, Math.cos(cy) * Math.cos(cp));
    }
    game.director.projectiles.bolt(from, dir, 45 * this.dmgMul * (game.difficulty?.dealt ?? 1), tgt);
    game.audio?.play('crossbow', { pos: this.pos, volume: 0.9 });
    this.noise = Math.max(this.noise, 0.3);
    game.events.emit('crossbow', tgt);
  },

  st_shoot(dt) {
    const u = this.stateTime / 0.55;
    if (this.anim) this.anim.t = Math.min(1, u);
    if (u >= 0.32 && !this.shotFired) { this.shotFired = true; this.fireBolt(); }
    this.vel.x = damp(this.vel.x, 0, 10, dt); this.vel.z = damp(this.vel.z, 0, 10, dt);
    this.integrateGround(dt);
    if (u >= 1 && this.state === 'shoot') { this.anim = null; this.setState('ground'); }
  },

  drinkTonic() {
    const game = this.game;
    if (this.tonics <= 0 || this.hp >= this.maxHp) { game.audio?.play('noStamina', { volume: 0.5 }); game.events.emit('noTonic'); return; }
    this.tonics--;
    this.anim = { clip: 'tonic', t: 0, rate: 1 / 0.9, fast: true };
    this.vel.set(0, 0, 0);
    this.setState('tonic');
    game.audio?.play('tonic', { pos: this.pos, volume: 0.8 });
  },

  st_tonic(dt) {
    const u = this.stateTime / 0.9;
    if (this.anim) this.anim.t = Math.min(1, u);
    const md = this.moveDir(this._mdc || (this._mdc = {}));
    const sp = 1.2 * md.len;
    this.vel.x = approach(this.vel.x, md.len > 0.05 ? (md.x / md.len) * sp : 0, 20 * dt);
    this.vel.z = approach(this.vel.z, md.len > 0.05 ? (md.z / md.len) * sp : 0, 20 * dt);
    if (u >= 0.6 && !this.tonicDone) { this.tonicDone = true; this.healOverTime += 70; }
    this.integrateGround(dt);
    if (u >= 1 && this.state === 'tonic') { this.tonicDone = false; this.anim = null; this.setState('ground'); }
  },

  // ------------------------------------------------------------ assassinations
  startAssassinate(e, mode) {
    const game = this.game;
    this.assassin = { e, mode, done: false, from: this.pos.clone() };
    e.setState('grabbed');
    e.attack = null;
    e.telegraph = null;
    e.anim = { clip: 'grabbed', t: 0 };
    e.releaseToken();
    this.hiddenBladeOut = true;
    if (mode === 'hay') this.exitHayFor(e);
    if (mode === 'air' || mode === 'ledge') {
      // leap from above onto the victim
      const yawToE = yawTo(this.pos.x, this.pos.z, e.pos.x, e.pos.z);
      this.yaw = yawToE;
      this.assassin.dur = mode === 'air' ? 0.75 : 0.6;
      this.anim = { clip: 'airAssassinate', t: 0, fast: true };
    } else {
      // step behind the victim
      this.yaw = yawTo(this.pos.x, this.pos.z, e.pos.x, e.pos.z);
      this.assassin.dur = 0.85;
      this.anim = { clip: 'assassinate', t: 0, fast: true };
    }
    this.vel.set(0, 0, 0);
    this.invuln = 1.2;
    this.setState('assassinate');
    game.audio?.play('hiddenBlade', { pos: this.pos, volume: 0.9 });
    game.camera.cinematic = { yaw: this.yaw + 1.2, pitch: 0.12, dist: 3.4, height: 1.2, shoulder: 0, until: this.assassin.dur + 0.35, fov: 55 };
    game.slowMo(0.55, 0.45);
  },

  exitHayFor(e) {
    const h = this.hay;
    this.hay = null;
    this.visible = true;
    this.pos.set(h.x, 0, h.z);
    this.yaw = yawTo(h.x, h.z, e.pos.x, e.pos.z);
    this.prev.copy(this.pos);
    this.game.fx.hayBurst(h.x, h.top + 0.3, h.z, 0.8);
  },

  st_assassinate(dt) {
    const A = this.assassin;
    const e = A.e;
    const u = clamp(this.stateTime / A.dur, 0, 1);
    if (this.anim) this.anim.t = u;
    // move to the strike position
    const yaw = yawTo(A.from.x, A.from.z, e.pos.x, e.pos.z);
    const sx = e.pos.x - Math.sin(yaw) * (e.radius + 0.55), sz = e.pos.z - Math.cos(yaw) * (e.radius + 0.55);
    const k = smoothstep(0, A.mode === 'air' ? 0.75 : 0.45, u);
    this.pos.x = lerp(A.from.x, sx, k);
    this.pos.z = lerp(A.from.z, sz, k);
    if (A.mode === 'air' || A.mode === 'ledge') {
      const arc = Math.sin(Math.min(1, u / 0.75) * Math.PI) * 1.2;
      this.pos.y = lerp(A.from.y, e.pos.y, smoothstep(0, 0.75, u)) + arc * (1 - u);
    } else this.pos.y = lerp(A.from.y, e.pos.y, k);
    this.yaw = yaw;
    e.yaw = dampAngle(e.yaw, yaw + (A.mode === 'ground' && !e.alerted ? 0 : Math.PI), 8, dt);
    if (u >= (A.mode === 'air' ? 0.72 : 0.42) && !A.done) {
      A.done = true;
      const game = this.game;
      const big = e.def.assassinFrac && A.mode === 'ground';
      game.fx.blood(e.pos.x, e.pos.y + e.def.height * 0.75, e.pos.z, Math.sin(yaw), Math.cos(yaw), 30, e.def.heavy ? 1.4 : 1);
      game.audio?.play('assassinate', { pos: e.pos, volume: 1 });
      game.hitStop(0.1);
      game.camera.addShake(0.3);
      e.setState('combat');
      if (big) {
        e.takeHit(e.maxHp * e.def.assassinFrac, { type: 'pierce', poise: 999, source: 'player', stagger: true, staggerDur: 2.2, killKind: 'assassinate' });
        if (!e.dead) e.alerted = true;
      } else {
        e.hp = 0;
        e.die('assassinate');
      }
      game.events.emit('assassination', e, A.mode);
    }
    if (u >= 1) {
      this.hiddenBladeOut = false;
      this.anim = null;
      this.grounded = true;
      const g = this.col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, this.pos.y + 0.6);
      this.pos.y = g.y;
      this.setState('ground');
    }
  },

  // ------------------------------------------------------------ glory kills
  startGlory(e) {
    const game = this.game;
    if (e.def.boss) return this.startBossStrike(e);
    this.glory = { e, from: this.pos.clone(), done: false, variant: Math.random() < 0.5 ? 1 : 2, hits: 0 };
    e.setState('grabbed');
    e.anim = { clip: 'grabbed', t: 0 };
    e.releaseToken();
    this.yaw = yawTo(this.pos.x, this.pos.z, e.pos.x, e.pos.z);
    this.vel.set(0, 0, 0);
    this.invuln = 1.6;
    const dur = e.def.heavy ? 1.25 : 1.0;
    this.glory.dur = dur;
    this.anim = { clip: this.glory.variant === 1 ? 'glory1' : 'glory2', t: 0, fast: true };
    this.setState('glory');
    game.camera.cinematic = { yaw: this.yaw + (Math.random() < 0.5 ? 1.1 : -1.1), pitch: 0.18, dist: e.def.heavy ? 4.6 : 3.6, height: 1.1, shoulder: 0, until: dur + 0.25, fov: 52 };
    game.audio?.play('swingHeavy', { pos: this.pos, volume: 0.9 });
    game.slowMo(0.6, dur * 0.5);
  },

  st_glory(dt) {
    const G = this.glory;
    const e = G.e;
    const u = clamp(this.stateTime / G.dur, 0, 1);
    if (this.anim) this.anim.t = u;
    const yaw = yawTo(G.from.x, G.from.z, e.pos.x, e.pos.z);
    const sx = e.pos.x - Math.sin(yaw) * (e.radius + 0.7), sz = e.pos.z - Math.cos(yaw) * (e.radius + 0.7);
    const k = smoothstep(0, 0.25, u);
    this.pos.x = lerp(G.from.x, sx, k);
    this.pos.z = lerp(G.from.z, sz, k);
    this.yaw = yaw;
    e.yaw = yaw + Math.PI;
    const game = this.game;
    const hitAt = [0.32, 0.62, 0.82];
    while (G.hits < hitAt.length && u >= hitAt[G.hits]) {
      G.hits++;
      const last = G.hits === hitAt.length;
      game.fx.blood(e.pos.x, e.pos.y + e.def.height * 0.7, e.pos.z, Math.sin(yaw), Math.cos(yaw), last ? 40 : 18, e.def.heavy ? 1.5 : 1.1);
      game.audio?.play(last ? 'gloryKill' : 'hitFlesh', { pos: e.pos, volume: 1 });
      game.hitStop(last ? 0.14 : 0.06);
      game.camera.addShake(last ? 0.5 : 0.2);
      if (last) {
        game.fx.gibs(e.pos.x, e.pos.y + e.def.height * 0.6, e.pos.z, e.def.heavy ? 40 : 26, e.def.heavy ? 1.4 : 1);
        e.setState('combat');
        e.hp = 0;
        e.die('glory');
        this.fury = Math.min(3, this.fury + 1);
        game.events.emit('gloryKill', e);
      }
    }
    if (u >= 1) {
      this.anim = null;
      this.setState('ground');
    }
    void dt;
  },
};

// The Cardinal's heart strike: leap onto the kneeling giant, blade into the
// glowing heart (AC-style "assassinate the colossus"), big damage, not a kill.
C.startBossStrike = function startBossStrike(e) {
  const game = this.game;
  this.bossStrike = { e, from: this.pos.clone(), done: false };
  this.yaw = yawTo(this.pos.x, this.pos.z, e.pos.x, e.pos.z);
  this.invuln = 2.2;
  this.vel.set(0, 0, 0);
  this.hiddenBladeOut = true;
  this.anim = { clip: 'airAssassinate', t: 0, fast: true };
  this.setState('bossStrike');
  e.dazed = Math.max(e.dazed, 2.4);
  game.camera.cinematic = { yaw: this.yaw + 1.3, pitch: 0.05, dist: 9, height: 2.5, shoulder: 0, until: 1.8, fov: 58, lookUp: 1.5 };
  game.audio?.play('leap', { pos: this.pos, volume: 0.7 });
  game.slowMo(0.6, 0.8);
};

C.st_bossStrike = function stBossStrike(dt) {
  const S = this.bossStrike;
  const e = S.e;
  const u = clamp(this.stateTime / 1.5, 0, 1);
  if (this.anim) this.anim.t = Math.min(1, u * 1.4);
  const yaw = yawTo(S.from.x, S.from.z, e.pos.x, e.pos.z);
  const tx = e.pos.x - Math.sin(yaw) * 1.4, tz = e.pos.z - Math.cos(yaw) * 1.4;
  const ty = e.pos.y + 3.2;
  const k = smoothstep(0, 0.45, u);
  this.pos.x = lerp(S.from.x, tx, k);
  this.pos.z = lerp(S.from.z, tz, k);
  this.pos.y = u < 0.45 ? lerp(S.from.y, ty, k) + Math.sin(k * Math.PI) * 1.5 : u < 0.8 ? ty : lerp(ty, S.from.y, smoothstep(0.8, 1, u));
  this.yaw = yaw;
  if (u > 0.8) {
    // drop back down in front of him
    this.pos.x = lerp(tx, S.from.x * 0.4 + tx * 0.6, smoothstep(0.8, 1, u));
    this.pos.z = lerp(tz, S.from.z * 0.4 + tz * 0.6, smoothstep(0.8, 1, u));
  }
  if (u >= 0.5 && !S.done) {
    S.done = true;
    const game = this.game;
    game.fx.blood(e.pos.x, ty + 0.5, e.pos.z, Math.sin(yaw), Math.cos(yaw), 50, 2);
    game.fx.explosion(e.pos.x - Math.sin(yaw) * 0.5, ty + 0.4, e.pos.z - Math.cos(yaw) * 0.5, 0.8);
    game.audio?.play('gloryKill', { pos: e.pos, volume: 1 });
    game.audio?.play('bossRoar', { pos: e.pos, volume: 0.9 });
    game.hitStop(0.16);
    game.camera.addShake(0.7);
    e.takeHit(e.maxHp * 0.11 * this.dmgMul, { type: 'pierce', poise: 0, source: 'player' });
    this.fury = Math.min(3, this.fury + 1);
    game.events.emit('bossStruck', e);
  }
  if (u >= 1) {
    const g = this.col.groundAt(this.pos.x, this.pos.z, P.FOOT_R, this.pos.y + 1);
    this.pos.y = g.y;
    this.hiddenBladeOut = false;
    this.anim = null;
    this.invuln = 0.6;
    this.setState('ground');
  }
  void dt;
};

export function installCombat() {
  Object.assign(Player.prototype, C);
}
