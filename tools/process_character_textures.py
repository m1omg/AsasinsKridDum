#!/usr/bin/env python3
"""Turn the texture written by tools/convert_character.mjs into game assets.

Usage: python3 tools/process_character_textures.py <name> [<name> ...] [--dir assets/models]

Reads <dir>/<name>.src.png, writes <dir>/<name>.webp and, for demons with
molten cracks or burning eyes, a <dir>/<name>_e.webp glow map (added to the
emissive light in the game). The hero gets a soft face light instead, so his
face stays readable under the hood. The .src.png is removed afterwards.

Requires Pillow and NumPy.
"""
import argparse
import json
import os
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

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


# characters whose face gets a fill light: name -> brightness of the glow
FACE = {'hero': 0.9}


def read_model(path):
    """Positions, normals, uvs, skin and triangles of a converted .bin model."""
    b = open(path, 'rb').read()
    hl = struct.unpack('<I', b[4:8])[0]
    header = json.loads(b[8:8 + hl])
    off = (8 + hl + 3) & ~3
    n = header['verts']

    def take(dt, count):
        nonlocal off
        arr = np.frombuffer(b, dtype=dt, count=count, offset=off)
        off = (off + arr.nbytes + 3) & ~3
        return arr
    P = take('<f4', n * 3).reshape(-1, 3)
    N = take('i1', n * 3).reshape(-1, 3) / 127
    UV = take('<u2', n * 2).reshape(-1, 2) / 65535
    J = take('u1', n * 4).reshape(-1, 4)
    W = take('u1', n * 4).reshape(-1, 4) / 255
    I = take('<u4' if header['index32'] else '<u2', header['tris'] * 3).reshape(-1, 3)
    return header, P, N, UV, J, W, I


def face_light(im, bin_path, gain):
    """Glow for the front of the head (face and beard, not the hood cloth)."""
    header, P, N, UV, J, W, I = read_model(bin_path)
    bi = {b['name']: i for i, b in enumerate(header['bones'])}
    hc = np.array(header['bones'][bi['head']]['pos'])
    s = header['dims']['height'] / 1.8
    head = (W * (J == bi['head'])).sum(1) + (W * (J == bi['neck'])).sum(1)
    front = (head > 0.5) & (N[:, 2] > 0.15) & (np.abs(P[:, 0] - hc[0]) < 0.085 * s) \
        & (P[:, 1] > hc[1] - 0.08 * s) & (P[:, 1] < hc[1] + 0.14 * s) & (P[:, 2] > hc[2] + 0.02 * s)
    size = im.size[0]
    m = Image.new('L', im.size, 0)
    d = ImageDraw.Draw(m)
    for t in I:
        if front[t].all():
            d.polygon([(UV[k, 0] * size, UV[k, 1] * im.size[1]) for k in t], fill=255)
    mask = np.asarray(m.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32) / 255
    a = np.asarray(im).astype(np.float32) / 255.0
    mx = a.max(-1)
    sat = np.where(mx > 1e-4, (mx - a.min(-1)) / np.maximum(mx, 1e-4), 0)
    cloth = np.clip((mx - 0.62) / 0.15, 0, 1) * np.clip((0.22 - sat) / 0.1, 0, 1)  # white hood lining
    glow = np.clip(a * (mask * (1 - cloth) * gain)[..., None], 0, 1)
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
        e = None
        if n in GLOW:
            # the glow map is cut from the encoded texture, exactly as the game sees it
            e = glow_map(Image.open(out).convert('RGB'), GLOW[n])
        elif n in FACE:
            e = face_light(Image.open(out).convert('RGB'), os.path.join(args.dir, n + '.bin'), FACE[n])
        if e is not None:
            eout = os.path.join(args.dir, n + '_e.webp')
            e.save(eout, 'WEBP', quality=82, method=6)
            line += f', glow {os.path.getsize(eout) // 1024} KB'
        os.remove(src)
        print(line)


if __name__ == '__main__':
    main()
