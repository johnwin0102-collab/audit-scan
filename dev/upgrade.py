"""Update path: serve the old copy of the app, make a batch, then serve the new copy at the same address and tap
Update now. Checks the new version loads, the batch is kept and only the new cache remains.
usage: upgrade.py <old app folder> <new app folder>   (e.g. a git worktree of the last release, and this repo)"""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

OLD, NEW = sys.argv[1], sys.argv[2]
PORT = 8799


def serve(d):
    p = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "serve.py"), d, str(PORT)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return p


async def settle(pg):
    for _ in range(120):
        try:
            if await pg.evaluate("!!(navigator.serviceWorker && navigator.serviceWorker.controller) && document.readyState === 'complete' && !!window.__auditScan"):
                return
        except Exception:
            pass
        await pg.wait_for_timeout(500)


async def main():
    srv = serve(OLD)
    errors = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
            ctx = await b.new_context(viewport={"width": 412, "height": 915}, permissions=["camera"])
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            await pg.goto(f"http://127.0.0.1:{PORT}/")
            await settle(pg)
            await pg.wait_for_timeout(1500)
            print("old:", await pg.text_content("#verText"), "| isolated:", await pg.evaluate("self.crossOriginIsolated"))
            await pg.fill("#client", "Upgrade Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            await pg.wait_for_timeout(500)
            await pg.click("#btnCamBack")
            await pg.wait_for_function("document.getElementById('scrSetup').hidden === false")
            srv.terminate(); srv.wait()
            srv = serve(NEW)
            await pg.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
            await pg.wait_for_function("document.getElementById('updateBar').hidden === false", timeout=60000)
            print("update offered:", await pg.text_content("#btnUpdate"))
            async with pg.expect_navigation(timeout=60000):
                await pg.click("#btnUpdate")
            await settle(pg)
            await pg.wait_for_function("window.__auditScan.finder.state === 'ready' && window.__auditScan.engine.state === 'ready'", timeout=120000)
            print("new:", await pg.text_content("#verText"), "| isolated:", await pg.evaluate("self.crossOriginIsolated"),
                  "| finder:", await pg.evaluate("JSON.stringify(window.__auditScan.finder.info)"))
            print("batch kept:", await pg.evaluate("window.__auditScan.S.batch && window.__auditScan.S.batch.client"))
            print("caches:", await pg.evaluate("caches.keys()"))
            await b.close()
    finally:
        srv.terminate()
    print("page errors:", errors or "none")

asyncio.run(main())
