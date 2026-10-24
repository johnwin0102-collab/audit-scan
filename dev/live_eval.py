"""How well does the live outline sit on the page? Plays a synthetic camera video into the app and compares
the outline on screen with the true page corners of the camera frame on screen at that moment.

usage: live_eval.py <repo> <port> <video name> [--rate R] [--ml-ms M] [--secs S] [--tag T]
  --rate   CPU slow-down for the page's main thread (DevTools throttling; workers are not slowed by it)
  --ml-ms  pad each AI look to at least M ms (phone-speed AI)
"""
import argparse, asyncio, json, math, os, subprocess, sys, time
import numpy as np
from playwright.async_api import async_playwright

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
ap = argparse.ArgumentParser()
ap.add_argument("repo"); ap.add_argument("port", type=int); ap.add_argument("video")
ap.add_argument("--rate", type=float, default=1); ap.add_argument("--ml-ms", type=float, default=0)
ap.add_argument("--live-ms", type=float, default=0)   # pad each live-outline frame to at least this long
ap.add_argument("--secs", type=float, default=0); ap.add_argument("--tag", default="")
ap.add_argument("--save", default="")
ap.add_argument("--tune", default="")          # JSON merged into window.__auditScan.TUNE
ap.add_argument("--trace", action="store_true") # keep the live worker's per-frame trace (saved with --save)
ap.add_argument("--path", default="")           # force how frames reach the live worker: frame | canvas
ap.add_argument("--no-ai", action="store_true") # the AI model doesn't download (classical finder only)
ap.add_argument("--ai-bias", type=float, default=0)     # make the AI less exact: steady corner offset (% of frame)
ap.add_argument("--ai-noise", type=float, default=0)    # ... scatter from look to look (%)
ap.add_argument("--ai-outlier", type=float, default=0)  # ... chance of a wild answer
ap.add_argument("--no-sync", action="store_true")
ap.add_argument("--read", default="")           # how the live worker reads VideoFrames: copy | draw (default: its own pick)       # the video element shows the camera, the outline drawn over it (1.3)
A = ap.parse_args()
GT = json.load(open(os.path.join(HERE, A.video + ".json")))
N, FPS, W, H = len(GT["frames"]), GT["fps"], GT["w"], GT["h"]
DIAG = math.hypot(W, H)
SECS = A.secs or 2 * N / FPS + 1.5

INIT = r"""
(() => {
  // samples go into one preallocated array (20 numbers each) so recording doesn't make garbage
  const L = window.__lv = { buf: new Float64Array(21 * 4000), n: 0, long: 0, longN: 0, cur: null, rec: false };
  const hook = () => {
    const v = document.getElementById('video');
    if (!v || !v.requestVideoFrameCallback) { setTimeout(hook, 30); return; }
    // every 10th frame, read the frame number printed in the frame's corner, to tie camera timestamps to frames
    const c = document.createElement('canvas'); c.width = 192; c.height = 12;
    const cx = c.getContext('2d', { willReadFrequently: true });
    L.cal = []; let k = 0;
    const cb = (now, m) => {
      L.cur = m.mediaTime;
      if (L.rec && (k++ % 10) === 0 && v.videoWidth) {
        cx.drawImage(v, v.videoWidth - 192, v.videoHeight - 14, 192, 12, 0, 0, 192, 12);
        const d = cx.getImageData(0, 0, 192, 12).data;
        let n = 0;
        for (let i = 0; i < 16; i++) if (d[(6 * 192 + i * 12 + 6) * 4] > 128) n |= 1 << i;
        L.cal.push([m.mediaTime, n]);
      }
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  };
  hook();
  const tick = () => {
    const A = window.__auditScan;
    if (A && A.cam && L.rec && L.n < 4000) {
      // (when the worker draws the view, the outline on screen is the one it found in the frame it drew last)
      const vw = !!A.cam.viewing, mo = A.cam.motion, s = A.cam.shown, raw = vw ? (mo ? mo.q : null) : A.cam.lastQuad, b = L.buf, o = 21 * L.n++;
      b[o] = performance.now(); b[o + 1] = L.cur === null ? -1 : L.cur;
      for (let i = 0; i < 4; i++) {
        b[o + 2 + 2 * i] = s ? s[i][0] : NaN; b[o + 3 + 2 * i] = s ? s[i][1] : NaN;
        b[o + 10 + 2 * i] = raw ? raw[i][0] : NaN; b[o + 11 + 2 * i] = raw ? raw[i][1] : NaN;
      }
      b[o + 18] = mo && mo.f !== undefined ? mo.f : -1; b[o + 19] = A.live ? A.live.frame : -1; b[o + 20] = vw ? 1 : 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (L.rec) { L.long += e.duration; L.longN++; } }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
})();
"""

SLOW = """([ms, live, trace, fuzz, read]) => {
  const A = window.__auditScan;
  if (A.debugSlow) { A.debugSlow(ms, live, trace, fuzz, read); return 'hook'; }
  const f = A.finder, c = f.call.bind(f);
  f.call = (type, ...a) => {
    if (type !== 'detect') return c(type, ...a);
    const t0 = performance.now();
    return c(type, ...a).then((r) => new Promise((res) => setTimeout(() => res(r), Math.max(0, ms - (performance.now() - t0)))));
  };
  return 'wrap';
}"""


def aligned(s, g):
    """g's corners reordered to best match s (both normalised); returns px arrays (S, G)."""
    S = np.array(s) * [W, H]; G = np.array(g) * [W, H]
    best, bg = 1e9, G
    for order in (G, G[::-1]):
        for k in range(4):
            r = np.roll(order, k, 0)
            e = np.linalg.norm(S - r, axis=1).mean()
            if e < best: best, bg = e, r
    return S, bg


def qerr(s, g):
    """Mean corner distance, % of the frame diagonal, best corner correspondence."""
    S = np.array(s) * [W, H]; G = np.array(g) * [W, H]
    best = 1e9
    for order in (G, G[::-1]):
        for k in range(4):
            best = min(best, np.linalg.norm(S - np.roll(order, k, 0), axis=1).mean())
    return best / DIAG * 100


async def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(A.port), "--bind", "127.0.0.1"], cwd=A.repo,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errors = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                              f"--use-file-for-fake-video-capture={os.path.join(HERE, A.video + '.y4m')}"])
            ctx = await b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, permissions=["camera"])
            pg = await ctx.new_page()
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            await pg.add_init_script(INIT)
            if A.no_sync: await pg.add_init_script("window.__auditScanNoSync = true")
            await pg.goto(f"http://127.0.0.1:{A.port}/")
            for _ in range(120):
                try:
                    if await pg.evaluate("!!(navigator.serviceWorker && navigator.serviceWorker.controller) && document.readyState === 'complete' && !!window.__auditScan"): break
                except Exception: pass
                await pg.wait_for_timeout(500)
            await pg.wait_for_timeout(1000)
            await pg.wait_for_function("window.__auditScan.engine.state === 'ready' && window.__auditScan.finder.state === 'ready'", timeout=120000)
            if A.no_ai:
                await pg.evaluate("window.__auditScan.finder.fail(new Error('test: no AI'))")
            fz = {"bias": A.ai_bias, "noise": A.ai_noise, "outlier": A.ai_outlier} if (A.ai_bias or A.ai_noise or A.ai_outlier) else None
            if A.ml_ms or A.live_ms or A.trace or fz or A.read: print("slow AI:", await pg.evaluate(SLOW, [A.ml_ms, A.live_ms, A.trace, fz, A.read]))
            if A.tune:
                await pg.evaluate("(t) => { const T = window.__auditScan.TUNE; if (!T) return; if (t.euro) Object.assign(T.euro, t.euro); if ('showMs' in t) T.showMs = t.showMs; if ('lead' in t) T.lead = t.lead; }", json.loads(A.tune))
            if A.rate != 1:
                cdp = await ctx.new_cdp_session(pg)
                await cdp.send("Emulation.setCPUThrottlingRate", {"rate": A.rate})
            if A.path: await pg.evaluate("(p) => { window.__auditScanForcePath = p; }", A.path)
            await pg.fill("#client", "Live Test Sdn Bhd")
            await pg.click("#btnStart")
            await pg.wait_for_function("document.getElementById('scrCamera').hidden === false")
            await pg.click("#btnAuto")       # manual mode: no captures while measuring
            await pg.evaluate("window.__lv.rec = true")
            await pg.wait_for_timeout(int(SECS * 1000))
            await pg.evaluate("window.__lv.rec = false")
            L = await pg.evaluate("(() => { const L = window.__lv; return { flat: Array.from(L.buf.subarray(0, 21 * L.n)), long: L.long, longN: L.longN, cal: L.cal }; })()")
            fl = L["flat"]
            L["samples"] = []
            for k in range(0, len(fl), 21):
                r = fl[k:k + 21]
                sh = None if r[2] != r[2] else [[r[2 + 2 * i], r[3 + 2 * i]] for i in range(4)]
                rw = None if r[10] != r[10] else [[r[10 + 2 * i], r[11 + 2 * i]] for i in range(4)]
                L["samples"].append([r[0], r[1], sh, rw, int(r[18]), int(r[19]), int(r[20])])
            stats = await pg.evaluate("(() => { const s = window.__auditScan.stats; return JSON.parse(JSON.stringify(s)); })()")
            trace = await pg.evaluate("(window.__auditScan.tracker && window.__auditScan.tracker.trace) || null")
            synced = await pg.evaluate("!!window.__auditScan.cam.viewing")
            await b.close()
    finally:
        server.terminate()
    samples = L["samples"]
    t_start = samples[0][0]
    # printed frame numbers, unwrapped into a running count across passes through the file
    cal = sorted(L["cal"])
    cal_t, cal_n, base, prev = [], [], 0, None
    for mt, n in cal:
        if prev is not None and n < prev - N // 2: base += N
        prev = n
        cal_t.append(mt); cal_n.append(n + base)
    cal_t = np.array(cal_t)
    # When the worker draws the camera view, what's on screen is a frame together with the outline found in
    # it: compare that outline with that frame (camera frame number -> file frame from the other samples).
    pfmap = {}
    if any(x[6] for x in samples):
        for t, mt, s, raw, rf, lf, vw in samples:
            if mt < 0: continue
            j = int(np.searchsorted(cal_t, mt))
            cands = [x for x in (j - 1, j) if 0 <= x < len(cal_t)]
            if not cands: continue
            c = min(cands, key=lambda x: abs(cal_t[x] - mt))
            pfmap[lf] = cal_n[c] + int(round((mt - cal_t[c]) * FPS))
        print("view drawn by the worker (%.0f%% of samples): comparing each outline with the frame it was drawn on" % (100 * np.mean([x[6] for x in samples])))
    # Better still: each traced frame's own timestamp says exactly which frame of the file it was.
    from_ts = bool(synced and trace and all(e.get("ts") is not None for e in trace[:50]))
    if from_ts:
        print("frames identified by their timestamps (%d traced frames)" % len(trace))
        samples = [[e["t"], e["ts"] / 1e6, e["q"], e["q"], e["cf"], e["cf"], 2] for e in trace]
    rows = []
    for t, mt, s, raw, rf, lf, vw in samples:
        if vw == 2:
            if mt < 0: continue
            j = int(np.searchsorted(cal_t, mt))
            cands = [x for x in (j - 1, j) if 0 <= x < len(cal_t)]
            if not cands: continue
            c = min(cands, key=lambda x: abs(cal_t[x] - mt))
            tot = cal_n[c] + int(round((mt - cal_t[c]) * FPS))
        elif vw:
            if rf not in pfmap: continue
            s, tot = raw, pfmap[rf]
        else:
            if mt < 0: continue
            # Frame number: from the nearest frame whose printed number was read, plus the frames since then.
            j = int(np.searchsorted(cal_t, mt))
            cands = [x for x in (j - 1, j) if 0 <= x < len(cal_t)]
            if not cands: continue
            c = min(cands, key=lambda x: abs(cal_t[x] - mt))
            tot = cal_n[c] + int(round((mt - cal_t[c]) * FPS))
        loop, idx = tot // N, tot % N
        g = GT["frames"][idx]
        inview = all(-0.002 <= x <= 1.002 and -0.002 <= y <= 1.002 for x, y in g["q"])
        lag = [None if s is None else qerr(s, GT["frames"][(idx - k) % N]["q"]) for k in (1, 2)]
        vis = g.get("vis", 1.0 if inview else 0.5)
        rows.append((t - t_start, loop, idx, g["phase"], inview, None if s is None else qerr(s, g["q"]), s, lag, vis, raw, rf, lf))
    if A.save:
        json.dump({"rows": [r[:7] + r[9:12] for r in rows], "stats": stats, "trace": trace, "t_start": t_start, "samples": samples}, open(A.save, "w"))
    print(f"== {A.video} {A.tag} rate={A.rate} ml>={A.ml_ms}ms  looks/s={stats.get('lookHz', 0):.1f} ml={stats.get('mlMs', 0):.1f}ms ai/s={stats.get('aiHz', 0) or 0:.1f} live={stats.get('liveMs', 0) or 0:.1f}ms grab={stats.get('grabMs', 0):.1f}ms rt={stats.get('rtMs', 0):.1f}ms way={stats.get('way')}  longtasks={L['longN']} ({L['long'] / 1000:.1f}s)")
    summary = {"video": A.video, "tag": A.tag, "stats": stats, "loops": {}}
    for loop in sorted(set(r[1] for r in rows)):
        R = [r for r in rows if r[1] == loop and r[4]]
        if len(R) < 50: continue
        sm = summary["loops"][loop] = {}
        for ph in ("still", "move"):
            E = np.array([r[5] for r in R if r[3] == ph and r[5] is not None])
            P = [r for r in R if r[3] == ph]
            sm[ph] = {"found": len(E) / max(1, len(P)), "mean": float(E.mean()) if len(E) else None,
                      "p90": float(np.percentile(E, 90)) if len(E) else None, "gt3": float((E > 3).mean()) if len(E) else None}
        first = next((r[2] for r in R if r[5] is not None), None)
        first_in = next((r[2] for r in R), None)
        out = [f"loop {loop}: first outline at frame {first} (page in view from {first_in})"]
        for ph in ("still", "move", "all"):
            P = [r for r in R if ph == "all" or r[3] == ph]
            E = np.array([r[5] for r in P if r[5] is not None])
            found = len(E) / max(1, len(P))
            if len(E):
                out.append(f"{ph}: found {found * 100:4.0f}%  err mean {E.mean():.2f}% med {np.median(E):.2f}% p90 {np.percentile(E, 90):.2f}%  >3%: {(E > 3).mean() * 100:.0f}%")
            else:
                out.append(f"{ph}: found 0%")
        # jitter while still: frame-to-frame outline motion in px
        J = []
        prev = None
        for r in R:
            if r[3] == "still" and r[6] is not None and prev is not None and prev[3] == "still" and prev[6] is not None and r[0] - prev[0] < 50:
                J.append(np.linalg.norm((np.array(r[6]) - np.array(prev[6])) * [W, H], axis=1).mean())
            prev = r
        if J: out.append(f"still jitter {np.mean(J):.2f} px/frame (rms {math.sqrt(np.mean(np.square(J))):.2f})")
        # wobble: how much the outline moves relative to the page from one screen refresh to the next
        Wb = []
        prev = None
        for r in R:
            if r[3] == "still" and r[6] is not None:
                S1, G1 = aligned(r[6], GT["frames"][r[2]]["q"])
                if prev is not None and r[0] - prev[0] < 50:
                    Wb.append(np.linalg.norm((S1 - G1) - prev[1], axis=1).mean())
                prev = (r[0], S1 - G1)
            else:
                prev = None
        if Wb: out.append(f"still wobble (outline vs page) {np.mean(Wb):.2f} px/refresh (rms {math.sqrt(np.mean(np.square(Wb))):.2f})")
        sm["wobble"] = float(np.mean(Wb)) if Wb else None
        # Calm: per camera frame (the last refresh showing it), how the outline moves against the page.
        last = {}
        for r in R:
            if r[6] is not None: last[r[2]] = r
        fr = sorted(last)
        Jit, jumps, nfr = [], 0, 0
        for a, b in zip(fr, fr[1:]):
            if b != a + 1: continue
            ra, rb = last[a], last[b]
            Sa, Ga = aligned(ra[6], GT["frames"][a]["q"]); Sb, Gb = aligned(rb[6], GT["frames"][b]["q"])
            d = np.linalg.norm((Sb - Gb) - (Sa - Ga), axis=1)
            nfr += 1
            if d.max() > 0.01 * DIAG: jumps += 1
            if ra[3] == "still" and rb[3] == "still": Jit.append(d.mean())
        if Jit:
            out.append(f"calm: jitter while still {math.sqrt(np.mean(np.square(Jit))):.2f} px/frame (rms), jumps {jumps} in {nfr} frames")
        sm["jitter"] = float(math.sqrt(np.mean(np.square(Jit)))) if Jit else None
        sm["jumps"] = jumps
        Ra = [r for r in rows if r[1] == loop]
        gone = [r for r in Ra if r[8] < 0.3]
        part = [r for r in Ra if 0.3 <= r[8] < 0.999]
        if gone: out.append(f"page out of view: outline shown {sum(r[6] is not None for r in gone) / len(gone) * 100:.0f}% of the time ({len(gone)} samples)")
        if part: out.append(f"page partly in view: outline shown {sum(r[6] is not None for r in part) / len(part) * 100:.0f}% ({len(part)} samples)")
        sm["gone_shown"] = sum(r[6] is not None for r in gone) / len(gone) if gone else None
        sm["part_shown"] = sum(r[6] is not None for r in part) / len(part) if part else None
        sm["first"] = first; sm["first_in"] = first_in
        Mv = [r for r in R if r[3] == "move" and r[5] is not None]
        if Mv: out.append("move err vs frame shown / 1 earlier / 2 earlier: %.2f%% / %.2f%% / %.2f%%" % (np.mean([r[5] for r in Mv]), np.mean([r[7][0] for r in Mv]), np.mean([r[7][1] for r in Mv])))
        print("  " + "\n  ".join(out))
    print("console errors:", errors[:5] or "none")
    summary["errors"] = errors[:5]
    print("JSON " + json.dumps(summary))


asyncio.run(main())
