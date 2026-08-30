# crystal-gate — 照片 → 雷射點雲／水晶內雕 3D 網頁

把一張普通照片重建成有 3D 透視的點雲場景，做出兩種效果：

- **掃描飛行**：黑底白點的 LiDAR 掃描感，鏡頭在場景中緩慢飄移穿梭（自動運鏡 + 可手動拖曳）。
- **水晶方塊**：點雲以浮雕方式「內雕」在玻璃磚裡，放在 LED 底座上緩緩擺盪——水晶雷射雕刻的樣子。

成品是**單一 HTML 檔**，照片與深度資料以 data URI 內嵌，開檔即用、可直接發佈。

## 原理

1. **單眼深度估計**：用 [Depth Anything V2 (vits)](https://github.com/fabio-sim/Depth-Anything-ONNX) 的 ONNX 模型從單張照片推出相對深度圖（CPU 就能跑）。
2. **打包**：彩色圖壓成 JPEG；深度以 16-bit 精度塞進 PNG 的 R/G 兩個通道，B 通道放「雕刻亮度」（局部對比強化 + 距離衰減 + 天空壓暗），alpha 固定 255 避免 canvas premultiply 失真。
3. **網頁重建點雲**（three.js r128）：
   - 掃描模式：以假設視角（直幅 66°、橫幅 48°）做透視反投影，`z = 1/(1/z_far + (1/z_near − 1/z_far)·d)`，還原出會隨鏡頭產生視差的錐台形點雲。
   - 水晶模式：改用正交浮雕投影（照片平面 + 深度做浮雕），跟真實水晶內雕的打點方式一致，再套上 Fresnel 玻璃殼、稜線、底座光暈。
   - 點徑跟取樣間距連動，切換疏／中／密時整體觀感不變；自訂 shader 做柔邊圓點、閃爍、距離霧、逐層蝕刻的進場掃描線。

## 重現步驟

```bash
pip install numpy pillow onnxruntime
curl -L -o dav2_vits.onnx \
  https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx

# 1) 把你的照片放進 photos/，算深度
python3 tools/depth_infer.py photos work dav2_vits.onnx
#    （work/*_check.jpg 可目視確認深度品質）

# 1.5)（可選）把照片轉成黑底白線刮畫風，沿用同一張深度圖：
#      輸出 sk_xxx 之後在 labels.json 標 {"lineart": true}
python3 tools/sketchify.py work gate_front sk_front

# 2) 打包成網頁資料（labels.json 可選；值可為字串或
#    {"label": "...", "src": "HUD 字樣", "lineart": true}，鍵的順序決定場景順序）
python3 tools/pack_scenes.py work scenes_data.js labels.json

# 3) 組出單一 HTML
python3 tools/build.py index_template.html scenes_data.js dist
#    dist/index.html 用瀏覽器打開即可

# （可選）錄成影片：需要一份內嵌 three.js 的離線版
npm pack three@0.128.0 && tar -xzf three-0.128.0.tgz package/build/three.min.js
python3 tools/build.py index_template.html scenes_data.js dist package/build/three.min.js
pip install playwright imageio-ffmpeg
python3 tools/record_video.py dist/index_local.html out.mp4 \
  --segments "gate_front:scan:laser:6,gate_person:scan:laser:5,gate_close:crystal:laser:6"
```

頁面網址參數：`?scene=<id>&mode=scan|crystal&density=<點數>`；`?record=1` 進入錄影模式（隱藏 UI、時鐘由 `window.__frame(t)` 驅動，逐格決定性渲染）。

## 為什麼 repo 裡沒有照片和成品？

這個 repo 是公開的；原始照片（含人物）與內嵌照片資料的 `dist/`、影片都刻意不進版控（見 `.gitignore`），只留可重現的工具鏈與頁面模板。
