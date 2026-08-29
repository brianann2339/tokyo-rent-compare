#!/usr/bin/env python3
"""用無頭瀏覽器逐格渲染點雲頁面，輸出 MP4 影片。

用法:
    python3 record_video.py <dist/index_local.html> <out.mp4> \
        [--segments "scene:mode:color:secs,scene:mode:color:secs,..."]

頁面以 ?record=1 開啟：UI 隱藏、動畫時鐘改由 window.__frame(t) 驅動，
所以每一格都是決定性的。段落之間用 ffmpeg xfade 淡接 0.5 秒。

相依：pip install playwright imageio-ffmpeg（瀏覽器用系統 chromium，
CHROMIUM 環境變數可指定執行檔路徑）。
"""
import asyncio, os, shutil, subprocess, sys, tempfile, time

FPS = 30
W, H = 1920, 1080

def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()

async def render(html, out_mp4, segments):
    from playwright.async_api import async_playwright
    FF = ffmpeg_exe()
    tmp = tempfile.mkdtemp(prefix="pcrec_")
    seg_files = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            executable_path=os.environ.get("CHROMIUM") or None,
            args=["--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-swiftshader"])
        page = await browser.new_page(viewport={"width": W, "height": H})
        await page.goto(f"file://{os.path.abspath(html)}?record=1&density=300000", wait_until="load")
        await page.wait_for_function("window.__ready === true", timeout=120000)
        for si, (scene, mode, color, secs) in enumerate(segments):
            fdir = os.path.join(tmp, f"s{si}")
            os.makedirs(fdir)
            await page.evaluate(f"__setup('{scene}','{mode}','{color}')")
            await page.wait_for_timeout(250)
            n = int(secs * FPS)
            t0 = time.time()
            for i in range(n):
                await page.evaluate(f"__frame({i / FPS + 0.0001})")
                await page.screenshot(path=os.path.join(fdir, f"{i:05d}.jpg"), quality=92, type="jpeg")
            print(f"seg{si} {scene}/{mode}: {n} frames, {(time.time()-t0)/n*1000:.0f} ms/frame", flush=True)
            seg = os.path.join(tmp, f"s{si}.mp4")
            subprocess.run([FF, "-y", "-framerate", str(FPS), "-i", os.path.join(fdir, "%05d.jpg"),
                            "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", seg],
                           check=True, capture_output=True)
            seg_files.append((seg, secs))
        await browser.close()

    if len(seg_files) == 1:
        shutil.copy(seg_files[0][0], out_mp4)
    else:
        args, flt, acc = [], "", None
        for f, _ in seg_files:
            args += ["-i", f]
        offset = 0.0
        for i, (_, secs) in enumerate(seg_files):
            if i == 0:
                offset = secs - 0.5; acc = "[0]"
                continue
            outl = f"[v{i}]"
            flt += f"{acc}[{i}]xfade=transition=fade:duration=0.5:offset={offset}{outl};"
            acc = outl
            offset += secs - 0.5
        subprocess.run([ffmpeg_exe(), "-y", *args, "-filter_complex", flt.rstrip(";"),
                        "-map", acc, "-c:v", "libx264", "-crf", "20", "-preset", "medium",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_mp4],
                       check=True, capture_output=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(out_mp4, f"{os.path.getsize(out_mp4)/1e6:.1f} MB")

def main():
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    html, out = sys.argv[1], sys.argv[2]
    segs = []
    if "--segments" in sys.argv:
        raw = sys.argv[sys.argv.index("--segments") + 1]
        for part in raw.split(","):
            scene, mode, color, secs = part.split(":")
            segs.append((scene, mode, color, float(secs)))
    else:
        segs = [("gate_front", "scan", "laser", 6.0)]
    asyncio.run(render(html, out, segs))

if __name__ == "__main__":
    main()
