#!/usr/bin/env python3
"""Turn the texture written by tools/convert_character.mjs into game assets.

Usage: python3 tools/process_character_textures.py <name> [<name> ...] [--dir assets/models]

Reads <dir>/<name>.src.png, writes <dir>/<name>.webp and, for demons with
molten cracks or burning eyes, a <dir>/<name>_e.webp glow map (added to the
emissive light in the game). The .src.png is removed afterwards.

Requires Pillow and NumPy.
"""
import argparse
import os

import numpy as np
from PIL import Image, ImageFilter

# name: (hue low, hue high, saturation min, value min, local contrast min)
GLOW = {
    'brute': (8, 48, 0.5, 0.3, 0.05),
    'hound': (8, 48, 0.5, 0.3, 0.05),
    'boss': (12, 50, 0.55, 0.45, 0.06),
    'gazer': (15, 50, 0.6, 0.5, 0.0),
}


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def glow_map(im, cfg):
    """Bright, saturated orange/yellow texels that stand out from their surroundings."""
    a = np.asarray(im).astype(np.float32) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1)
    mn = a.min(-1)
    v = mx
    s = np.where(mx > 1e-4, (mx - mn) / np.maximum(mx, 1e-4), 0)
    d = np.maximum(mx - mn, 1e-4)
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    blur = np.asarray(Image.fromarray((v * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255
    lo, hi, smin, vmin, cmin = cfg
    mask = smoothstep(lo - 4, lo + 4, h) * (1 - smoothstep(hi - 6, hi + 6, h)) \
        * smoothstep(smin - 0.1, smin + 0.1, s) * smoothstep(vmin - 0.08, vmin + 0.1, v)
    if cmin > 0:
        mask *= smoothstep(cmin * 0.4, cmin * 1.6, v - blur)
    glow = np.clip(a * mask[..., None] * 1.6, 0, 1)
    return Image.fromarray((glow * 255).astype(np.uint8)).resize((512, 512), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('names', nargs='+')
    ap.add_argument('--dir', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'models'))
    args = ap.parse_args()
    for n in args.names:
        src = os.path.join(args.dir, n + '.src.png')
        out = os.path.join(args.dir, n + '.webp')
        Image.open(src).convert('RGB').save(out, 'WEBP', quality=86, method=6)
        line = f'{n}: {os.path.getsize(out) // 1024} KB'
        if n in GLOW:
            # the glow map is cut from the encoded texture, exactly as the game sees it
            e = glow_map(Image.open(out).convert('RGB'), GLOW[n])
            eout = os.path.join(args.dir, n + '_e.webp')
            e.save(eout, 'WEBP', quality=82, method=6)
            line += f', glow {os.path.getsize(eout) // 1024} KB'
        os.remove(src)
        print(line)


if __name__ == '__main__':
    main()
