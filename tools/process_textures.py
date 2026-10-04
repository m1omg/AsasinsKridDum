#!/usr/bin/env python3
"""Turn the raw Higgsfield generations into game-ready textures.

Usage: python3 tools/process_textures.py <raw_dir>

For every tileable texture this script:
  * makes it seamless (crop + narrow cross-fade at the best matching offset),
  * resizes it to a power of two,
  * derives a tangent-space normal map from luminance (OpenGL convention),
  * for the hellrock texture also extracts an emissive (glowing lava) map.
The sky panorama and the title key art are only re-encoded.
Requires: pillow, numpy.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'textures')

# name: (output size, normal strength, blend band px)
TILEABLE = {
    'cobble': (1024, 5.0, 72),
    'stone': (1024, 3.5, 64),
    'plaster': (1024, 1.6, 96),
    'roof': (1024, 4.0, 64),
    'wood': (1024, 2.5, 64),
    'hellrock': (1024, 4.0, 72),
    'demonskin': (512, 3.0, 64),
    'cloth': (512, 1.4, 64),
}


def best_end(img, b, search_frac=0.22):
    """Pick the crop end column whose last b columns best match the first b."""
    w = img.shape[1]
    left = img[:, :b]
    best_e, best_err = w, None
    for e in range(int(w * (1 - search_frac)), w + 1):
        right = img[:, e - b:e]
        err = float(np.mean((right - left) ** 2))
        if best_err is None or err < best_err:
            best_err, best_e = err, e
    return best_e


def seamless_x(img, b):
    e = best_end(img, b)
    s = np.linspace(0.0, 1.0, b)
    s = s * s * (3 - 2 * s)  # smoothstep
    s = s[None, :, None]
    out = img[:, :e - b].copy()
    out[:, :b] = img[:, e - b:e] * (1 - s) + img[:, :b] * s
    return out


def make_seamless(img, b):
    img = seamless_x(img, b)
    img = np.transpose(img, (1, 0, 2))
    img = seamless_x(img, b)
    return np.transpose(img, (1, 0, 2))


def normal_map(rgb, strength):
    h = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2])
    # light blur (wrapping) to suppress noise
    k = np.array([1, 4, 6, 4, 1], dtype=np.float64)
    k /= k.sum()
    for axis in (0, 1):
        h = sum(np.roll(h, i - 2, axis=axis) * k[i] for i in range(5))
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    nx = -dx * strength
    ny = dy * strength
    nz = np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / ln, ny / ln, nz / ln], axis=-1)
    return np.clip((n * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)


def save_webp(arr_or_img, path, quality):
    im = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(arr_or_img)
    im.save(path, 'WEBP', quality=quality, method=6)
    print(f'  wrote {os.path.basename(path)} {im.size} {os.path.getsize(path) // 1024} KB')


def main(raw):
    os.makedirs(OUT, exist_ok=True)
    for name, (size, strength, band) in TILEABLE.items():
        src = os.path.join(raw, name + '.png')
        print(name)
        img = np.asarray(Image.open(src).convert('RGB'), dtype=np.float64) / 255.0
        img = make_seamless(img, band)
        im = Image.fromarray(np.clip(img * 255, 0, 255).astype(np.uint8)).resize((size, size), Image.LANCZOS)
        save_webp(im, os.path.join(OUT, name + '.webp'), 82)
        rgb = np.asarray(im, dtype=np.float64) / 255.0
        nsize = min(size, 512)
        nim = Image.fromarray(normal_map(rgb, strength * size / 512.0)).resize((nsize, nsize), Image.LANCZOS)
        save_webp(nim, os.path.join(OUT, name + '_n.webp'), 88)
        if name == 'hellrock':
            lum = rgb.max(axis=-1)
            warm = np.clip((rgb[..., 0] - rgb[..., 2]) * 2.0, 0, 1)
            mask = np.clip((lum - 0.42) / 0.38, 0, 1) ** 1.4 * warm
            em = np.clip(rgb * mask[..., None] * 1.15 * 255, 0, 255).astype(np.uint8)
            save_webp(Image.fromarray(em).filter(ImageFilter.GaussianBlur(0.6)), os.path.join(OUT, 'hellrock_e.webp'), 85)

    print('sky')
    # two generated halves -> one seamless 360 degree strip (cross-faded joins)
    a = np.asarray(Image.open(os.path.join(raw, 'sky.png')).convert('RGB'), dtype=np.float64)
    b2 = np.asarray(Image.open(os.path.join(raw, 'sky2.png')).convert('RGB').resize((a.shape[1], a.shape[0]), Image.LANCZOS), dtype=np.float64)
    w, bw = a.shape[1], 160
    s = np.linspace(0.0, 1.0, bw)
    s = (s * s * (3 - 2 * s))[None, :, None]
    x1 = a[:, w - bw:] * (1 - s) + b2[:, :bw] * s
    x2 = b2[:, w - bw:] * (1 - s) + a[:, :bw] * s
    pano = np.concatenate([a[:, bw:w - bw], x1, b2[:, bw:w - bw], x2], axis=1)
    im = Image.fromarray(np.clip(pano, 0, 255).astype(np.uint8))
    tw = 4096
    im = im.resize((tw, round(im.size[1] * tw / im.size[0])), Image.LANCZOS)
    save_webp(im, os.path.join(OUT, 'sky.webp'), 80)
    print('  sky span degrees:', 360.0 * pano.shape[0] / pano.shape[1])
    print('title')
    title = Image.open(os.path.join(raw, 'title.png')).convert('RGB')
    save_webp(title, os.path.join(OUT, 'title.webp'), 84)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'raw')
