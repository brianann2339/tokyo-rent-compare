#!/usr/bin/env python3
"""照片 → 黑底白線刮畫風（供 lineart 場景使用），深度沿用照片的深度圖。

用法:
    python3 sketchify.py <work_dir> <src_stem> <dst_stem> [--strength 1.0]

讀 <work_dir>/<src_stem>_color_full.jpg 與 <src_stem>_depth.npy，
輸出 <dst_stem>_color_full.jpg（白線刮畫）與 <dst_stem>_depth.npy（原深度複製），
之後照常餵給 pack_scenes.py 並在 labels.json 標 lineart。

線條 = 多尺度 DoG 邊緣（結構輪廓）+ 高通紋理（石縫、枝葉的碎筆觸），
再依深度稍微壓暗遠景，調成溫暖的紙白色。
相依：pip install numpy pillow
"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter

def gauss(a, sigma):
    r = max(1, int(sigma * 3))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma)); k /= k.sum()
    p = np.pad(a, ((r, r), (r, r)), mode="edge")
    p = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, p)
    p = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, p)
    return p.astype(np.float32)

def sstep(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)
    return t * t * (3 - 2 * t)

def sketchify(L, strength=1.0, ink=0.22):
    """L: float32 luminance 0..1. Returns 0..1 white-line image.

    多尺度 DoG 邊緣強度 -> 「相對顯著度」= 強度 / (鄰域平均 + floor)：
    陰影中的結構線相對鄰域突出所以入選；樹葉區大家都強，只有峰值入選，
    自然形成疏點；平坦天空整片低於 floor，不出雜訊。
    ink 越小 floor 越高（整體越省墨）。
    """
    m = np.zeros_like(L)
    for sigma, w in [(0.8, 1.0), (1.8, 0.9)]:
        d = np.abs(gauss(L, sigma) - gauss(L, sigma * 1.6)) * w
        m = np.maximum(m, d)
    floor = 0.005 * (0.22 / max(ink, 1e-6))
    sal = m / (gauss(m, 10.0) + floor)
    lines = sstep(1.10 * strength, 2.05 * strength, sal)
    lines *= 0.78 + 0.22 * sstep(0.008, 0.05, m)   # stroke-weight from absolute strength
    return np.clip(lines, 0, 1) ** 0.9

def main():
    if len(sys.argv) < 4:
        print(__doc__); sys.exit(1)
    work, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    strength = float(sys.argv[sys.argv.index("--strength") + 1]) if "--strength" in sys.argv else 1.0
    ink = float(sys.argv[sys.argv.index("--ink") + 1]) if "--ink" in sys.argv else 0.22

    img = Image.open(os.path.join(work, f"{src}_color_full.jpg")).convert("L")
    w, h = img.size
    scale = 1600 / max(w, h)
    ww, wh = int(w * scale), int(h * scale)
    L = np.asarray(img.resize((ww, wh), Image.LANCZOS), np.float32) / 255.0
    S = sketchify(L, strength, ink)

    dn = np.load(os.path.join(work, f"{src}_depth.npy"))
    dnb = np.asarray(Image.fromarray((dn * 255).astype(np.uint8)).resize((ww, wh), Image.BILINEAR), np.float32) / 255.0
    S *= 0.55 + 0.45 * (dnb ** 0.7)                      # farther lines fade a bit

    warm = np.stack([S * 0.93, S * 0.88, S * 0.79], axis=-1)   # 紙白微暖
    out = Image.fromarray((np.clip(warm, 0, 1) * 255).astype(np.uint8))
    out.save(os.path.join(work, f"{dst}_color_full.jpg"), quality=88)
    np.save(os.path.join(work, f"{dst}_depth.npy"), dn)
    print(dst, out.size, f"coverage {float((S > 0.05).mean()):.2%}")

if __name__ == "__main__":
    main()
