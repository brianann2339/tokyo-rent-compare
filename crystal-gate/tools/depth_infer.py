#!/usr/bin/env python3
"""照片 → 深度圖（Depth Anything V2, ONNX）。

用法:
    python3 depth_infer.py <photos_dir> <work_dir> [model.onnx]

photos_dir 內的每張 jpg/png 會依 EXIF 自動轉正，輸出到 work_dir：
    <stem>_color_full.jpg   轉正後的原圖
    <stem>_depth.npy        0..1 相對深度（1=近）
    <stem>_depth_preview.png / <stem>_check.jpg  目視檢查用

模型下載（約 100MB）：
    curl -L -o dav2_vits.onnx \
      https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx

相依套件：pip install numpy pillow onnxruntime
"""
import os, sys
import numpy as np
from PIL import Image, ImageOps
import onnxruntime as ort

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    photos_dir, work_dir = sys.argv[1], sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "dav2_vits.onnx"
    os.makedirs(work_dir, exist_ok=True)

    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    inp, out = sess.get_inputs()[0], sess.get_outputs()[0]
    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def infer(img: Image.Image) -> np.ndarray:
        w, h = img.size
        scale = 518.0 / max(w, h)
        nw = max(14, int(round(w * scale / 14)) * 14)
        nh = max(14, int(round(h * scale / 14)) * 14)
        shape = inp.shape
        if isinstance(shape[2], int) and isinstance(shape[3], int):
            nh, nw = shape[2], shape[3]
        x = np.asarray(img.resize((nw, nh), Image.LANCZOS), dtype=np.float32) / 255.0
        x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
        (d,) = sess.run([out.name], {inp.name: x})
        d = d.squeeze().astype(np.float32)
        return (d - d.min()) / (d.max() - d.min() + 1e-9)

    names = sorted(f for f in os.listdir(photos_dir)
                   if f.lower().endswith((".jpg", ".jpeg", ".png")))
    if not names:
        sys.exit(f"no images found in {photos_dir}")
    for fname in names:
        stem = os.path.splitext(fname)[0]
        img = ImageOps.exif_transpose(Image.open(os.path.join(photos_dir, fname))).convert("RGB")
        dn = infer(img)
        img.save(os.path.join(work_dir, f"{stem}_color_full.jpg"), quality=92)
        np.save(os.path.join(work_dir, f"{stem}_depth.npy"), dn)
        Image.fromarray((dn * 255).astype(np.uint8)).save(
            os.path.join(work_dir, f"{stem}_depth_preview.png"))
        th = img.copy(); th.thumbnail((420, 420))
        dth = Image.fromarray((dn * 255).astype(np.uint8)).resize(th.size).convert("RGB")
        combo = Image.new("RGB", (th.width * 2 + 8, th.height), (20, 20, 20))
        combo.paste(th, (0, 0)); combo.paste(dth, (th.width + 8, 0))
        combo.save(os.path.join(work_dir, f"{stem}_check.jpg"), quality=85)
        print(stem, img.size, "depth", dn.shape)

if __name__ == "__main__":
    main()
