"""Editor test: make a batch of three pages on a fake camera video, open the first page, swipe left and right on it
(touch), and check the page shown changes (title and picture); then check Move moves the page in the batch.
usage: editor_swipe.py <app folder> <port> [video]"""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

LIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
repo, port = sys.argv[1], int(sys.argv[2])
video = sys.argv[3] if len(sys.argv) > 3 else "wood"


async def swipe(pg, dx):
    box = await pg.locator(".ed-stage").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    cdp = await pg.context.new_cdp_session(pg)
    pts = lambda px: [{"x": px, "y": y}]
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(x)})
    for k in range(1, 9):
        await cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(x + dx * k / 8)})
        await pg.wait_for_timeout(16)
    await cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    await pg.wait_for_timeout(400)


async def state(pg):
    return await pg.evaluate("""() => ({ title: document.getElementById('edTitle').textContent, id: window.__auditScan.S.editor && window.__auditScan.S.editor.id,
        ids: window.__auditScan.S.batch.pageIds.slice(), src: document.getElementById('edImg').src })""")


async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=repo, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errs, ok = [], True
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                              f"--use-file-for-fake-video-capture={os.path.join(LIVE, video + '.y4m')}"])
            ctx = await b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, permissions=["camera"], has_touch=True, is_mobile=True)
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
            await pg.goto(f"http://127.0.0.1:{port}/")
            await pg.wait_for_function("!!window.__auditScan && window.__auditScan.engine.state === 'ready' && window.__auditScan.finder.state === 'ready'", timeout=120000)
            await pg.fill("#client", "Swipe Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            await pg.click("#btnAuto")
            for t in (2, 4, 6):
                await pg.wait_for_timeout(2000)
                await pg.click("#btnShutter")
            await pg.wait_for_function("window.__auditScan.cam.inFlight === 0 && window.__auditScan.S.batch.pageIds.length >= 3", timeout=120000)
            await pg.click("#btnDone")
            await pg.wait_for_function("document.getElementById('scrReview').hidden === false")
            await pg.locator("#grid li").first.click()
            await pg.wait_for_function("document.getElementById('scrEditor').hidden === false")
            s0 = await state(pg)
            await swipe(pg, -160)
            s1 = await state(pg)
            await swipe(pg, -160)
            s2 = await state(pg)
            await swipe(pg, 160)
            s3 = await state(pg)
            print("start ", s0["title"]); print("left  ", s1["title"]); print("left  ", s2["title"]); print("right ", s3["title"])
            ok &= s1["id"] == s0["ids"][1] and s2["id"] == s0["ids"][2] and s3["id"] == s0["ids"][1]
            ok &= s1["src"] != s0["src"] and s2["src"] != s1["src"]
            # Move: the page shown (now the 2nd) goes one place earlier; it stays on screen as page 1
            await pg.click("#btnMoveUp")
            await pg.wait_for_timeout(300)
            s4 = await state(pg)
            print("move  ", s4["title"], "order changed:", s4["ids"] != s3["ids"])
            ok &= s4["id"] == s3["id"] and s4["ids"][0] == s3["id"] and s4["title"].startswith("Page 1")
            await b.close()
    finally:
        srv.terminate()
    print("errors:", errs or "none")
    print("PASS" if ok and not errs else "FAIL")


asyncio.run(main())
