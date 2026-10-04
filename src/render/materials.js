import * as THREE from 'three';

// Shared material library. World materials get a small shader patch that adds
// large-scale colour variation and dark grime near the ground, which hides
// texture repetition across the city.

const NOISE_GLSL = /* glsl */ `
float hc_hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float hc_noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hc_hash(i), b = hc_hash(i+vec2(1.,0.)), c = hc_hash(i+vec2(0.,1.)), d = hc_hash(i+vec2(1.,1.));
  vec2 u = f*f*(3.-2.*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
`;

function patchWorld(mat, { grime = 0.45, grimeHeight = 2.2, noiseAmp = 0.22, noiseScale = 0.11, ground = false } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrime = { value: grime };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHcWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec4 hcW = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nhcW = instanceMatrix * hcW;\n#endif\nvHcWorld = (modelMatrix * hcW).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHcWorld;\nuniform float uGrime;\n' + NOISE_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec2 np = ${ground ? 'vHcWorld.xz' : 'vHcWorld.xz + vec2(vHcWorld.y*0.7, -vHcWorld.y*0.4)'} * ${noiseScale.toFixed(4)};
        float n = hc_noise(np) * 0.65 + hc_noise(np * 3.1) * 0.35;
        diffuseColor.rgb *= ${(1 - noiseAmp).toFixed(3)} + ${(noiseAmp * 2).toFixed(3)} * n;
        ${ground ? '' : `float g = smoothstep(0.0, ${grimeHeight.toFixed(2)}, vHcWorld.y);
        diffuseColor.rgb *= mix(1.0 - uGrime, 1.0, g);`}
      }`);
  };
  mat.customProgramCacheKey = () => 'world' + (ground ? 'g' : 'w') + grime + grimeHeight + noiseAmp + noiseScale;
  return mat;
}

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hayTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#b08a3a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      const a = (Math.random() - 0.5) * 1.2, l = 8 + Math.random() * 22;
      const v = 150 + Math.random() * 90;
      g.strokeStyle = `rgba(${v},${v * 0.8},${v * 0.35},${0.5 + Math.random() * 0.5})`;
      g.lineWidth = 1 + Math.random() * 1.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(a) * l, y + Math.cos(a) * l);
      g.stroke();
      // wrap copies so the tile is seamless
      for (const [ox, oy] of [[w, 0], [-w, 0], [0, h], [0, -h]]) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.lineTo(x + ox + Math.sin(a) * l, y + oy + Math.cos(a) * l);
        g.stroke();
      }
    }
  });
}

export function radialAlphaTexture(size = 256, inner = 0.55) {
  return canvasTexture(size, size, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(inner, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }, false);
}

export function createMaterials(tex) {
  const m = {};
  const std = (o) => new THREE.MeshStandardMaterial(o);

  m.plaster = patchWorld(std({ map: tex.plaster, normalMap: tex.plaster_n, vertexColors: true, roughness: 0.93, metalness: 0 }), { grime: 0.5 });
  m.stone = patchWorld(std({ map: tex.stone, normalMap: tex.stone_n, vertexColors: true, roughness: 0.86, metalness: 0 }), { grime: 0.4, noiseAmp: 0.18 });
  m.roof = patchWorld(std({ map: tex.roof, normalMap: tex.roof_n, vertexColors: true, roughness: 0.78, metalness: 0 }), { grime: 0.0, noiseAmp: 0.2, noiseScale: 0.07 });
  m.wood = patchWorld(std({ map: tex.wood, normalMap: tex.wood_n, vertexColors: true, roughness: 0.82, metalness: 0 }), { grime: 0.25, noiseAmp: 0.12 });
  m.cobble = patchWorld(std({ map: tex.cobble, normalMap: tex.cobble_n, vertexColors: true, roughness: 0.92, metalness: 0 }), { ground: true, noiseAmp: 0.25, noiseScale: 0.05 });
  m.hellrock = std({ map: tex.hellrock, normalMap: tex.hellrock_n, emissiveMap: tex.hellrock_e, emissive: new THREE.Color(1, 0.55, 0.3), emissiveIntensity: 2.2, roughness: 0.7, metalness: 0.1, vertexColors: true });
  const decalAlpha = radialAlphaTexture(256, 0.45);
  decalAlpha.wrapS = decalAlpha.wrapT = THREE.ClampToEdgeWrapping;
  decalAlpha.repeat.set(1 / 6, 1 / 6);
  m.hellrockDecal = std({ map: tex.hellrock, normalMap: tex.hellrock_n, emissiveMap: tex.hellrock_e, emissive: new THREE.Color(1, 0.55, 0.3), emissiveIntensity: 2.2, roughness: 0.7, alphaMap: decalAlpha, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.flesh = std({ map: tex.demonskin, normalMap: tex.demonskin_n, vertexColors: true, roughness: 0.55, metalness: 0.05, emissive: new THREE.Color(0.25, 0.02, 0.0), emissiveIntensity: 1 });
  m.windowDark = std({ color: 0x0b0807, roughness: 0.35, metalness: 0.1 });
  m.windowLit = std({ color: 0x2a1406, emissive: new THREE.Color(1.0, 0.45, 0.12), emissiveIntensity: 2.4, roughness: 0.5 });
  m.metal = std({ color: 0x45403a, roughness: 0.42, metalness: 0.85, vertexColors: true });
  m.gold = std({ color: 0xc89b4a, roughness: 0.3, metalness: 1.0 });
  m.hay = std({ map: hayTexture(), vertexColors: true, roughness: 1.0 });
  m.fabric = std({ map: tex.cloth, normalMap: tex.cloth_n, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  m.ember = new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false });
  m.glowRed = new THREE.MeshBasicMaterial({ color: 0xff3010, toneMapped: false });
  m.bone = std({ color: 0xd8ccb0, roughness: 0.7 });
  m.blackMetal = std({ color: 0x1a1715, roughness: 0.5, metalness: 0.8 });

  // Character materials (vertex colours carry the per-part tint)
  m.charCloth = std({ map: tex.cloth, normalMap: tex.cloth_n, vertexColors: true, roughness: 0.9, metalness: 0 });
  m.charLeather = std({ map: tex.cloth, vertexColors: true, roughness: 0.6, metalness: 0.05 });
  m.charMetal = std({ vertexColors: true, roughness: 0.32, metalness: 0.9 });
  m.charSkin = std({ vertexColors: true, roughness: 0.65, metalness: 0 });
  m.demon = std({ map: tex.demonskin, normalMap: tex.demonskin_n, vertexColors: true, roughness: 0.5, metalness: 0.05 });
  m.demonGlow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  return m;
}
