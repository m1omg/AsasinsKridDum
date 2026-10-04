import * as THREE from 'three';

// Sky dome mapped from a 360 degree panorama assembled from two generated
// 21:9 halves (cross-faded joins, see tools/process_textures.py).
// A procedural hell vortex hangs over the cathedral as a global landmark.

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTop, uBottom;
uniform float uHorizonV, uSpan, uBright, uTime, uFlash;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float az = atan(d.x, -d.z);
  float u = az / 6.2831853 + 0.5;
  float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
  float v = uHorizonV + el / uSpan;
  vec3 col = texture2D(uMap, vec2(u + uTime * 0.0008, clamp(v, 0.002, 0.998))).rgb;
  col = mix(col, uTop, smoothstep(0.82, 1.0, v));
  col = mix(col, uBottom, smoothstep(0.03, -0.06, v));
  col *= uBright;
  col += vec3(1.0, 0.35, 0.2) * uFlash * smoothstep(-0.05, 0.4, d.y);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const VORTEX_FS = /* glsl */ `
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
  float sw = a * 3.0 + log(r + 0.05) * 6.0 - uTime * 0.6;
  float arms = 0.5 + 0.5 * sin(sw);
  float n = n2(vec2(a * 4.0 + uTime * 0.2, r * 9.0 - uTime * 0.7)) * 0.6 + n2(vec2(sw, r * 3.0)) * 0.4;
  float core = smoothstep(0.35, 0.0, r);
  float ring = smoothstep(1.0, 0.55, r);
  vec3 col = mix(vec3(0.9, 0.12, 0.02), vec3(1.0, 0.55, 0.15), arms * n);
  col = mix(col, vec3(1.0, 0.92, 0.7), core * 0.85);
  float alpha = ring * (0.35 + 0.65 * arms * n + core) * uOpen;
  gl_FragColor = vec4(col * alpha * 1.6, 1.0);
}`;

export class Sky {
  constructor(scene, tex) {
    this.uniforms = {
      uMap: { value: tex.sky },
      uTop: { value: new THREE.Color(0x2c1112) },
      uBottom: { value: new THREE.Color(0x0c0201) },
      uHorizonV: { value: 0.1 },
      uSpan: { value: 82 },
      uBright: { value: 1.0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    this.vortexUniforms = { uTime: { value: 0 }, uOpen: { value: 1 } };
    const vmat = new THREE.ShaderMaterial({
      uniforms: this.vortexUniforms,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: VORTEX_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.vortex = new THREE.Mesh(new THREE.CircleGeometry(150, 64), vmat);
    this.vortex.rotation.x = Math.PI / 2;
    this.vortex.position.set(0, 330, -40);
    this.vortex.renderOrder = -9;
    this.vortex.frustumCulled = false;
    scene.add(this.vortex);
    this.lightning = 0;
    this.nextLightning = 4;
  }

  /** Bake the sky into a prefiltered environment map (reflections on metal, ambient specular). */
  bakeEnvironment(renderer, scene, intensity = 0.55) {
    try {
      const envScene = new THREE.Scene();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.dome.material);
      envScene.add(dome);
      const pm = new THREE.PMREMGenerator(renderer);
      const rt = pm.fromScene(envScene, 0.02, 0.1, 200);
      pm.dispose();
      scene.environment = rt.texture;
      scene.environmentIntensity = intensity;
      dome.geometry.dispose();
    } catch (e) {
      console.warn('environment bake failed', e);
    }
  }

  update(dt, camera, time) {
    this.dome.position.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.vortexUniforms.uTime.value = time;
    // occasional red lightning flashes
    this.nextLightning -= dt;
    if (this.nextLightning <= 0) {
      this.lightning = 1;
      this.nextLightning = 5 + Math.random() * 12;
      if (this.onLightning) this.onLightning();
    }
    this.lightning = Math.max(0, this.lightning - dt * 3.5);
    const flicker = this.lightning > 0 ? this.lightning * (0.6 + 0.4 * Math.sin(time * 60)) : 0;
    this.uniforms.uFlash.value = flicker * 0.5;
    return flicker;
  }
}
