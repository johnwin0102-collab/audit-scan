"""Auto-capture check: open the camera on a fake video with Auto on and count the pages captured.
usage: autocap.py <repo> <port> <video> [seconds]"""
import asyncio, os, subprocess, sys, time, json
from playwright.async_api import async_playwright
LIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
repo, port, video = sys.argv[1], int(sys.argv[2]), sys.argv[3]
secs = float(sys.argv[4]) if len(sys.argv) > 4 else 12
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errs = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                              f"--use-file-for-fake-video-capture={os.path.join(LIVE, video + '.y4m')}"])
            ctx = await b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, permissions=["camera"])
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
            await pg.goto(f"http://127.0.0.1:{port}/")
            for _ in range(120):
                try:
                    if await pg.evaluate("!!(navigator.serviceWorker && navigator.serviceWorker.controller) && document.readyState === 'complete' && !!window.__auditScan"): break
                except Exception: pass
                await pg.wait_for_timeout(500)
            await pg.wait_for_function("window.__auditScan.engine.state === 'ready' && window.__auditScan.finder.state === 'ready'", timeout=120000)
            await pg.fill("#client", "Auto Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            hints = []
            t0 = time.time()
            while time.time() - t0 < secs:
                h = await pg.text_content("#hint")
                if not hints or hints[-1] != h: hints.append(h)
                await pg.wait_for_timeout(250)
            n = await pg.evaluate("window.__auditScan.S.batch.pageIds.length")
            res = await pg.evaluate("window.__auditScan.cam.res")
            print(json.dumps({"video": video, "pages": n, "camera": res, "hints": hints, "errors": errs}))
            await b.close()
    finally:
        srv.terminate()
asyncio.run(main())
