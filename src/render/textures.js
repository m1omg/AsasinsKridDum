import * as THREE from 'three';

// Textures generated with Higgsfield (gpt_image_2_5) and post-processed by
// tools/process_textures.py into seamless tiles + derived normal maps.
import cobbleUrl from '../../assets/textures/cobble.webp';
import cobbleNUrl from '../../assets/textures/cobble_n.webp';
import stoneUrl from '../../assets/textures/stone.webp';
import stoneNUrl from '../../assets/textures/stone_n.webp';
import plasterUrl from '../../assets/textures/plaster.webp';
import plasterNUrl from '../../assets/textures/plaster_n.webp';
import roofUrl from '../../assets/textures/roof.webp';
import roofNUrl from '../../assets/textures/roof_n.webp';
import woodUrl from '../../assets/textures/wood.webp';
import woodNUrl from '../../assets/textures/wood_n.webp';
import hellrockUrl from '../../assets/textures/hellrock.webp';
import hellrockNUrl from '../../assets/textures/hellrock_n.webp';
import hellrockEUrl from '../../assets/textures/hellrock_e.webp';
import demonskinUrl from '../../assets/textures/demonskin.webp';
import demonskinNUrl from '../../assets/textures/demonskin_n.webp';
import clothUrl from '../../assets/textures/cloth.webp';
import clothNUrl from '../../assets/textures/cloth_n.webp';
import skyUrl from '../../assets/textures/sky.webp';
import titleUrl from '../../assets/textures/title.webp';

export const TITLE_URL = titleUrl;

const LIST = {
  cobble: [cobbleUrl, true], cobble_n: [cobbleNUrl, false],
  stone: [stoneUrl, true], stone_n: [stoneNUrl, false],
  plaster: [plasterUrl, true], plaster_n: [plasterNUrl, false],
  roof: [roofUrl, true], roof_n: [roofNUrl, false],
  wood: [woodUrl, true], wood_n: [woodNUrl, false],
  hellrock: [hellrockUrl, true], hellrock_n: [hellrockNUrl, false], hellrock_e: [hellrockEUrl, true],
  demonskin: [demonskinUrl, true], demonskin_n: [demonskinNUrl, false],
  cloth: [clothUrl, true], cloth_n: [clothNUrl, false],
  sky: [skyUrl, true],
};

/** Load every texture; resolves with a name -> THREE.Texture map. */
export function loadTextures(renderer, onProgress) {
  const manager = new THREE.LoadingManager();
  const loader = new THREE.TextureLoader(manager);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const out = {};
  const names = Object.keys(LIST);
  let done = 0;
  return new Promise((resolve) => {
    for (const name of names) {
      const [url, srgb] = LIST[name];
      const finish = (tex) => {
        if (tex) {
          tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = name === 'sky' ? 1 : maxAniso;
          if (name === 'sky') {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.generateMipmaps = false;
            tex.minFilter = THREE.LinearFilter;
          }
          out[name] = tex;
        } else {
          // fallback 1x1 texture so the game still runs if a file fails
          const d = new THREE.DataTexture(new Uint8Array(srgb ? [160, 140, 120, 255] : [128, 128, 255, 255]), 1, 1);
          d.needsUpdate = true;
          d.wrapS = d.wrapT = THREE.RepeatWrapping;
          out[name] = d;
        }
        done++;
        if (onProgress) onProgress(done / names.length);
        if (done === names.length) resolve(out);
      };
      loader.load(url, finish, undefined, () => finish(null));
    }
  });
}
