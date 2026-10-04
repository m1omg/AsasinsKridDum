import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

export const LAYER_XRAY = 2; // demons, seen through walls with Ashen Sight
export const LAYER_XRAY_GOLD = 3; // interactables

export const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 1024, bloom: false, samples: 0, shadowExtent: 40, particles: 0.5 },
  medium: { pixelRatio: 1.0, shadows: true, shadowSize: 2048, bloom: true, samples: 2, shadowExtent: 48, particles: 1 },
  high: { pixelRatio: 1.5, shadows: true, shadowSize: 4096, bloom: true, samples: 4, shadowExtent: 60, particles: 1.3 },
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSight: { value: 0 },
    uDamage: { value: 0 },
    uLowHealth: { value: 0 },
    uVignette: { value: 0.55 },
    uFlash: { value: 0 },
    uDesat: { value: 0 },
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uSight, uDamage, uLowHealth, uVignette, uFlash, uDesat, uFade;
    varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      // subtle filmic warm grade
      col = mix(col, col * vec3(1.06, 0.98, 0.92), 0.6);
      col = mix(vec3(l), col, 1.0 - uDesat);
      // Ashen Sight: cold desaturated world, highlights keep their colour
      vec3 sight = vec3(l) * vec3(0.42, 0.48, 0.62);
      float keep = smoothstep(0.55, 1.4, max(col.r - col.g, 0.0) + max(col.g - col.b, 0.0));
      col = mix(col, mix(sight, col, keep), uSight);
      vec2 p = vUv - 0.5;
      float r = length(p * vec2(1.0, 0.78));
      col *= mix(1.0, smoothstep(0.85, 0.2, r), uVignette + uSight * 0.25);
      float edge = smoothstep(0.22, 0.78, r);
      float pulse = uLowHealth * (0.35 + 0.18 * sin(uTime * 5.5));
      col = mix(col, vec3(0.45, 0.0, 0.0), clamp(edge * (uDamage * 0.85 + pulse), 0.0, 0.85));
      col += vec3(1.0, 0.85, 0.7) * uFlash;
      float n = fract(sin(dot(vUv * vec2(12.9898, 78.233) + fract(uTime) * 7.0, vec2(1.0))) * 43758.5453);
      col += (n - 0.5) * 0.03 * (0.4 + l);
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, c.a);
    }`,
};

/** Renders objects on a layer with an override material on top of the frame (ignores depth). */
class XRayPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.enabled = false;
    this.redMat = new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.goldMat = new THREE.MeshBasicMaterial({ color: 0xffc040, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.intensity = 0;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    const oldMask = cam.layers.mask;
    const oldOverride = this.scene.overrideMaterial;
    const oldAuto = renderer.autoClear;
    const oldBg = this.scene.background;
    const oldFog = this.scene.fog;
    const oldShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    this.scene.background = null;
    this.scene.fog = null;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.redMat.opacity = 0.55 * this.intensity;
    this.goldMat.opacity = 0.45 * this.intensity;
    cam.layers.set(LAYER_XRAY);
    this.scene.overrideMaterial = this.redMat;
    renderer.render(this.scene, cam);
    cam.layers.set(LAYER_XRAY_GOLD);
    this.scene.overrideMaterial = this.goldMat;
    renderer.render(this.scene, cam);
    cam.layers.mask = oldMask;
    this.scene.overrideMaterial = oldOverride;
    this.scene.background = oldBg;
    this.scene.fog = oldFog;
    renderer.autoClear = oldAuto;
    renderer.shadowMap.autoUpdate = oldShadow;
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    let gl;
    try {
      gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    } catch (e) {
      throw new Error('WebGL is not available: ' + e.message);
    }
    this.gl = gl;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x3a1a12, 0.0062);
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1500);
    this.camera.layers.enable(LAYER_XRAY);
    this.camera.layers.enable(LAYER_XRAY_GOLD);

    // Lighting: dim red sky fill + warm low "hellfire" key light with shadows
    this.hemi = new THREE.HemisphereLight(0xff8a66, 0x2a1210, 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffb27a, 2.4);
    this.sunDir = new THREE.Vector3(-0.5, 0.62, -0.6).normalize();
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.ambient = new THREE.AmbientLight(0x402020, 0.35);
    this.scene.add(this.ambient);

    this.shadowFocus = new THREE.Vector3();
    this.quality = 'medium';
    this.settings = QUALITY.medium;
    this._buildComposer();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _buildComposer() {
    const s = this.settings;
    if (this.composer) this.composer.dispose();
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: s.samples });
    this.composer = new EffectComposer(this.gl, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.xray = new XRayPass(this.scene, this.camera);
    this.composer.addPass(this.xray);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.82);
    this.bloom.enabled = s.bloom;
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setQuality(q) {
    if (!QUALITY[q]) q = 'medium';
    const prevSamples = this.settings.samples;
    this.quality = q;
    this.settings = QUALITY[q];
    const s = this.settings;
    this.gl.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.sun.shadow.mapSize.set(s.shadowSize, s.shadowSize);
    const e = s.shadowExtent;
    const cam = this.sun.shadow.camera;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e; cam.near = 1; cam.far = 260;
    cam.updateProjectionMatrix();
    if (prevSamples !== s.samples) this._buildComposer();
    this.bloom.enabled = s.bloom;
    // materials must recompile when shadow state changes
    this.scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 2) * this.settings.pixelRatio;
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w * pr * 0.5, h * pr * 0.5);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pixelHeight = h * pr;
  }

  /** Keep the shadow frustum centred on the action, snapped to texels to avoid shimmer. */
  updateShadow(focus) {
    const s = this.settings;
    const d = this.sunDir;
    const texel = (2 * s.shadowExtent) / s.shadowSize;
    // light-space basis
    const right = new THREE.Vector3(0, 1, 0).cross(d).normalize();
    const up = d.clone().cross(right).normalize();
    const rx = Math.round(focus.dot(right) / texel) * texel;
    const uy = Math.round(focus.dot(up) / texel) * texel;
    const dz = focus.dot(d);
    this.shadowFocus.copy(right).multiplyScalar(rx).addScaledVector(up, uy).addScaledVector(d, dz);
    this.sun.target.position.copy(this.shadowFocus);
    this.sun.position.copy(this.shadowFocus).addScaledVector(d, 120);
    this.sun.target.updateMatrixWorld();
  }

  render() {
    this.composer.render();
  }
}
