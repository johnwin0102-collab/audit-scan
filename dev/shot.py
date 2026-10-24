"""Screenshots of the camera screen with a fake camera video: shot.py <repo> <port> <video> <out prefix> [--path canvas] [--wait 3]"""
import asyncio, os, subprocess, sys, time, json, argparse
from playwright.async_api import async_playwright
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
ap = argparse.ArgumentParser(); ap.add_argument("repo"); ap.add_argument("port", type=int); ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--path", default=""); ap.add_argument("--wait", type=float, default=3); ap.add_argument("--n", type=int, default=3)
ap.add_argument("--auto", action="store_true"); ap.add_argument("--no-sync", action="store_true")
A = ap.parse_args()
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(A.port), "--bind", "127.0.0.1"], cwd=A.repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errs = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                              f"--use-file-for-fake-video-capture={os.path.join(HERE, A.video + '.y4m')}"])
            ctx = await b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, permissions=["camera"])
            pg = await ctx.new_page()
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
            if A.no_sync: await pg.add_init_script("window.__auditScanNoSync = true")
            await pg.goto(f"http://127.0.0.1:{A.port}/")
            for _ in range(120):
                try:
                    if await pg.evaluate("!!(navigator.serviceWorker && navigator.serviceWorker.controller) && document.readyState === 'complete' && !!window.__auditScan"): break
                except Exception: pass
                await pg.wait_for_timeout(500)
            await pg.wait_for_timeout(800)
            await pg.wait_for_function("window.__auditScan.engine.state === 'ready' && window.__auditScan.finder.state === 'ready'", timeout=120000)
            if A.path: await pg.evaluate("(p) => { window.__auditScanForcePath = p; }", A.path)
            await pg.fill("#client", "Live Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            if not A.auto: await pg.click("#btnAuto")
            for i in range(A.n):
                await pg.wait_for_timeout(int(A.wait * 1000))
                info = await pg.evaluate("(() => { const A = window.__auditScan; return { synced: A.cam.synced, viewing: A.cam.viewing, way: A.stats.way, ver: document.getElementById('verText').textContent, liveHz: A.stats.liveHz, liveMs: A.stats.liveMs, view: A.tracker.view, cls: document.getElementById('scrCamera').className, vop: getComputedStyle(document.getElementById('video')).opacity, pv: getComputedStyle(document.getElementById('preview')).display, cw: document.getElementById('preview').width, ch: document.getElementById('preview').height }; })()")
                print(i, json.dumps(info))
                await pg.screenshot(path=f"{A.out}_{i}.png")
            await b.close()
    finally:
        srv.terminate()
    print("errors:", errs[:5] or "none")
asyncio.run(main())
