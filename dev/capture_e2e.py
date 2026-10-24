"""Capture test: run the app on a fake camera video, tap the shutter at given times (seconds into the video),
and compare each crop's corners with the truth for the frame that was captured (read from the frame's barcode).
usage: capture_e2e.py <repo> <port> <video> <t1,t2,...> [--auto]"""
import asyncio, base64, io, json, os, subprocess, sys, time, math
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright
LIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
repo, port, video = sys.argv[1], int(sys.argv[2]), sys.argv[3]
taps = [float(x) for x in sys.argv[4].split(",")]
auto = "--auto" in sys.argv
GT = json.load(open(os.path.join(LIVE, video + ".json")))
N = len(GT["frames"]); FPS = GT["fps"]; W, H = GT["w"], GT["h"]

def barcode(img):
    """Frame number from the 16-square barcode at the bottom right (12 px squares, rows H-14..H-2)."""
    a = np.asarray(img.convert("L"))
    h, w = a.shape
    n = 0
    for i in range(16):
        x0 = w - 16 * 12 + i * 12
        v = a[h - 12:h - 4, x0 + 3:x0 + 9].mean()
        if v > 128: n |= 1 << i
    return n

def qerr(s, g):
    best = 1e9
    for order in [g, [g[0], g[3], g[2], g[1]]]:
        for k in range(4):
            e = sum(math.hypot((s[i][0] - order[(i + k) % 4][0]) * W, (s[i][1] - order[(i + k) % 4][1]) * H) for i in range(4)) / 4
            best = min(best, e)
    return best / math.hypot(W, H) * 100

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
            await pg.evaluate("window.__auditScanDebug = true")
            await pg.fill("#client", "Capture Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            if not auto: await pg.click("#btnAuto")
            # the video loops; find where we are from the live trace isn't available here, so tap by wall clock
            # from the camera start and read the frame number off the captured photo's barcode
            t0 = time.time()
            for t in taps:
                while time.time() - t0 < t: await pg.wait_for_timeout(30)
                await pg.click("#btnShutter")
            await pg.wait_for_function("window.__auditScan.cam.inFlight === 0 && window.__auditScan.S.batch.pageIds.length >= %d" % len(taps), timeout=120000)
            await pg.wait_for_timeout(500)
            pages = await pg.evaluate("""async () => {
                const A = window.__auditScan; const out = [];
                for (const id of A.S.batch.pageIds) {
                    const pg = A.S.pages.get(id);
                    const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(pg.frame); });
                    out.push({ quad: pg.quad, pick: pg.pick, auto: pg.auto, cands: pg.cands || null, w: pg.w, h: pg.h, frameW: pg.frameW, frameH: pg.frameH, frame: b64 });
                }
                return out; }""")
            res = []
            for k, pgd in enumerate(pages):
                img = Image.open(io.BytesIO(base64.b64decode(pgd["frame"])))
                f = barcode(img) % N
                g = GT["frames"][f]
                err = qerr(pgd["quad"], g["q"]) if pgd["quad"] else None
                res.append({"tap": taps[k], "frame": f, "phase": g["phase"], "vis": g.get("vis", 1), "pick": pgd["pick"], "auto": pgd["auto"], "err": None if err is None else round(err, 2),
                            "out": [pgd["w"], pgd["h"]], "cands": [(c["src"], round(qerr(c["q"], g["q"]), 2), c.get("score")) for c in (pgd["cands"] or [])][:6]})
            print(json.dumps({"video": video, "pages": res, "errors": errs}, indent=1))
            await b.close()
    finally:
        srv.terminate()
asyncio.run(main())
