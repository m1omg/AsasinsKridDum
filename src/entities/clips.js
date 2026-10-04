// Keyframed procedural clips (normalized time). Poses are bone -> [rx, ry, rz].
// Conventions (see rig.js): limbs hang down, negative rx swings them forward;
// spine/head positive rx leans forward; armL rz > 0 raises the left arm out,
// armR rz < 0 raises the right arm out; ry > 0 twists to the character's left.

export const CLIPS = {
  mantle: [
    { t: 0, pose: { armL: [-2.85, 0, 0.2], armR: [-2.85, 0, -0.2], foreL: [-0.3, 0, 0], foreR: [-0.3, 0, 0], spine: [0.05, 0, 0], head: [-0.3, 0, 0], thighL: [-0.3, 0, 0.1], thighR: [-0.2, 0, -0.1], shinL: [0.5, 0, 0], shinR: [0.4, 0, 0] } },
    { t: 0.4, pose: { armL: [-0.9, 0, 0.45], armR: [-0.9, 0, -0.45], foreL: [-1.7, 0, 0], foreR: [-1.7, 0, 0], spine: [0.55, 0, 0], chest: [0.2, 0, 0], head: [-0.4, 0, 0], thighL: [-0.6, 0, 0.1], thighR: [0.1, 0, -0.1], shinL: [1.2, 0, 0], shinR: [0.6, 0, 0] } },
    { t: 0.7, pose: { armL: [0.25, 0, 0.3], armR: [0.25, 0, -0.3], foreL: [-0.5, 0, 0], foreR: [-0.5, 0, 0], spine: [0.5, 0, 0], chest: [0.15, 0, 0], head: [-0.3, 0, 0], thighL: [-1.9, 0, 0.15], thighR: [-0.3, 0, -0.1], shinL: [2.1, 0, 0], shinR: [1.0, 0, 0] } },
    { t: 1, pose: { armL: [0.05, 0, 0.12], armR: [0.05, 0, -0.12], foreL: [-0.3, 0, 0], foreR: [-0.3, 0, 0], spine: [0.1, 0, 0], thighL: [-0.3, 0, 0.05], thighR: [-0.1, 0, -0.05], shinL: [0.5, 0, 0], shinR: [0.2, 0, 0] } },
  ],
  vault: [
    { t: 0, pose: { armL: [-0.6, 0, 0.2], armR: [0.4, 0, -0.2], foreL: [-0.8, 0, 0], foreR: [-0.8, 0, 0], spine: [0.25, 0, 0], thighL: [-0.8, 0, 0], thighR: [0.4, 0, 0], shinL: [1.0, 0, 0], shinR: [0.6, 0, 0] } },
    { t: 0.45, pose: { armL: [-1.25, 0, 0.35], armR: [-0.5, 0, -0.9], foreL: [-0.1, 0, 0], foreR: [-0.6, 0, 0], spine: [0.45, 0.3, -0.25], chest: [0.1, 0.2, 0], thighL: [-1.4, 0, 0.7], thighR: [-1.2, 0, 0.5], shinL: [1.4, 0, 0], shinR: [1.6, 0, 0] } },
    { t: 1, pose: { armL: [0.2, 0, 0.3], armR: [-0.3, 0, -0.3], foreL: [-0.6, 0, 0], foreR: [-0.6, 0, 0], spine: [0.15, 0, 0], thighL: [-0.5, 0, 0.05], thighR: [0.2, 0, -0.05], shinL: [0.7, 0, 0], shinR: [0.5, 0, 0] } },
  ],
  sync: [
    { t: 0, pose: { spine: [0.55, 0, 0], chest: [0.25, 0, 0], head: [-0.55, 0, 0], thighL: [-1.75, 0, 0.3], thighR: [-1.6, 0, -0.3], shinL: [2.45, 0, 0], shinR: [2.35, 0, 0], footL: [-0.65, 0, 0], footR: [-0.7, 0, 0], armL: [-0.85, 0, 0.35], armR: [-0.4, 0, -0.45], foreL: [-0.8, 0, 0], foreR: [-1.0, 0, 0] } },
    { t: 1, pose: { spine: [0.5, 0.15, 0], chest: [0.2, 0.15, 0], head: [-0.45, 0.4, 0], thighL: [-1.75, 0, 0.3], thighR: [-1.6, 0, -0.3], shinL: [2.45, 0, 0], shinR: [2.35, 0, 0], footL: [-0.65, 0, 0], footR: [-0.7, 0, 0], armL: [-0.85, 0, 0.35], armR: [-0.4, 0, -0.45], foreL: [-0.8, 0, 0], foreR: [-1.0, 0, 0] } },
  ],
  dive: [
    { t: 0, pose: { spine: [-0.2, 0, 0], armL: [-0.3, 0, 1.2], armR: [-0.3, 0, -1.2], foreL: [0, 0, 0], foreR: [0, 0, 0], thighL: [0.1, 0, 0.05], thighR: [0.1, 0, -0.05], shinL: [0.2, 0, 0], shinR: [0.2, 0, 0], head: [-0.5, 0, 0] } },
    { t: 1, pose: { spine: [-0.1, 0, 0], armL: [-0.2, 0, 1.5], armR: [-0.2, 0, -1.5], foreL: [0, 0, 0], foreR: [0, 0, 0], thighL: [0.15, 0, 0.04], thighR: [0.15, 0, -0.04], shinL: [0.1, 0, 0], shinR: [0.1, 0, 0], head: [-0.7, 0, 0] } },
  ],
  hidden: [
    { t: 0, pose: { spine: [0.6, 0, 0], thighL: [-1.8, 0, 0.3], thighR: [-1.8, 0, -0.3], shinL: [2.4, 0, 0], shinR: [2.4, 0, 0] } },
  ],
};

/** Sum of a clip's frames' bones, used to know which bones a clip drives. */
export function clipBones(frames) {
  const s = new Set();
  for (const f of frames) for (const k in f.pose) s.add(k);
  return s;
}
