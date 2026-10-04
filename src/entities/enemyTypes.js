// Demon roster: stats, perception, attacks and animation clips.
// Attack timing: windup (telegraphed) -> active (hit window) -> recover.
// Clips are sampled with u in [0,0.5] during windup, [0.5,0.7] active,
// [0.7,1] recovery.

const D = Math.PI / 180;

export const ENEMY_TYPES = {
  thrall: {
    name: 'Thrall', hp: 45, poise: 18, radius: 0.36, height: 1.75, mass: 1,
    walk: 1.3, run: 3.1, turn: 6, view: 22, fov: 110 * D, hearing: 9, eyeY: 1.55,
    skel: 'humanoid', canAssassinate: true, stealthMul: 1,
    sounds: { alert: 'thrallGroan', pain: 'demonPain', death: 'demonDeath', idle: 'thrallGroan' },
    drops: { orbs: 1 },
    attacks: [
      { name: 'swipe', clip: 'swipe', range: [0, 2.0], cooldown: 1.8, windup: 0.6, active: 0.16, recover: 0.6, dmg: 10, reach: 2.1, arc: 110 * D, lunge: 1.2, poiseDmg: 10 },
      { name: 'lunge', clip: 'lungeBite', range: [1.5, 3.2], cooldown: 3.5, windup: 0.7, active: 0.2, recover: 0.8, dmg: 14, reach: 1.9, arc: 70 * D, lunge: 2.8, poiseDmg: 14, weight: 0.5 },
    ],
  },
  imp: {
    name: 'Imp', hp: 65, poise: 26, radius: 0.34, height: 1.65, mass: 0.9,
    walk: 1.6, run: 5.4, turn: 9, view: 28, fov: 120 * D, hearing: 12, eyeY: 1.5,
    skel: 'humanoid', canAssassinate: true, climbs: true, prefersRange: true, keepAway: [5, 13],
    sounds: { alert: 'impScreech', pain: 'demonPain', death: 'demonDeath', idle: 'impScreech' },
    drops: { orbs: 1 },
    attacks: [
      { name: 'claw', clip: 'swipe', range: [0, 2.0], cooldown: 1.2, windup: 0.42, active: 0.14, recover: 0.4, dmg: 12, reach: 2.0, arc: 110 * D, lunge: 1.5, poiseDmg: 12 },
      { name: 'fireball', clip: 'throw', range: [4, 22], cooldown: 2.6, windup: 0.75, active: 0.1, recover: 0.5, ranged: 'fireball', dmg: 16, weight: 1.6 },
    ],
  },
  hound: {
    name: 'Hellhound', hp: 85, poise: 34, radius: 0.42, height: 1.1, mass: 1.2,
    walk: 2.0, run: 8.4, turn: 10, view: 24, fov: 140 * D, hearing: 16, eyeY: 0.95,
    skel: 'hound', canAssassinate: true, smell: 5,
    sounds: { alert: 'houndBark', pain: 'demonPain', death: 'demonDeath', idle: 'houndGrowl' },
    drops: { orbs: 1 },
    attacks: [
      { name: 'bite', clip: 'bite', range: [0, 2.1], cooldown: 1.1, windup: 0.32, active: 0.14, recover: 0.45, dmg: 14, reach: 2.1, arc: 80 * D, lunge: 1.6, poiseDmg: 10 },
      { name: 'pounce', clip: 'pounce', range: [3.5, 9], cooldown: 4, windup: 0.5, active: 0.55, recover: 0.6, dmg: 22, reach: 1.8, arc: 120 * D, leap: true, poiseDmg: 30, knockdown: true, weight: 1.3 },
    ],
  },
  gazer: {
    name: 'Gazer', hp: 130, poise: 45, radius: 0.6, height: 1.2, mass: 1.5,
    walk: 2.5, run: 4.6, turn: 3.5, view: 34, fov: 150 * D, hearing: 10, eyeY: 0,
    skel: 'gazer', flies: true, canAssassinate: false, keepAway: [9, 17], prefersRange: true, hover: 7,
    sounds: { alert: 'orbShoot', pain: 'demonPain', death: 'demonDeath', idle: 'orbShoot' },
    drops: { orbs: 2 },
    attacks: [
      { name: 'volley', clip: 'volley', range: [3, 26], cooldown: 2.4, windup: 0.85, active: 0.6, recover: 0.6, ranged: 'orb', count: 3, dmg: 12, weight: 1.5 },
      { name: 'beam', clip: 'beam', range: [5, 20], cooldown: 7, windup: 1.3, active: 1.4, recover: 0.8, ranged: 'beam', dmg: 34, weight: 0.7, unblockable: true },
      { name: 'bite', clip: 'volley', range: [0, 2.4], cooldown: 1.6, windup: 0.5, active: 0.15, recover: 0.6, dmg: 16, reach: 2.4, arc: 90 * D, poiseDmg: 10, groundedOnly: true },
    ],
  },
  brute: {
    name: 'Brute', hp: 440, poise: 120, radius: 0.72, height: 2.7, mass: 4,
    walk: 1.4, run: 2.9, turn: 3.2, view: 20, fov: 100 * D, hearing: 9, eyeY: 2.4,
    skel: 'humanoid', canAssassinate: true, assassinFrac: 0.6, armoredFront: true, heavy: true,
    sounds: { alert: 'bruteRoar', pain: 'demonPain', death: 'bruteRoar', idle: 'bruteRoar' },
    drops: { orbs: 4 },
    attacks: [
      { name: 'punch', clip: 'punch', range: [0, 3.0], cooldown: 2.0, windup: 0.7, active: 0.18, recover: 0.7, dmg: 26, reach: 3.1, arc: 100 * D, lunge: 1.4, poiseDmg: 40, knockback: 3 },
      { name: 'slam', clip: 'slam', range: [0, 3.5], cooldown: 5.5, windup: 1.05, active: 0.2, recover: 1.0, dmg: 38, reach: 4.2, arc: 360 * D, aoe: true, unblockable: true, poiseDmg: 60, knockdown: true, weight: 0.8 },
      { name: 'charge', clip: 'charge', range: [5, 16], cooldown: 7, windup: 0.75, active: 1.4, recover: 0.6, dmg: 34, reach: 1.6, arc: 120 * D, charge: 12, unblockable: true, poiseDmg: 80, knockdown: true, weight: 1 },
    ],
  },
  boss: {
    name: 'The Cardinal of Ash', hp: 3200, poise: 9999, radius: 1.6, height: 6.5, mass: 50,
    walk: 1.8, run: 3.0, turn: 2.4, view: 80, fov: 360 * D, hearing: 80, eyeY: 5.6,
    skel: 'humanoid', canAssassinate: false, boss: true, heavy: true,
    sounds: { alert: 'bossRoar', pain: 'demonPain', death: 'bossRoar', idle: 'bossRoar' },
    drops: { orbs: 0 },
    attacks: [
      { name: 'sweep', clip: 'swipe', range: [0, 6.0], cooldown: 2.0, windup: 0.9, active: 0.25, recover: 0.9, dmg: 32, reach: 6.8, arc: 150 * D, poiseDmg: 50, knockback: 5 },
      { name: 'stomp', clip: 'slam', range: [0, 6.5], cooldown: 6, windup: 1.2, active: 0.2, recover: 1.2, dmg: 42, reach: 8, arc: 360 * D, aoe: true, unblockable: true, knockdown: true, weight: 0.9, shockwave: true },
      { name: 'firebreath', clip: 'breath', range: [3, 14], cooldown: 7, windup: 1.0, active: 1.6, recover: 0.8, ranged: 'breath', dmg: 22, weight: 0.8 },
      { name: 'meteors', clip: 'summon', range: [6, 40], cooldown: 11, windup: 1.4, active: 0.4, recover: 1.0, ranged: 'meteors', dmg: 30, weight: 0.8 },
      { name: 'summon', clip: 'summon', range: [0, 60], cooldown: 22, windup: 1.6, active: 0.3, recover: 1.0, summon: true, weight: 0.6, phaseMin: 1 },
    ],
  },
};

// -------------------------------------------------------- humanoid clips
export const ENEMY_CLIPS = {
  swipe: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { armR: [-2.3, 0, -0.7], foreR: [-0.7, 0, 0], spine: [-0.08, -0.4, 0], chest: [0, -0.25, 0], armL: [-0.4, 0, 0.45], foreL: [-0.6, 0, 0], thighR: [0.3, 0, 0], thighL: [-0.4, 0, 0] } },
    { t: 0.58, pose: { armR: [-1.1, 0.9, -0.25], foreR: [-0.15, 0, 0], spine: [0.38, 0.45, 0], chest: [0.15, 0.3, 0], armL: [0.2, 0, 0.4], thighR: [0.1, 0, 0], thighL: [-0.7, 0, 0], shinL: [0.6, 0, 0] } },
    { t: 0.72, pose: { armR: [-0.6, 1.0, -0.2], foreR: [-0.3, 0, 0], spine: [0.3, 0.5, 0], chest: [0.1, 0.3, 0], thighL: [-0.6, 0, 0], shinL: [0.5, 0, 0] } },
    { t: 1, pose: {} },
  ],
  lungeBite: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { spine: [-0.2, 0, 0], head: [-0.3, 0, 0], armL: [-1.0, 0, 0.6], armR: [-1.0, 0, -0.6], thighL: [-0.6, 0, 0], shinL: [0.9, 0, 0], thighR: [0.3, 0, 0] } },
    { t: 0.58, pose: { spine: [0.7, 0, 0], head: [-0.6, 0, 0], armL: [-1.6, 0, 0.25], armR: [-1.6, 0, -0.25], foreL: [-0.2, 0, 0], foreR: [-0.2, 0, 0], thighL: [-1.0, 0, 0], shinL: [1.0, 0, 0], thighR: [0.5, 0, 0] } },
    { t: 1, pose: {} },
  ],
  throw: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { armR: [-2.7, 0, -0.45], foreR: [-1.3, 0, 0], spine: [-0.18, -0.45, 0], chest: [-0.05, -0.2, 0], armL: [-1.2, 0, 0.4], foreL: [-0.3, 0, 0], thighL: [-0.5, 0, 0], thighR: [0.25, 0, 0] } },
    { t: 0.56, pose: { armR: [-1.4, 0.3, -0.1], foreR: [-0.15, 0, 0], spine: [0.35, 0.35, 0], chest: [0.15, 0.2, 0], armL: [0.2, 0, 0.4], thighL: [-0.7, 0, 0], shinL: [0.6, 0, 0] } },
    { t: 1, pose: {} },
  ],
  punch: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { armR: [0.5, 0, -0.35], foreR: [-2.1, 0, 0], spine: [-0.05, -0.55, 0], chest: [0, -0.25, 0], armL: [-0.9, 0, 0.3], foreL: [-1.4, 0, 0], thighL: [-0.4, 0, 0], thighR: [0.25, 0, 0] } },
    { t: 0.57, pose: { armR: [-1.55, 0.2, -0.05], foreR: [-0.1, 0, 0], spine: [0.3, 0.5, 0], chest: [0.15, 0.25, 0], armL: [-0.3, 0, 0.4], thighL: [-0.75, 0, 0], shinL: [0.6, 0, 0], thighR: [0.4, 0, 0] } },
    { t: 1, pose: {} },
  ],
  slam: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { armL: [-2.95, 0, 0.35], armR: [-2.95, 0, -0.35], foreL: [-0.7, 0, 0], foreR: [-0.7, 0, 0], spine: [-0.3, 0, 0], chest: [-0.15, 0, 0], head: [-0.2, 0, 0] } },
    { t: 0.56, pose: { armL: [-1.1, 0, 0.15], armR: [-1.1, 0, -0.15], foreL: [-0.1, 0, 0], foreR: [-0.1, 0, 0], spine: [0.85, 0, 0], chest: [0.3, 0, 0], thighL: [-0.9, 0, 0.2], thighR: [-0.9, 0, -0.2], shinL: [1.3, 0, 0], shinR: [1.3, 0, 0] } },
    { t: 0.75, pose: { armL: [-0.9, 0, 0.2], armR: [-0.9, 0, -0.2], spine: [0.7, 0, 0], thighL: [-0.8, 0, 0.2], thighR: [-0.8, 0, -0.2], shinL: [1.2, 0, 0], shinR: [1.2, 0, 0] } },
    { t: 1, pose: {} },
  ],
  charge: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { spine: [0.65, 0, 0], chest: [0.2, 0, 0], head: [0.3, 0, 0], armL: [0.6, 0, 0.5], armR: [0.6, 0, -0.5], thighL: [-0.5, 0, 0], thighR: [0.4, 0, 0], shinL: [0.8, 0, 0] } },
    { t: 0.55, pose: { spine: [0.75, 0, 0], chest: [0.2, 0, 0], head: [0.35, 0, 0], armL: [0.4, 0, 0.45], armR: [0.4, 0, -0.45] } },
    { t: 0.7, pose: { spine: [0.75, 0, 0], chest: [0.2, 0, 0], head: [0.35, 0, 0], armL: [0.4, 0, 0.45], armR: [0.4, 0, -0.45] } },
    { t: 1, pose: {} },
  ],
  breath: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { spine: [-0.35, 0, 0], chest: [-0.2, 0, 0], head: [-0.4, 0, 0], armL: [-0.5, 0, 0.9], armR: [-0.5, 0, -0.9] } },
    { t: 0.55, pose: { spine: [0.25, 0, 0], chest: [0.15, 0, 0], head: [0.15, 0, 0], armL: [-0.3, 0, 0.6], armR: [-0.3, 0, -0.6] } },
    { t: 0.7, pose: { spine: [0.25, 0, 0], chest: [0.15, 0, 0], head: [0.15, 0, 0], armL: [-0.3, 0, 0.6], armR: [-0.3, 0, -0.6] } },
    { t: 1, pose: {} },
  ],
  summon: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { armL: [-2.9, 0, 0.6], armR: [-2.9, 0, -0.6], foreL: [-0.2, 0, 0], foreR: [-0.2, 0, 0], spine: [-0.3, 0, 0], head: [-0.5, 0, 0] } },
    { t: 0.6, pose: { armL: [-2.6, 0, 1.0], armR: [-2.6, 0, -1.0], spine: [-0.35, 0, 0], head: [-0.6, 0, 0] } },
    { t: 1, pose: {} },
  ],
  screech: [
    { t: 0, pose: {} },
    { t: 0.3, pose: { spine: [-0.3, 0, 0], chest: [-0.2, 0, 0], head: [-0.55, 0, 0], armL: [-0.4, 0, 0.9], armR: [-0.4, 0, -0.9], foreL: [-0.6, 0, 0], foreR: [-0.6, 0, 0] } },
    { t: 0.8, pose: { spine: [-0.25, 0, 0], chest: [-0.15, 0, 0], head: [-0.45, 0.2, 0], armL: [-0.4, 0, 0.9], armR: [-0.4, 0, -0.9], foreL: [-0.6, 0, 0], foreR: [-0.6, 0, 0] } },
    { t: 1, pose: {} },
  ],
  hit: [
    { t: 0, pose: { spine: [-0.38, 0.25, 0], chest: [-0.2, 0.1, 0], head: [-0.35, 0, 0], armL: [0.3, 0, 0.6], armR: [0.3, 0, -0.6], foreL: [-0.4, 0, 0], foreR: [-0.4, 0, 0] } },
    { t: 1, pose: {} },
  ],
  stagger: [
    { t: 0, pose: { spine: [-0.3, 0.2, 0.1], chest: [-0.2, 0, 0], head: [-0.3, 0.3, 0], armL: [0.2, 0, 0.8], armR: [0.2, 0, -0.8], foreL: [-0.4, 0, 0], foreR: [-0.4, 0, 0], thighL: [-0.3, 0, 0.1], thighR: [0.2, 0, -0.1], shinL: [0.5, 0, 0] } },
    { t: 0.5, pose: { spine: [0.2, -0.2, -0.1], chest: [0.1, 0, 0], head: [0.2, -0.3, 0], armL: [-0.2, 0, 0.5], armR: [-0.2, 0, -0.5], thighL: [-0.4, 0, 0.1], shinL: [0.7, 0, 0], thighR: [-0.2, 0, -0.1], shinR: [0.5, 0, 0] } },
    { t: 1, pose: { spine: [-0.3, 0.2, 0.1], chest: [-0.2, 0, 0], head: [-0.3, 0.3, 0], armL: [0.2, 0, 0.8], armR: [0.2, 0, -0.8], foreL: [-0.4, 0, 0], foreR: [-0.4, 0, 0], thighL: [-0.3, 0, 0.1], thighR: [0.2, 0, -0.1], shinL: [0.5, 0, 0] } },
  ],
  glory: [
    { t: 0, pose: { spine: [0.55, 0.15, 0.1], chest: [0.25, 0, 0], head: [0.4, 0.2, 0], armL: [0.1, 0, 0.25], armR: [-0.3, 0, -0.35], foreL: [-0.2, 0, 0], foreR: [-0.5, 0, 0], thighL: [-1.2, 0, 0.15], shinL: [1.9, 0, 0], thighR: [-0.2, 0, -0.1], shinR: [1.5, 0, 0] } },
    { t: 0.5, pose: { spine: [0.65, -0.1, -0.05], chest: [0.3, 0, 0], head: [0.5, -0.2, 0], armL: [0.05, 0, 0.3], armR: [-0.2, 0, -0.3], foreL: [-0.3, 0, 0], foreR: [-0.6, 0, 0], thighL: [-1.25, 0, 0.15], shinL: [1.95, 0, 0], thighR: [-0.25, 0, -0.1], shinR: [1.55, 0, 0] } },
    { t: 1, pose: { spine: [0.55, 0.15, 0.1], chest: [0.25, 0, 0], head: [0.4, 0.2, 0], armL: [0.1, 0, 0.25], armR: [-0.3, 0, -0.35], foreL: [-0.2, 0, 0], foreR: [-0.5, 0, 0], thighL: [-1.2, 0, 0.15], shinL: [1.9, 0, 0], thighR: [-0.2, 0, -0.1], shinR: [1.5, 0, 0] } },
  ],
  dazed: [
    { t: 0, pose: { spine: [0.2, 0, 0.15], head: [0.3, 0, 0.3], armL: [0.1, 0, 0.2], armR: [0.1, 0, -0.2] } },
    { t: 0.5, pose: { spine: [0.2, 0, -0.15], head: [0.3, 0, -0.3], armL: [0.1, 0, 0.25], armR: [0.1, 0, -0.25] } },
    { t: 1, pose: { spine: [0.2, 0, 0.15], head: [0.3, 0, 0.3], armL: [0.1, 0, 0.2], armR: [0.1, 0, -0.2] } },
  ],
  down: [
    { t: 0, pose: { spine: [-0.2, 0, 0], head: [-0.3, 0.4, 0], armL: [-0.3, 0, 1.3], armR: [-0.3, 0, -1.3], thighL: [-0.4, 0, 0.2], shinL: [0.8, 0, 0], thighR: [-0.1, 0, -0.15], shinR: [0.3, 0, 0] } },
  ],
  death: [
    { t: 0, pose: { spine: [-0.3, 0, 0], head: [-0.4, 0, 0], armL: [-0.6, 0, 1.0], armR: [-0.6, 0, -1.0] } },
    { t: 1, pose: { spine: [0.2, 0, 0], head: [0.4, 0.5, 0], armL: [-0.2, 0, 1.4], armR: [0.2, 0, -1.2], thighL: [-0.3, 0, 0.2], shinL: [0.6, 0, 0], thighR: [-0.1, 0, -0.2] } },
  ],
  grabbed: [
    { t: 0, pose: { spine: [-0.45, 0, 0], chest: [-0.25, 0, 0], head: [-0.6, 0, 0], armL: [-0.6, 0, 0.7], armR: [-0.6, 0, -0.7], foreL: [-0.8, 0, 0], foreR: [-0.8, 0, 0], thighL: [-0.3, 0, 0], shinL: [0.6, 0, 0] } },
  ],
  // hound
  bite: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { neck: [-0.4, 0, 0], head: [-0.3, 0, 0], jaw: [0.7, 0, 0], chest: [-0.15, 0, 0] } },
    { t: 0.58, pose: { neck: [0.35, 0, 0], head: [0.2, 0, 0], jaw: [0.05, 0, 0], chest: [0.15, 0, 0] } },
    { t: 1, pose: {} },
  ],
  pounce: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { body: [0.25, 0, 0], chest: [-0.2, 0, 0], neck: [0.2, 0, 0], flU: [0.6, 0, 0], frU: [0.6, 0, 0], flL: [-1.0, 0, 0], frL: [-1.0, 0, 0], blU: [-0.6, 0, 0], brU: [-0.6, 0, 0], blL: [1.0, 0, 0], brL: [1.0, 0, 0], jaw: [0.4, 0, 0] } },
    { t: 0.55, pose: { body: [-0.15, 0, 0], neck: [-0.3, 0, 0], flU: [-1.2, 0, 0], frU: [-1.2, 0, 0], flL: [0.3, 0, 0], frL: [0.3, 0, 0], blU: [0.9, 0, 0], brU: [0.9, 0, 0], blL: [-0.2, 0, 0], brL: [-0.2, 0, 0], jaw: [0.8, 0, 0] } },
    { t: 0.72, pose: { body: [-0.05, 0, 0], flU: [-0.6, 0, 0], frU: [-0.6, 0, 0], blU: [0.5, 0, 0], brU: [0.5, 0, 0], jaw: [0.3, 0, 0] } },
    { t: 1, pose: {} },
  ],
  // gazer
  volley: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { body: [-0.25, 0, 0], jaw: [0.6, 0, 0] } },
    { t: 0.6, pose: { body: [0.15, 0, 0], jaw: [0.9, 0, 0] } },
    { t: 1, pose: {} },
  ],
  beam: [
    { t: 0, pose: {} },
    { t: 0.45, pose: { body: [-0.2, 0, 0], jaw: [0.3, 0, 0], eye: [0, 0, 0] } },
    { t: 0.55, pose: { body: [0.05, 0, 0], jaw: [0.5, 0, 0] } },
    { t: 0.7, pose: { body: [0.05, 0, 0], jaw: [0.5, 0, 0] } },
    { t: 1, pose: {} },
  ],
};
