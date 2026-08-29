#!/usr/bin/env python3
"""depth_infer.py 的輸出 → scenes_data.js（網頁內嵌資料）。

用法:
    python3 pack_scenes.py <work_dir> <out_scenes_data.js> [labels.json]

每個場景打包成兩個 data URI：
  - 彩色 JPEG（長邊 1200px）
  - 資料 PNG：R/G = 16-bit 深度（高/低位元組）、B = 雕刻亮度
    雕刻亮度 = 局部對比強化後的明度 × 距離衰減，天空另行壓暗，
    讓單色「雷射」模式有內雕的顆粒層次。alpha 固定 255，
    canvas 讀回時才不會因 premultiply 失真。

labels.json（可選）：{"<stem>": "顯示名稱", ...}；沒給就用檔名。
相依套件：pip install numpy pillow
"""
import os, io, sys, json, base64
import numpy as np
from PIL import Image, ImageFilter

def b64(data, mime):
    return f"data:{mime};base64," + base64.b64encode(data).decode()

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    work_dir, out_js = sys.argv[1], sys.argv[2]
    labels = {}
    if len(sys.argv) > 3:
        labels = json.load(open(sys.argv[3]))

    stems = sorted(f[:-len("_depth.npy")] for f in os.listdir(work_dir) if f.endswith("_depth.npy"))
    if not stems:
        sys.exit(f"no *_depth.npy in {work_dir}")
    out, total = [], 0
    for stem in stems:
        img = Image.open(os.path.join(work_dir, f"{stem}_color_full.jpg"))
        w, h = img.size
        dn = np.load(os.path.join(work_dir, f"{stem}_depth.npy"))
        dh, dw = dn.shape

        scale = 1200 / max(w, h)
        cimg = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        buf = io.BytesIO(); cimg.save(buf, "JPEG", quality=68)
        color_uri = b64(buf.getvalue(), "image/jpeg")

        lum_img = img.convert("L").resize((dw, dh), Image.LANCZOS)
        L = np.asarray(lum_img, dtype=np.float32) / 255.0
        Lb = np.asarray(lum_img.filter(ImageFilter.GaussianBlur(6)), dtype=np.float32) / 255.0
        L2 = np.clip(0.5 + (L - Lb) * 1.6 + (L - 0.5) * 0.85, 0, 1) ** 0.9
        L2 *= 0.45 + 0.55 * (dn ** 0.8)
        sky = ((dn < 0.015) & (L > 0.75)).astype(np.float32)
        sky = np.asarray(Image.fromarray((sky * 255).astype(np.uint8))
                         .filter(ImageFilter.GaussianBlur(2)), np.float32) / 255.0
        L2 *= 1.0 - 0.9 * sky
        eng = (np.clip(L2, 0, 1) * 255).astype(np.uint8)

        d16 = (np.clip(dn, 0, 1) * 65535).astype(np.uint16)
        rgb = np.zeros((dh, dw, 3), dtype=np.uint8)
        rgb[..., 0] = (d16 >> 8).astype(np.uint8)
        rgb[..., 1] = (d16 & 255).astype(np.uint8)
        rgb[..., 2] = eng
        buf = io.BytesIO(); Image.fromarray(rgb).save(buf, "PNG", optimize=True)
        depth_uri = b64(buf.getvalue(), "image/png")

        total += len(color_uri) + len(depth_uri)
        print(f"{stem}: color {len(color_uri)//1024}KB + depth {len(depth_uri)//1024}KB")
        out.append({"id": stem, "label": labels.get(stem, stem), "aspect": round(w / h, 4),
                    "dw": dw, "dh": dh, "color": color_uri, "depth": depth_uri})

    with open(out_js, "w") as f:
        f.write("window.SCENES = " + json.dumps(out, ensure_ascii=False) + ";\n")
    print(f"total embedded: {total/1024/1024:.2f} MB -> {out_js}")

if __name__ == "__main__":
    main()
