/* Audit Scan: phone document scanner for audit fieldwork.
   Camera -> AI page finder (ml-worker) -> crop + scan modes (cv-worker) -> one PDF per batch -> Save to Drive. */
/* global DB, PDF */
"use strict";

(() => {
  const VERSION = "1.3.2";

  const AREAS = [
    { value: "Mixed", label: "Mixed (Claude sorts)", short: "" },
    { value: "Bank & cash", label: "Bank & cash", short: "Bank" },
    { value: "Sales & receivables", label: "Sales & receivables", short: "Sales" },
    { value: "Purchases & payables", label: "Purchases & payables", short: "Purchases" },
    { value: "Payment vouchers & expenses", label: "Payment vouchers & expenses", short: "PV" },
    { value: "Payroll", label: "Payroll (EPF, SOCSO, EIS, PCB)", short: "Payroll" },
    { value: "Fixed assets", label: "Fixed assets (PPE)", short: "PPE" },
    { value: "Inventories", label: "Inventories", short: "Stock" },
    { value: "Tax", label: "Tax (LHDN, SST)", short: "Tax" },
    { value: "Statutory", label: "Statutory (SSM)", short: "SSM" },
    { value: "Agreements & minutes", label: "Agreements & minutes", short: "Agreements" },
    { value: "Other", label: "Other", short: "Other" },
  ];
  // Scan modes, modelled on CamScanner's filter set.
  const FILTERS = [
    { value: "auto", label: "Auto" },
    { value: "original", label: "Original" },
    { value: "lighten", label: "Lighten" },
    { value: "magic", label: "Magic colour" },
    { value: "noshadow", label: "No shadow" },
    { value: "grey", label: "Grey" },
    { value: "bw", label: "B&W" },
    { value: "bw2", label: "B&W 2" },
  ];
  const FILTER_ALIASES = { enhanced: "magic" };   // pages scanned with version 1.0
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const DETECT_EDGE = 420;     // px, preview frame for the classical edge finder
  const TRACK_EDGE = 640;      // px, long side of the frame the live outline snaps to edges in (live-worker.js)
  const ML_SIZE = 224;         // px, input of the AI page finder
  const ML_MIN_SCORE = 0.5;    // AI confidence needed to treat something as a page
  const HOLD_MS = 800;         // page must be steady this long before an automatic capture
  const STEADY = 0.025;        // corner drift (share of the frame) allowed while holding steady
  // Outline on screen: a glide between updates (ms), and a One Euro filter that smooths more when the
  // page is still and less when it moves (min: Hz when still, firm: the same when at least three sides
  // sit on paper edges; beta: how fast it rises with speed). lead: how many frames ahead to place the
  // outline from its recent motion, besides the frames shown since the one it was found in.
  const TUNE = { showMs: 12, euro: { min: 3, firm: 12, beta: 25, dcut: 1 }, lead: 0.3 };
  const CLASSIC_GAP_MS = 250;  // how often the classical edge finder runs while the AI sees no page
  const COOLDOWN_MS = 1200;    // minimum gap between automatic captures
  const MAX_IN_FLIGHT = 2;     // captures being processed at once
  const UNDO_MS = 5000;        // how long the Undo button stays after a capture
  const RING = 238.76;         // shutter ring circumference

  /* ---------- Small helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {};
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const pad2 = (n) => String(n).padStart(2, "0");
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const cleanName = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const areaOf = (v) => AREAS.find((a) => a.value === v) || AREAS[0];
  const normFilter = (v) => { const f = FILTER_ALIASES[v] || v; return FILTERS.some((x) => x.value === f) ? f : "auto"; };
  const filterLabel = (v) => FILTERS.find((f) => f.value === normFilter(v)).label;
  const defaultFilter = () => normFilter(ls.get("as.filter", "auto"));
  const ls = {
    get(k, d = "") { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage unavailable */ } },
  };
  function stamp(d) {
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }
  function fmtWhen(ts) {
    try { return new Date(ts).toLocaleString("en-MY", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
    catch (_) { return ""; }
  }
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag, attrs = {}) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }
  function fileNameFor(b, date = new Date()) {
    const parts = [cleanName(b.client) || "Scan"];
    if (b.fye) parts.push("FYE " + cleanName(b.fye));
    const a = areaOf(b.area);
    if (a.short) parts.push(a.short);
    parts.push(stamp(date));
    return parts.join(" - ");
  }
  function storageErr(err) {
    if (err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || "")))
      return "This phone is out of space for scans. Save or discard a batch to free some.";
    return "";
  }

  // Quad helpers (normalised corners, TL TR BR BL)
  function maxDelta(a, b) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
    return m;
  }
  function lerpQuad(a, b, t) { return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]); }
  function quadArea(q) {
    let s = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0, best = Infinity;
    sorted.forEach((p, i) => { if (p[0] + p[1] < best) { best = p[0] + p[1]; start = i; } });
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  }
  function quadOk(q) {
    let area = 0, sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      area += a[0] * b[1] - b[0] * a[1];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) > 1e-9) {
        const s = Math.sign(cross);
        if (sign && s !== sign) return false;
        sign = s;
      }
    }
    return Math.abs(area) / 2 > 0.02;
  }

  /* ---------- State ---------- */
  const S = {
    screen: "setup",
    batch: null,          // the open batch
    pages: new Map(),     // page id -> page record
    urls: new Map(),      // page id -> thumbnail URL
    saved: [],            // saved batches (kept until deleted)
    save: null,           // the save sheet's job
    editor: null,         // { id, crop, quad, busy, delArmed }
    retake: null,         // { id, filter } while retaking a page
  };

  /* ---------- Workers: image engine (OpenCV) and AI page finder ---------- */
  function makeWorker(url, options, name) {
    return {
      worker: null, seq: 0, pending: new Map(), state: "loading", info: {},
      start() {
        try { this.worker = new Worker(url, options); }
        catch (e) { this.fail(e); return; }
        this.worker.onmessage = (e) => {
          const { id, ok, result, error } = e.data || {};
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          if (ok) p.resolve(result); else p.reject(new Error(error));
        };
        this.worker.onerror = (e) => { e.preventDefault(); this.fail(e); };
        this.call("init").then((r) => { this.info = r || {}; this.state = "ready"; renderEngine(); }, (e) => this.fail(e));
      },
      call(type, payload = {}, transfer = []) {
        if (!this.worker || this.state === "failed") return Promise.reject(new Error(name + " isn't running."));
        return new Promise((resolve, reject) => {
          const id = ++this.seq;
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage(Object.assign({ id, type }, payload), transfer);
        });
      },
      fail(e) {
        console.error(name + " failed", e);
        this.state = "failed";
        for (const p of this.pending.values()) p.reject(new Error(name + " stopped."));
        this.pending.clear();
        renderEngine();
      },
    };
  }
  const engine = makeWorker("cv-worker.js", undefined, "The scanner engine");
  const finder = makeWorker("ml-worker.js", { type: "module" }, "The page finder");

  let failToastShown = false;
  function renderEngine() {
    linkFinder();
    if (finder.state === "failed" && tracker.worker) tracker.worker.postMessage({ type: "ai-off" });
    const st = engine.state;
    el.engineChip.className = "chip" + (st === "ready" ? " is-ok" : st === "failed" ? " is-bad" : "");
    el.engineChip.textContent = st === "ready" ? "Scanner ready" : st === "failed" ? "Scanner didn't load" : "Loading scanner";
    el.engineChip.title = finder.state === "ready" ? "AI page finder on" : finder.state === "failed" ? "AI page finder off; using the basic edge finder" : "AI page finder loading";
    el.btnShutter.disabled = st !== "ready";
    if (st === "failed" && !failToastShown) {
      failToastShown = true;
      toast("The scanner engine didn't load. Check your connection, then close and reopen the app.", 8000);
    }
  }

  /* ---------- Reading camera frames ----------
     The AI page finder takes a 224 x 224 picture of the whole frame. Copying a 4K camera frame into a
     canvas that's kept in main memory is slow (the whole frame has to come off the GPU first), so the
     picture is shrunk on the GPU and only the small result is read back. Phones differ, so the first
     frames are timed both ways and the faster way is kept. */
  const stats = { grabMs: 0, mlMs: 0, rtMs: 0, looks: 0, lookHz: 0, since: 0, way: "", pageMs: 0, liveMs: 0, liveHz: 0, aiHz: 0, camHz: 0 };
  const ema = (prev, x) => (prev ? prev * 0.9 + x * 0.1 : x);
  function makeGrabber(w, h) {
    return {
      w, h, pick: -1, times: [[], []],
      canv: [false, true].map((slow) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        return c.getContext("2d", { willReadFrequently: slow, alpha: false });
      }),
      size(w2, h2) {
        if (w2 === this.w && h2 === this.h) return;
        this.w = w2; this.h = h2;
        for (const ctx of this.canv) { ctx.canvas.width = w2; ctx.canvas.height = h2; }
      },
      grab(source, timed) {
        const i = this.pick >= 0 ? this.pick : (this.times[0].length <= this.times[1].length ? 0 : 1);
        const ctx = this.canv[i];
        const t0 = performance.now();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(source, 0, 0, this.w, this.h);
        const img = ctx.getImageData(0, 0, this.w, this.h);
        const dt = performance.now() - t0;
        if (timed && this.pick < 0) {
          this.times[i].push(dt);
          if (this.times[0].length >= 12 && this.times[1].length >= 12) {
            const med = (a) => a.slice(2).sort((x, y) => x - y)[(a.length - 2) >> 1];
            this.pick = med(this.times[0]) <= med(this.times[1]) ? 0 : 1;
            if (this === mlGrab && tracker.state !== "ready") stats.way = this.pick === 0 ? "gpu" : "cpu";
            if (this === trackGrab) stats.way = this.pick === 0 ? "canvas gpu" : "canvas cpu";
          }
        }
        return { img, dt };
      },
      // Part of the source (sx, sy, sw, sh in source pixels), squeezed into the canvas.
      grabCrop(source, sx, sy, sw, sh) {
        const ctx = this.canv[this.pick >= 0 ? this.pick : 0];
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "medium";
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, this.w, this.h);
        return ctx.getImageData(0, 0, this.w, this.h);
      },
    };
  }
  const mlGrab = makeGrabber(ML_SIZE, ML_SIZE);
  const cvGrab = makeGrabber(DETECT_EDGE, DETECT_EDGE);
  const trackGrab = makeGrabber(64, 64);

  /* ---------- Live outline worker ----------
     Every camera frame goes to live-worker.js, which snaps the outline to the paper's edges in it and asks
     the AI page finder (through a MessagePort, so the page isn't involved) where the page is. Frames go as
     VideoFrames when the worker can read them as the screen shows them (it copies or draws them, whichever
     works and is quicker on this phone); otherwise as stills of the video, or as small pictures the page
     draws itself. The worker also draws the camera view, each frame with its own outline (syncView). */
  const tracker = {
    worker: null, state: "off", linked: false, path: "", busy: false, seq: 0, epoch: 0, sentFrame: -1, sentAt: 0, src: "", vfFails: 0, stalls: 0,
    view: "",          // "sent": the preview canvas has been handed to the worker
    noSync: !!window.__auditScanNoSync,   // the worker doesn't draw the view on this phone (tests can ask for that too)
    syncFails: 0,      // times the drawn view stopped and the video was shown instead
  };
  function startTracker() {
    if (tracker.worker || tracker.state === "failed") return;
    try { tracker.worker = new Worker("live-worker.js"); }
    catch (e) { console.error("The live outline didn't start", e); tracker.state = "failed"; return; }
    tracker.worker.onmessage = onTrackerMsg;
    tracker.worker.onerror = (e) => {
      e.preventDefault();
      console.error("The live outline stopped", e.message || e);
      tracker.state = "failed"; tracker.busy = false; tracker.src = "";
      cam.synced = false; showSynced(false);
    };
    tracker.state = "ready";
    linkFinder();
  }
  function linkFinder() {
    if (tracker.state !== "ready" || tracker.linked || finder.state !== "ready") return;
    const ch = new MessageChannel();
    finder.worker.postMessage({ type: "port", port: ch.port1 }, [ch.port1]);
    tracker.worker.postMessage({ type: "port", port: ch.port2 }, [ch.port2]);
    tracker.linked = true;
  }
  function trackSize(v) {
    const s = TRACK_EDGE / Math.max(v.videoWidth, v.videoHeight);
    trackGrab.size(Math.max(16, Math.round(v.videoWidth * s)), Math.max(16, Math.round(v.videoHeight * s)));
  }
  // Can VideoFrames be read in the worker as the screen shows them (same way up, same framing)? The worker
  // compares its copy and its drawing of one with the same frame drawn by the page.
  function checkFramePath(v) {
    if (window.__auditScanForcePath) { tracker.path = window.__auditScanForcePath; syncView(true); return; }   // tests
    let f = null;
    if (typeof VideoFrame === "function") { try { f = new VideoFrame(v); } catch (_) { f = null; } }
    if (!f) { tracker.path = "canvas"; syncView(true); return; }
    trackSize(v);
    const { img } = trackGrab.grab(v, false);
    tracker.busy = true;
    tracker.sentAt = performance.now();
    try {
      tracker.worker.postMessage({ type: "check", epoch: tracker.epoch, frame: f, rgba: img.data.buffer, w: trackGrab.w, h: trackGrab.h }, [f, img.data.buffer]);
    } catch (_) {
      try { f.close(); } catch (_e) { /* gone */ }
      tracker.busy = false; tracker.path = "canvas"; syncView(true);
    }
  }
  // With the worker drawing the view but VideoFrames unusable: a still of each frame, at about the size it's
  // shown (never smaller than the outline's picture), goes to the worker, which finds the outline in it and
  // shows it with that outline.
  function stillSize(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const k = Math.min(1, Math.max(Math.min(cam.viewW / vw, cam.viewH / vh) || 0, TRACK_EDGE / Math.max(vw, vh)));
    return { resizeWidth: Math.max(16, Math.round(vw * k)), resizeHeight: Math.max(16, Math.round(vh * k)), resizeQuality: "medium" };
  }
  function sendFrame(v) {
    if (tracker.busy || live.frame === tracker.sentFrame) return;
    if (!tracker.path) { checkFramePath(v); if (tracker.busy) return; }
    const seq = ++tracker.seq;
    if (tracker.path === "frame") {
      let f = null;
      try { f = new VideoFrame(v); }
      catch (_) { if (++tracker.vfFails >= 3) tracker.path = "canvas"; return; }
      tracker.busy = true; tracker.sentFrame = live.frame; tracker.sentAt = performance.now();
      try { tracker.worker.postMessage({ type: "frame", seq, cf: live.frame, epoch: tracker.epoch, frame: f }, [f]); }
      catch (_) { try { f.close(); } catch (_e) { /* gone */ } tracker.busy = false; tracker.path = "canvas"; }
      return;
    }
    // Drawing frames costs the page time: on a phone where it's slow, draw fewer of them.
    if (stats.grabMs > 12 && performance.now() - tracker.sentAt < stats.grabMs * 2.5) return;
    tracker.busy = true; tracker.sentFrame = live.frame; tracker.sentAt = performance.now();
    if (!cam.synced) {
      trackSize(v);
      const { img, dt } = trackGrab.grab(v, true);
      stats.grabMs = ema(stats.grabMs, dt);
      tracker.worker.postMessage({ type: "frame", seq, cf: live.frame, epoch: tracker.epoch, rgba: img.data.buffer, w: trackGrab.w, h: trackGrab.h }, [img.data.buffer]);
      return;
    }
    const epoch = tracker.epoch, cf = live.frame, t0 = performance.now();
    createImageBitmap(v, stillSize(v)).then((still) => {
      stats.grabMs = ema(stats.grabMs, performance.now() - t0);
      if (epoch !== tracker.epoch || !tracker.worker) { still.close(); return; }
      try { tracker.worker.postMessage({ type: "frame", seq, cf, epoch, still }, [still]); }
      catch (_) { still.close(); tracker.busy = false; }
    }, () => {
      // this phone can't take stills of the video: show the video itself, and draw frames as before
      if (epoch === tracker.epoch) tracker.busy = false;
      noSync();
    });
  }
  function onTrackerMsg(e) {
    const m = e.data || {};
    if (m.epoch !== tracker.epoch) return;          // from before the camera restarted
    if (m.type === "check") {
      tracker.busy = false;
      tracker.path = m.ok ? "frame" : "canvas";
      syncView(true);
      pump();
      return;
    }
    if (m.type !== "quad") return;
    tracker.busy = false;
    // This phone's frames can't be read in the worker: stills of the video instead, and if even those can't,
    // the page draws each frame small itself (and the video shows the camera).
    if (m.fallback) { if (tracker.path === "canvas") noSync(); tracker.path = "canvas"; }
    if (m.drawn) { cam.drawnAt = performance.now(); cam.drawN++; if (cam.synced) showSynced(true); }
    else if (!cam.synced) resync();
    if (m.sig) cam.sig = m.sig;
    if (m.stats) {
      stats.liveMs = m.stats.liveMs; stats.liveHz = m.stats.liveHz; stats.aiHz = m.stats.aiHz;
      if (m.stats.aiMs) stats.mlMs = m.stats.aiMs;
      if (m.stats.way) stats.way = m.stats.way;
    }
    stats.rtMs = ema(stats.rtMs, performance.now() - tracker.sentAt);
    tracker.src = m.src || "";
    cam.sides = m.sides || 0;
    cam.cut = !!m.cut;
    if (m.trace && tracker.trace) tracker.trace.push({ seq: m.seq, cf: tracker.sentFrame, t: performance.now(), q: m.quad, ...m.trace });
    // How fast the outline moves (per camera frame), to place it on frames shown before its next update.
    const f = tracker.sentFrame, q = m.quad, p = cam.motion;
    // (not across a jump to a new outline, and never faster than a hand moves a phone)
    if (q && p.q && !m.jump && f > p.f && f - p.f <= 3 && maxDelta(q, p.q) < 0.08) {
      const k = 1 / (f - p.f);
      const v = q.map((c, i) => [(c[0] - p.q[i][0]) * k, (c[1] - p.q[i][1]) * k]);
      p.v = p.v ? v.map((c, i) => [0.6 * c[0] + 0.4 * p.v[i][0], 0.6 * c[1] + 0.4 * p.v[i][1]]) : v;
      if (p.v.some(([x, y]) => Math.abs(x) > 0.03 || Math.abs(y) > 0.03)) p.v = null;
    } else p.v = null;
    p.q = q; p.f = f;
    if (cam.stream && S.screen === "camera") { countLook(); onDetect(m.quad); }
    pump();                                          // a newer frame may be waiting
  }
  function setEase() { if (tracker.worker) tracker.worker.postMessage({ type: "ease", on: cam.inFlight > 0 }); }

  // The camera view drawn by the worker, frame by frame with that frame's outline, so the outline stays on
  // the page as shown even while the hand shakes. Where that can't be done (or stops working), the video
  // element shows the camera and the outline is drawn over it.
  function syncView(on) {
    on = !!on && !tracker.noSync && tracker.state === "ready" && typeof el.preview.transferControlToOffscreen === "function" &&
      (tracker.path === "frame" || typeof createImageBitmap === "function");
    if (on && tracker.view !== "sent") {
      try {
        const oc = el.preview.transferControlToOffscreen();
        tracker.worker.postMessage({ type: "view", canvas: oc, dpr: viewDpr() }, [oc]);
        tracker.view = "sent";
      } catch (_) { tracker.noSync = true; on = false; }
    }
    if (on === cam.synced) return;
    cam.synced = on;
    cam.viewW = cam.viewH = 0;
    cam.syncAt = performance.now(); cam.drawnAt = 0; cam.okRun = 0;
    cam.rate = { at: cam.syncAt, frame: live.frame, slow: 0 }; cam.drawN = 0;
    if (on) {
      sizeView();   // (the drawn view replaces the video once the worker has drawn a frame: showSynced)
      tracker.worker.postMessage({ type: "look", steady: cam.showSteady });
    }
    else {
      if (tracker.view === "sent" && tracker.worker) tracker.worker.postMessage({ type: "view-off" });
      showSynced(false);
    }
  }
  function showSynced(on) {
    if (cam.viewing === on) return;
    cam.viewing = on;
    el.scrCamera.classList.toggle("synced", on);
    drawQuad(on ? null : cam.shown, cam.showSteady);
  }
  function noSync() { tracker.noSync = true; syncView(false); }
  // After the drawn view stalled (the phone was busy, say) and the video was shown instead: back to the
  // drawn view once the outline keeps up with the camera again.
  function resync() {
    if (tracker.noSync || !tracker.syncFails || cam.synced || !cam.stream) return;
    const now = performance.now();
    cam.okRun = cam.lastAnswer && now - cam.lastAnswer < 70 ? (cam.okRun || 0) + 1 : 0;
    cam.lastAnswer = now;
    if (cam.okRun >= 20) syncView(true);
  }
  // Called every screen refresh while the worker draws the view: if its drawing stops, the video is shown
  // instead; if it can't keep up with the camera at all on this phone, the video is shown from then on.
  function watchSync(now) {
    if (!cam.stream || S.screen !== "camera" || document.hidden) { cam.syncAt = now; return; }
    if (now - Math.max(cam.drawnAt, cam.syncAt) > (cam.drawnAt ? 700 : 2500)) {
      if (++tracker.syncFails >= 3) noSync(); else syncView(false);
      return;
    }
    const w = cam.rate;
    if (now - w.at < 2000) return;
    const s = (now - w.at) / 1000, drawn = cam.drawN / s, camHz = (live.frame - w.frame) / s;
    // Too slow: fewer than half the camera's frames get drawn (and under 15 a second), or frames come far slower
    // than the camera is set to give them (the hidden video may be held back on some phones). Not while pages
    // are being processed: that takes cores for a moment.
    w.slow = drawn < Math.min(15, 0.5 * camHz) || (drawn < 12 && cam.fps >= 24 && camHz < 12) ? (cam.inFlight === 0 ? w.slow + 1 : w.slow) : 0;
    w.at = now; w.frame = live.frame; cam.drawN = 0;
    if (w.slow >= 2) noSync();
  }
  const viewDpr = () => Math.min(window.devicePixelRatio || 1, 2.5);
  function sizeView() {
    if (!cam.synced) return;
    const r = el.video.getBoundingClientRect(), d = viewDpr();
    const w = Math.max(16, Math.round(r.width * d)), h = Math.max(16, Math.round(r.height * d));
    if (w === cam.viewW && h === cam.viewH) return;
    cam.viewW = w; cam.viewH = h;
    tracker.worker.postMessage({ type: "view-size", w, h, dpr: d });
  }

  async function finderDetect(img) {
    const t0 = performance.now();
    try {
      const r = await finder.call("detect", { buffer: img.data.buffer }, [img.data.buffer]);
      stats.mlMs = ema(stats.mlMs, r.ms || 0);
      stats.rtMs = ema(stats.rtMs, performance.now() - t0);
      return r.quad && r.score >= ML_MIN_SCORE && quadArea(r.quad) > 0.06 && quadOk(r.quad) ? r.quad : null;
    } catch (_) {
      return null;
    }
  }
  async function findPage(source) {
    if (finder.state !== "ready") return null;
    return finderDetect(mlGrab.grab(source, false).img);
  }

  // Second looks: the AI again on crops around its first outline. When a page lies on or next to
  // other papers, the first look can take them in; a crop that leaves them out usually doesn't.
  // The image engine then keeps whichever outline best fits the paper's edges. Returns [{ q, src }].
  async function secondLooks(source, q0) {
    if (finder.state !== "ready" || !q0) return [];
    const W = source.width, H = source.height;
    const xs = q0.map((p) => p[0] * W), ys = q0.map((p) => p[1] * H);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const bw = x1 - x0, bh = y1 - y0, m = 0.08, c = 0.25;
    const g = 0.3;
    const boxes = [
      ["bbox", x0 - m * bw, y0 - m * bh, x1 + m * bw, y1 + m * bh],
      ["grow", x0 - g * bw, y0 - g * bh, x1 + g * bw, y1 + g * bh],
      ["cut_top", x0 - m * bw, y0 + c * bh, x1 + m * bw, y1 + m * bh],
      ["cut_bottom", x0 - m * bw, y0 - m * bh, x1 + m * bw, y1 - c * bh],
      ["cut_left", x0 + c * bw, y0 - m * bh, x1 + m * bw, y1 + m * bh],
      ["cut_right", x0 - m * bw, y0 - m * bh, x1 - c * bw, y1 + m * bh],
    ];
    const out = [];
    for (const [src, a, b, e, f] of boxes) {
      const bx = Math.max(0, a), by = Math.max(0, b), ex = Math.min(W, e), ey = Math.min(H, f);
      if (ex - bx < 50 || ey - by < 50) continue;
      const q = await finderDetect(mlGrab.grabCrop(source, bx, by, ex - bx, ey - by));
      if (q) out.push({ src, q: q.map(([x, y]) => [(bx + x * (ex - bx)) / W, (by + y * (ey - by)) / H]) });
    }
    return out;
  }

  /* ---------- Navigation ---------- */
  let guard = false;
  function ensureGuard() {
    if (!guard) { history.pushState({ auditScan: 1 }, ""); guard = true; }
  }
  function backTarget() { return { editor: "review", review: "setup", camera: "setup" }[S.screen] || "setup"; }
  function goBack() {
    const target = backTarget();
    if (target === "setup" && guard) { history.back(); return; }
    show(target);
  }
  window.addEventListener("popstate", () => {
    guard = false;
    if (!el.saveSheet.hidden) { closeSave(); ensureGuard(); return; }
    if (S.screen === "editor" && S.editor && S.editor.crop) { exitCrop(); ensureGuard(); return; }
    const target = backTarget();
    if (target !== "setup") ensureGuard();
    if (S.screen !== "setup") show(target);
  });

  function show(name) {
    if (S.screen === "editor" && name !== "editor") leaveEditor();
    S.screen = name;
    el.scrSetup.hidden = name !== "setup";
    el.scrCamera.hidden = name !== "camera";
    el.scrReview.hidden = name !== "review";
    el.scrEditor.hidden = name !== "editor";
    if (name === "camera") startCamera(); else stopCamera();
    if (name === "setup") renderSetup();
    if (name === "review") renderReview();
    if (name === "editor") renderEditor();
    window.scrollTo(0, 0);
  }

  /* ---------- Toast ---------- */
  let toastTimer = 0;
  function toast(msg, ms = 4500) {
    el.toast.textContent = msg;
    el.toast.classList.toggle("on-dark", S.screen === "camera" || S.screen === "editor");
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  /* ---------- Batch details screen ---------- */
  function fillAreas() {
    el.area.replaceChildren(...AREAS.map((a) => new Option(a.label, a.value)));
  }
  function recentClients() {
    try { return JSON.parse(ls.get("as.clients", "[]")); } catch (_) { return []; }
  }
  function rememberClient(name) {
    const list = [name, ...recentClients().filter((c) => c.toLowerCase() !== name.toLowerCase())].slice(0, 40);
    ls.set("as.clients", JSON.stringify(list));
  }
  function renderClients() {
    const seen = new Set(), names = [];
    for (const c of [...recentClients(), ...S.saved.map((b) => b.client)]) {
      const n = String(c || "").trim();
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); names.push(n); }
    }
    el.clientList.replaceChildren(...names.map((n) => new Option(n, n)));
  }

  function renderSetup() {
    const b = S.batch;
    el.client.value = b ? b.client : ls.get("as.client");
    el.fye.value = b ? b.fye || "" : ls.get("as.fye");
    const area = b ? b.area : ls.get("as.area", "Mixed");
    el.area.value = AREAS.some((a) => a.value === area) ? area : "Mixed";
    el.note.value = b ? b.note || "" : "";
    const n = b ? b.pageIds.length : 0;
    el.batchState.textContent = b ? "In progress · " + plural(n, "page", "pages") : "New batch";
    el.btnStart.textContent = n ? "Continue scanning" : "Start scanning";
    el.openBatch.hidden = !b;
    if (b) el.openSummary.textContent = [b.client, areaOf(b.area).label, plural(n, "page", "pages"), "started " + fmtWhen(b.createdAt)].join(" · ");
    el.formMsg.hidden = true;
    disarmDiscard();
    renderClients();
    renderSaved();
    renderVersion();
  }

  // Footer: version, and once the camera has run, how fast the page finder is on this phone.
  function renderVersion() {
    let t = `Version ${VERSION}.`;
    if (cam.res && stats.camHz) t += ` Camera: ${cam.res}, ${Math.round(stats.camHz)} frames a second.`;
    if (stats.liveHz) {
      const n = finder.info.threads || 1;
      const view = tracker.view === "sent" ? (cam.synced ? ", view in step" : tracker.noSync ? ", video view" : ", view paused") : "";
      t += ` Outline: ${Math.round(stats.liveHz)} updates a second, ${Math.round(stats.liveMs || 0)} ms each (${stats.way || "?"}${view}).`;
      if (stats.mlMs) t += ` AI: ${plural(n, "core", "cores")}, ${Math.round(stats.mlMs)} ms a look, ${Math.round(stats.aiHz || 0)} a second.`;
    } else if (stats.rtMs) {
      const n = finder.info.threads || 1;
      t += ` Page finder: ${plural(n, "core", "cores")}, ${Math.round(stats.rtMs)} ms a look`;
      t += stats.lookHz ? `, ${Math.round(stats.lookHz)} looks a second` : "";
      t += stats.way ? ` (${stats.way}).` : ".";
    }
    if (stats.pageMs) t += ` Each page takes ${(stats.pageMs / 1000).toFixed(1)} s to process.`;
    el.verText.textContent = t;
  }

  let fieldTimer = 0;
  function onField() {
    if (!S.batch) return;
    clearTimeout(fieldTimer);
    fieldTimer = setTimeout(async () => {
      const client = el.client.value.trim();
      if (!client) return;
      Object.assign(S.batch, { client, fye: el.fye.value.trim(), area: el.area.value, note: el.note.value.trim(), updatedAt: Date.now() });
      await saveBatch().catch(() => {});
    }, 400);
  }

  async function onStart() {
    const client = el.client.value.trim();
    if (!client) {
      el.formMsg.textContent = "Enter the client name first. It goes into the file name.";
      el.formMsg.hidden = false;
      el.client.focus();
      return;
    }
    el.formMsg.hidden = true;
    const now = Date.now();
    if (!S.batch) S.batch = { id: uid(), status: "open", createdAt: now, pageIds: [] };
    Object.assign(S.batch, { client, fye: el.fye.value.trim(), area: el.area.value, note: el.note.value.trim(), updatedAt: now });
    rememberClient(client);
    ls.set("as.client", client);
    ls.set("as.fye", S.batch.fye);
    ls.set("as.area", S.batch.area);
    try { await saveBatch(); }
    catch (err) { toast(storageErr(err) || "The batch couldn't be saved on this phone: " + err.message); return; }
    ensureGuard();
    show("camera");
  }

  async function saveBatch() {
    if (!S.batch) return;
    await DB.put("batches", { ...S.batch, pageIds: [...S.batch.pageIds] });
  }

  let discardArmed = false, discardTimer = 0;
  function disarmDiscard() {
    discardArmed = false;
    clearTimeout(discardTimer);
    el.btnDiscard.textContent = "Discard batch";
  }
  async function onDiscard() {
    if (!S.batch) return;
    if (!discardArmed) {
      discardArmed = true;
      el.btnDiscard.textContent = "Tap again to discard";
      discardTimer = setTimeout(disarmDiscard, 4000);
      return;
    }
    disarmDiscard();
    const id = S.batch.id;
    clearBatchState();
    await DB.deleteBatch(id).catch(() => {});
    renderSetup();
    toast("Batch discarded.");
  }

  function clearBatchState() {
    for (const u of S.urls.values()) URL.revokeObjectURL(u);
    S.urls.clear();
    S.pages = new Map();
    S.batch = null;
  }

  /* ---------- Saved batches ---------- */
  function renderSaved() {
    const list = [...S.saved].sort((a, b) => b.savedAt - a.savedAt);
    el.savedList.replaceChildren(...list.map(savedRow));
    el.savedEmpty.hidden = list.length > 0;
    el.savedSum.textContent = list.length ? plural(list.length, "batch", "batches") : "";
    el.btnDeleteAllSaved.hidden = list.length < 2;
    disarmDeleteAll();
  }

  let delAllArmed = false, delAllTimer = 0;
  function disarmDeleteAll() {
    delAllArmed = false;
    clearTimeout(delAllTimer);
    el.btnDeleteAllSaved.textContent = "Delete all";
  }
  async function onDeleteAllSaved() {
    if (!delAllArmed) {
      delAllArmed = true;
      el.btnDeleteAllSaved.textContent = "Tap again to delete all";
      delAllTimer = setTimeout(disarmDeleteAll, 4000);
      return;
    }
    const ids = S.saved.map((b) => b.id);
    for (const id of ids) await DB.deleteBatch(id).catch(() => {});
    S.saved = [];
    renderSaved();
    toast("Saved batches deleted from this phone. Files already in Drive aren't affected.");
  }
  function savedRow(b) {
    const li = node("li");
    const main = node("div", "s-main");
    main.append(node("p", "s-name", b.fileName || fileNameFor(b)));
    const via = b.savedVia === "phone" ? "saved to phone" : "sent to Drive";
    main.append(node("p", "s-meta", `${plural(b.pageCount || b.pageIds.length, "page", "pages")} · ${via} ${fmtWhen(b.savedAt)}`));
    const act = node("div", "s-actions");
    const again = node("button", "link-btn", "Send again");
    again.type = "button";
    again.addEventListener("click", () => openSave(b, "again"));
    const del = node("button", "link-btn danger", "Delete");
    del.type = "button";
    let armed = false, t = 0;
    del.addEventListener("click", async () => {
      if (!armed) {
        armed = true; del.textContent = "Tap again";
        t = setTimeout(() => { armed = false; del.textContent = "Delete"; }, 3500);
        return;
      }
      clearTimeout(t);
      await DB.deleteBatch(b.id).catch(() => {});
      S.saved = S.saved.filter((x) => x.id !== b.id);
      renderSaved();
      toast("Deleted from this phone. The copy in Drive isn't affected.");
    });
    act.append(again, del);
    li.append(main, act);
    return li;
  }

  /* ---------- Camera ---------- */
  const cam = {
    stream: null, track: null, torch: false, raf: 0, wakeLock: null, res: "",
    lastQuad: null, lastQuadAt: 0, shown: null, showSteady: false, lastAnim: 0, anchor: null, steadySince: 0, misses: 0,
    armed: true, capturedSig: null, capturedAt: 0, sig: null, inFlight: 0, starting: false,
    target: null, motion: { q: null, f: -1, v: null },
    // the view drawn by the live outline worker: on, its size (device px), when it was switched on, when the
    // worker last drew a frame, frames drawn since rate.at, answers in a row that kept up with the camera
    synced: false, viewing: false, viewW: 0, viewH: 0, syncAt: 0, drawnAt: 0, drawN: 0, rate: { at: 0, frame: 0, slow: 0 }, okRun: 0, lastAnswer: 0,
    fps: 0,   // frames a second the camera is set to give
    cut: false,   // the outline isn't shown because part of the page is out of view
  };
  // Live page finding: every new camera frame goes to the live outline worker (or, if that worker isn't
  // running, the AI finder looks at every frame it can keep up with); the classical edge finder runs
  // alongside, a few times a second, only while the AI sees no page.
  const live = {
    frame: 0, vfc: 0, watching: false, useRaf: false, rateAt: 0, rateFrame: 0,
    mlBusy: false, mlFrame: -1, mlQuad: null, mlLast: 0,
    cvBusy: false, cvFrame: -1, cvQuad: null, cvAt: 0, cvLast: 0,
  };

  const autoOn = () => el.btnAuto.getAttribute("aria-pressed") === "true";

  function setHint(t) { if (el.hint.textContent !== t) el.hint.textContent = t; }

  function renderCamLabel() {
    const b = S.batch;
    el.camLabel.textContent = b ? [b.client, areaOf(b.area).short].filter(Boolean).join(" · ") : "";
  }

  async function startCamera() {
    renderCamLabel();
    updateCounter();
    renderModes();
    el.undoBar.hidden = true;
    el.camError.hidden = true;
    if (cam.stream) { loopStart(); return; }
    if (cam.starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camFail("This browser can't use the camera. Open Audit Scan in Chrome.");
      return;
    }
    cam.starting = true;
    setHint("Starting camera…");
    try {
      const stream = await openCamera();
      if (S.screen !== "camera" || document.hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
      cam.stream = stream;
      cam.track = stream.getVideoTracks()[0];
      el.video.srcObject = stream;
      await el.video.play().catch(() => {});
      await new Promise((res) => {
        if (el.video.videoWidth) return res();
        el.video.addEventListener("loadedmetadata", res, { once: true });
        setTimeout(res, 3000);
      });
      sizeOverlay();
      sizeView();
      trackFeatures();
      requestWakeLock();
      resetDetection();
      loopStart();
    } catch (err) {
      const n = err && err.name;
      camFail(n === "NotAllowedError"
        ? "Camera access is blocked. Allow the camera for this app in Chrome's site settings, then tap Try again."
        : n === "NotFoundError" ? "No camera was found on this phone."
        : "The camera couldn't start" + (n ? ` (${n})` : "") + ". Close other apps using the camera, then tap Try again.");
    } finally {
      cam.starting = false;
    }
  }

  // 4:3, the shape of the camera's sensor (CamScanner uses it too): the view takes in more of the desk around the
  // page than the 16:9 crop of it, with about as many pixels as 4K. Only as the camera gives it, not cut out of
  // its 16:9 picture; a camera that can't give a sharp 4:3 picture at full speed keeps to 16:9 4K.
  async function openCamera() {
    const base = { facingMode: { ideal: "environment" }, frameRate: { ideal: 30, max: 30 } };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...base, width: { ideal: 3264 }, height: { ideal: 2448 }, aspectRatio: { ideal: 4 / 3 }, resizeMode: { ideal: "none" } },
    });
    const track = stream.getVideoTracks()[0];
    const s = (track && track.getSettings && track.getSettings()) || {};
    const long = Math.max(s.width || 0, s.height || 0);
    if (track && ((long && long < 3000) || (s.frameRate && s.frameRate < 24))) {
      try { await track.applyConstraints({ ...base, width: { ideal: 3840 }, height: { ideal: 2160 } }); }
      catch (_) { /* keeps the picture it has */ }
    }
    return stream;
  }

  function camFail(msg) {
    el.camErrorText.textContent = msg;
    el.camError.hidden = false;
    setHint("");
  }

  function sizeOverlay() {
    const w = el.video.videoWidth || 1, h = el.video.videoHeight || 1;
    el.overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  function trackFeatures() {
    const caps = (cam.track && cam.track.getCapabilities && cam.track.getCapabilities()) || {};
    el.btnTorch.hidden = !caps.torch;
    cam.torch = false;
    el.btnTorch.setAttribute("aria-pressed", "false");
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      cam.track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    const s = (cam.track && cam.track.getSettings && cam.track.getSettings()) || {};
    cam.res = `${s.width || el.video.videoWidth}×${s.height || el.video.videoHeight}`;
    cam.fps = s.frameRate || 0;
  }

  function stopCamera() {
    clearTimeout(undoTimer);
    if (el.undoBar) el.undoBar.hidden = true;
    cancelAnimationFrame(cam.raf);
    cam.raf = 0;
    try { if (live.vfc && el.video.cancelVideoFrameCallback) el.video.cancelVideoFrameCallback(live.vfc); } catch (_) { /* gone */ }
    live.vfc = 0;
    live.watching = false;
    if (cam.stream) {
      cam.stream.getTracks().forEach((t) => t.stop());
      cam.stream = null;
      cam.track = null;
      el.video.srcObject = null;
    }
    releaseWakeLock();
    resetDetection();
  }

  function resetDetection() {
    cam.lastQuad = null; cam.shown = null; cam.target = null; cam.anchor = null; cam.steadySince = 0; cam.misses = 0; cam.armed = true;
    cam.showSteady = false; cam.lostSince = performance.now(); cam.cut = false;
    live.mlQuad = null; live.cvQuad = null; live.cvAt = 0;
    tracker.epoch++; tracker.busy = false; tracker.sentFrame = -1; tracker.src = "";
    cam.motion = { q: null, f: -1, v: null };
    cam.syncAt = performance.now(); cam.drawnAt = 0; cam.drawN = 0; cam.rate = { at: cam.syncAt, frame: live.frame, slow: 0 };
    if (tracker.worker) tracker.worker.postMessage({ type: "reset" });
    euroReset();
    drawQuad(null, false);
    setRing(0);
  }

  async function requestWakeLock() {
    try { if ("wakeLock" in navigator && !cam.wakeLock) cam.wakeLock = await navigator.wakeLock.request("screen"); }
    catch (_) { /* not available here */ }
  }
  function releaseWakeLock() {
    try { if (cam.wakeLock) cam.wakeLock.release(); } catch (_) { /* already released */ }
    cam.wakeLock = null;
  }

  async function toggleTorch() {
    if (!cam.track) return;
    const next = !cam.torch;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: next }] });
      cam.torch = next;
      el.btnTorch.setAttribute("aria-pressed", String(next));
    } catch (_) {
      toast("The flash couldn't be switched on.");
    }
  }

  function loopStart() {
    if (!cam.raf) { cam.lastAnim = 0; cam.raf = requestAnimationFrame(animate); }
    watchFrames();
  }

  // Run the finders once per new camera frame (requestVideoFrameCallback), or once per screen
  // refresh on browsers without it.
  function watchFrames() {
    const v = el.video;
    if (live.watching || !cam.stream) return;
    live.watching = true;
    if (!v.requestVideoFrameCallback) { live.useRaf = true; return; }
    const onFrame = (_now, meta) => {
      if (!cam.stream) { live.watching = false; return; }
      live.frame = meta && meta.presentedFrames ? meta.presentedFrames : live.frame + 1;
      live.vfc = v.requestVideoFrameCallback(onFrame);
      pump();
    };
    live.vfc = v.requestVideoFrameCallback(onFrame);
  }

  function pump() {
    const v = el.video;
    if (!cam.stream || S.screen !== "camera" || v.readyState < 2 || !v.videoWidth) return;
    const now = performance.now();
    // A frame the worker never answered (it shouldn't happen): try drawn frames, then the old way.
    if (tracker.state === "ready" && tracker.busy && now - tracker.sentAt > 1500) {
      tracker.busy = false;
      tracker.stalls++;
      if (tracker.stalls >= 2) tracker.path = "canvas";
      if (tracker.stalls >= 4) { tracker.state = "failed"; tracker.src = ""; noSync(); }
    }
    if (tracker.state === "ready") sendFrame(v);
    else legacyLook(v, now);
    // The classical edge finder, while the AI sees no page (or there's no AI).
    const aiPage = tracker.state === "ready" ? tracker.src === "ai" : !!live.mlQuad;
    const needClassic = finder.state !== "ready" || (!aiPage && now - live.cvLast > CLASSIC_GAP_MS);
    if (engine.state === "ready" && needClassic && !live.cvBusy && cam.inFlight === 0 && live.frame !== live.cvFrame) {
      live.cvBusy = true;
      live.cvFrame = live.frame;
      live.cvLast = now;
      const s = DETECT_EDGE / Math.max(v.videoWidth, v.videoHeight);
      cvGrab.size(Math.round(v.videoWidth * s), Math.round(v.videoHeight * s));
      const { img } = cvGrab.grab(v, true);
      const seq = tracker.seq;
      if (finder.state !== "ready" && tracker.state !== "ready") cam.sig = signatureOf(img.data, cvGrab.w, cvGrab.h);
      engine.call("detect", { width: cvGrab.w, height: cvGrab.h, buffer: img.data.buffer }, [img.data.buffer])
        .then((r) => {
          live.cvQuad = r.quad || null;
          live.cvAt = performance.now();
          if (!cam.stream) return;
          if (tracker.state === "ready") { if (r.quad) tracker.worker.postMessage({ type: "cv", seq, quad: r.quad }); }
          else if (finder.state !== "ready") { countLook(); onDetect(live.cvQuad); }
        })
        .catch(() => {})
        .finally(() => { live.cvBusy = false; });
    }
  }

  // Without the live outline worker: the AI finder looks at each new frame it can keep up with.
  function legacyLook(v, now) {
    // While a capture is being processed, look at most 20 times a second to leave cores for it.
    const ease = cam.inFlight > 0 && now - live.mlLast < 50;
    if (finder.state === "ready" && !live.mlBusy && !ease && live.frame !== live.mlFrame) {
      live.mlBusy = true;
      live.mlFrame = live.frame;
      live.mlLast = now;
      const { img, dt } = mlGrab.grab(v, true);
      stats.grabMs = ema(stats.grabMs, dt);
      cam.sig = signatureOf(img.data, ML_SIZE, ML_SIZE);
      finderDetect(img).then((q) => {
        live.mlQuad = q;
        countLook();
        if (!cam.stream) return;
        // When the AI sees no page, a fresh classical result fills in.
        onDetect(q || (performance.now() - live.cvAt < 400 ? live.cvQuad : null));
      }).finally(() => { live.mlBusy = false; pump(); });
    }
  }

  function countLook() {
    const now = performance.now();
    if (!stats.since) stats.since = now;
    stats.looks++;
    if (now - stats.since >= 1000) {
      stats.lookHz = ema(stats.lookHz, (stats.looks * 1000) / (now - stats.since));
      stats.looks = 0;
      stats.since = now;
    }
  }

  // Outline smoothing (a One Euro filter): when the corners barely move it averages strongly, so the
  // outline doesn't shake; when they move fast it hardly averages, so the outline doesn't trail the page.
  // All corners share one setting so the outline keeps its shape.
  const euro = { x: null, dx: null, t: 0 };
  function euroReset() { euro.x = null; }
  function euroStep(q, now) {
    let v = q;
    if (euro.x) {
      // keep the corner numbering of the outline on screen
      const prev = [[euro.x[0], euro.x[1]], [euro.x[2], euro.x[3]], [euro.x[4], euro.x[5]], [euro.x[6], euro.x[7]]];
      let best = Infinity;
      for (const order of [q, [q[0], q[3], q[2], q[1]]]) {
        for (let k = 0; k < 4; k++) {
          const r = [0, 1, 2, 3].map((i) => order[(i + k) % 4]);
          const d = maxDelta(r, prev);
          if (d < best) { best = d; v = r; }
        }
      }
    }
    const x = [v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1], v[3][0], v[3][1]];
    if (!euro.x) { euro.x = x; euro.dx = new Array(8).fill(0); euro.t = now; }
    else {
      const dt = Math.max(0.004, (now - euro.t) / 1000);
      euro.t = now;
      const alpha = (cut) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
      const E = TUNE.euro, ad = alpha(E.dcut);
      let speed = 0;
      for (let i = 0; i < 8; i++) {
        euro.dx[i] += ad * ((x[i] - euro.x[i]) / dt - euro.dx[i]);
        speed = Math.max(speed, Math.abs(euro.dx[i]));
      }
      const a = alpha((cam.sides >= 3 ? E.firm : E.min) + E.beta * speed);
      for (let i = 0; i < 8; i++) euro.x[i] += a * (x[i] - euro.x[i]);
    }
    const e = euro.x;
    return [[e[0], e[1]], [e[2], e[3]], [e[4], e[5]], [e[6], e[7]]];
  }

  // Every screen refresh the outline glides the last bit toward the smoothed corners.
  function animate(now) {
    cam.raf = requestAnimationFrame(animate);
    if (live.useRaf) { live.frame++; pump(); }
    if (cam.synced) watchSync(now);
    // camera frames a second (shown in the footer)
    if (!live.rateAt || live.frame < live.rateFrame) { live.rateAt = now; live.rateFrame = live.frame; }
    else if (now - live.rateAt >= 2000) {
      stats.camHz = ema(stats.camHz, ((live.frame - live.rateFrame) * 1000) / (now - live.rateAt));
      live.rateAt = now; live.rateFrame = live.frame;
    }
    const dt = cam.lastAnim ? Math.min(100, now - cam.lastAnim) : 16;
    cam.lastAnim = now;
    let target = cam.lastQuad ? cam.target : null;
    const mo = cam.motion;
    if (target && mo.v && tracker.state === "ready") {
      const ahead = clamp(live.frame - mo.f, 0, 2) + TUNE.lead;
      target = target.map((c, i) => [c[0] + mo.v[i][0] * ahead, c[1] + mo.v[i][1] * ahead]);
    }
    if (!target) {
      if (cam.shown) { cam.shown = null; drawQuad(null, false); }
      return;
    }
    if (!cam.shown) cam.shown = target.map((p) => p.slice());
    else if (maxDelta(cam.shown, target) > 0.0002) cam.shown = lerpQuad(cam.shown, target, TUNE.showMs > 0 ? 1 - Math.exp(-dt / TUNE.showMs) : 1);
    else if (cam.drawnSteady === cam.showSteady) return;
    if (cam.synced && cam.drawnSteady !== cam.showSteady) tracker.worker.postMessage({ type: "look", steady: cam.showSteady });
    cam.drawnSteady = cam.showSteady;
    drawQuad(cam.shown, cam.showSteady);
  }

  // A 24 x 24 brightness sketch of the frame, used to notice the page being turned.
  function signatureOf(data, w, h) {
    const out = new Uint8Array(576);
    for (let gy = 0, j = 0; gy < 24; gy++) {
      const y0 = Math.floor((gy * h) / 24), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / 24));
      for (let gx = 0; gx < 24; gx++, j++) {
        const x0 = Math.floor((gx * w) / 24), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / 24));
        let s = 0, n = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * w + x) * 4;
            s += data[i] * 3 + data[i + 1] * 6 + data[i + 2];
            n++;
          }
        }
        out[j] = n ? s / (10 * n) : 0;
      }
    }
    return out;
  }
  function sigDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  function onDetect(quad) {
    const now = performance.now();
    if (quad) {
      // Steady means the corners stay within STEADY of where they were when the hold began.
      if (!cam.anchor || maxDelta(cam.anchor, quad) > STEADY) { cam.anchor = quad; cam.steadySince = now; }
      if (!cam.lastQuad) euroReset();
      cam.lastQuad = quad;
      cam.lastQuadAt = now;
      cam.target = euroStep(quad, now);
      cam.misses = 0;
      cam.lostSince = 0;
    } else {
      cam.misses++;
      if (cam.misses >= 2) { cam.anchor = null; cam.steadySince = 0; }   // one missed look doesn't restart the hold
      if (cam.misses >= 3) { cam.lastQuad = null; if (!cam.lostSince) cam.lostSince = now; }
    }
    // After a capture, wait until the scene changes (page turned, hand passed over, page lifted).
    if (!cam.armed && now - cam.capturedAt > COOLDOWN_MS) {
      if (cam.misses >= 3 || sigDiff(cam.sig, cam.capturedSig) > 14) cam.armed = true;
    }
    const auto = autoOn();
    const progress = auto && cam.armed && cam.lastQuad && cam.steadySince && cam.inFlight < MAX_IN_FLIGHT
      ? Math.min(1, (now - cam.steadySince) / HOLD_MS) : 0;
    cam.showSteady = progress > 0;
    setRing(progress);
    if (progress >= 1) { captureFromCamera(); return; }
    let hint;
    if (!cam.lastQuad) hint = cam.cut ? "Move back to fit the whole page" : cam.lostSince && now - cam.lostSince > 3000 ? "No page found. Try a darker background, or tap the shutter" : "Point the camera at a page";
    else if (!cam.armed && auto) hint = "Captured. Turn to the next page";
    else if (auto) hint = cam.steadySince ? "Hold steady…" : "Page found";
    else hint = "Page found. Tap the shutter";
    setHint(hint);
  }

  function drawQuad(q, steady) {
    if (!q || cam.viewing) { el.quadPoly.setAttribute("points", ""); return; }
    const W = el.video.videoWidth || 1, H = el.video.videoHeight || 1;
    el.quadPoly.setAttribute("points", q.map(([x, y]) => `${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(" "));
    el.quadPoly.classList.toggle("steady", steady);
  }
  function setRing(p) { el.ringArc.style.strokeDashoffset = String(RING * (1 - p)); }

  function flash() {
    el.flash.hidden = true;
    void el.flash.offsetWidth;   // restart the animation
    el.flash.hidden = false;
    setTimeout(() => { el.flash.hidden = true; }, 260);
  }

  async function captureFromCamera() {
    if (engine.state !== "ready") { toast("The scanner is still loading."); return; }
    if (!cam.stream || !S.batch || cam.inFlight >= MAX_IN_FLIGHT) return;
    const now = performance.now();
    const previewQuad = cam.lastQuad && now - cam.lastQuadAt < 500 ? cam.lastQuad.map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)]) : null;
    cam.armed = false;
    cam.capturedAt = now;
    cam.capturedSig = cam.sig;
    cam.steadySince = 0;
    cam.anchor = null;
    cam.showSteady = false;
    setRing(0);
    flash();
    try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) { /* no vibration */ }
    let bitmap;
    try { bitmap = await createImageBitmap(el.video); }
    catch (_) { toast("That frame couldn't be captured. Try again."); return; }
    // Ask the AI page finder about this exact frame. The steady outline from the live view goes along
    // as a second opinion; the engine keeps whichever outline best matches the paper's edges.
    const hint = finder.state === "ready" ? await findPage(bitmap) : null;
    const looks = hint ? await secondLooks(bitmap, hint) : [];
    await processCapture(bitmap, hint, previewQuad, looks);
  }

  async function importFiles(files) {
    if (!S.batch) return;
    if (engine.state !== "ready") { toast("The scanner is still loading. Try again in a moment."); return; }
    let done = 0, failed = 0;
    for (const f of files) {
      if (!/^image\//.test(f.type || "") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || "")) { failed++; continue; }
      let bitmap;
      try { bitmap = await createImageBitmap(f); }
      catch (_) { failed++; continue; }
      const hint = await findPage(bitmap);
      const looks = hint ? await secondLooks(bitmap, hint) : [];
      if (await processCapture(bitmap, hint, null, looks)) done++; else failed++;
    }
    toast(`Imported ${plural(done, "page", "pages")}` + (failed ? `. ${failed} couldn't be read.` : "."));
  }

  async function processCapture(bitmap, hint, live = null, looks = []) {
    const batch = S.batch;
    const page = { id: uid(), batchId: batch.id, createdAt: Date.now(), filter: defaultFilter(), rotation: 0, flat: true, status: "processing" };
    // Retake: the new page takes the old page's place.
    const retake = S.retake && batch.pageIds.includes(S.retake.id) ? S.retake : null;
    S.retake = null;
    if (retake) {
      const at = batch.pageIds.indexOf(retake.id);
      batch.pageIds.splice(at, 1, page.id);
      page.filter = retake.filter || page.filter;
    } else {
      batch.pageIds.push(page.id);
    }
    S.pages.set(page.id, page);
    cam.inFlight++;
    setEase();
    updateCounter();
    if (S.screen === "review") renderReview();
    try {
      const t0 = performance.now();
      const r = await engine.call("capture", { bitmap, hint, live, looks, filter: page.filter, flatten: page.flat, debug: !!window.__auditScanDebug }, [bitmap]);
      stats.pageMs = ema(stats.pageMs, performance.now() - t0);
      if (r.cands) page.cands = r.cands;
      Object.assign(page, {
        status: "ready", frame: r.frameBlob, frameW: r.frameW, frameH: r.frameH, quad: r.quad, auto: r.auto, pick: r.pick, flatInfo: r.flat,
        warped: r.warpedBlob, output: r.outputBlob, thumb: r.thumbBlob, w: r.w, h: r.h,
      });
      if (S.batch !== batch || !batch.pageIds.includes(page.id)) return false;   // discarded meanwhile
      await DB.put("pages", page);
      if (retake) {
        S.pages.delete(retake.id);
        dropThumb(retake.id);
        await DB.del("pages", retake.id).catch(() => {});
      }
      batch.updatedAt = Date.now();
      await saveBatch();
      setThumb(page);
      if (retake) {
        toast(`Page ${batch.pageIds.indexOf(page.id) + 1} replaced.`);
        if (S.screen === "camera") show("review");
      } else if (S.screen === "camera") {
        offerUndo(page.id);
      }
      if (!r.auto) toast("No page edges found, so the whole photo was kept. You can crop it in Review.");
      return true;
    } catch (err) {
      if (retake) {
        const at = batch.pageIds.indexOf(page.id);
        if (at >= 0) batch.pageIds.splice(at, 1, retake.id);
      } else {
        batch.pageIds = batch.pageIds.filter((x) => x !== page.id);
      }
      S.pages.delete(page.id);
      await saveBatch().catch(() => {});
      toast(storageErr(err) || "That page couldn't be processed. Try again.");
      return false;
    } finally {
      cam.inFlight--;
      setEase();
      updateCounter();
      if (S.screen === "review") renderReview();
    }
  }

  // Undo the last capture from the camera screen.
  let undoTimer = 0;
  function offerUndo(id) {
    clearTimeout(undoTimer);
    const n = S.batch.pageIds.indexOf(id) + 1;
    el.undoText.textContent = `Page ${n} saved`;
    el.btnUndo.onclick = async () => {
      el.undoBar.hidden = true;
      if (await removePage(id)) toast(`Page ${n} removed.`);
    };
    el.undoBar.hidden = false;
    undoTimer = setTimeout(() => { el.undoBar.hidden = true; }, UNDO_MS);
  }

  // Remove one page from the open batch (Review ×, editor Delete, camera Undo).
  async function removePage(id) {
    const b = S.batch;
    if (!b || !b.pageIds.includes(id)) return false;
    b.pageIds = b.pageIds.filter((x) => x !== id);
    S.pages.delete(id);
    dropThumb(id);
    await DB.del("pages", id).catch(() => {});
    b.updatedAt = Date.now();
    await saveBatch().catch(() => {});
    updateCounter();
    if (S.screen === "review") renderReview();
    return true;
  }

  // Camera mode strip: the scan mode new pages get.
  function renderModes() {
    const cur = defaultFilter();
    for (const b of el.modeStrip.children) {
      const on = b.dataset.filter === cur;
      b.setAttribute("aria-pressed", String(on));
      if (on && S.screen === "camera") b.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }
  function fillModes() {
    el.modeStrip.replaceChildren(...FILTERS.map((f) => {
      const b = node("button", "mode-btn", f.label);
      b.type = "button";
      b.dataset.filter = f.value;
      b.addEventListener("click", () => {
        ls.set("as.filter", f.value);
        renderModes();
      });
      return b;
    }));
  }

  function setThumb(p) {
    const old = S.urls.get(p.id);
    if (old) URL.revokeObjectURL(old);
    if (p.thumb) S.urls.set(p.id, URL.createObjectURL(p.thumb)); else S.urls.delete(p.id);
  }
  function dropThumb(id) {
    const u = S.urls.get(id);
    if (u) URL.revokeObjectURL(u);
    S.urls.delete(id);
  }

  function updateCounter() {
    const ids = S.batch ? S.batch.pageIds : [];
    el.pageCount.textContent = String(ids.length);
    let url = null;
    for (let i = ids.length - 1; i >= 0 && !url; i--) url = S.urls.get(ids[i]) || null;
    if (url) { el.thumbImg.src = url; el.thumbImg.hidden = false; }
    else { el.thumbImg.hidden = true; el.thumbImg.removeAttribute("src"); }
  }

  /* ---------- Review ---------- */
  function renderReview() {
    const b = S.batch;
    if (!b) { el.grid.replaceChildren(); el.reviewEmpty.hidden = false; el.btnSave.disabled = true; return; }
    const n = b.pageIds.length;
    el.reviewMeta.textContent = [b.client, areaOf(b.area).short || "Mixed", plural(n, "page", "pages")].join(" · ");
    el.grid.replaceChildren(...b.pageIds.map((id, i) => tile(S.pages.get(id), i)).filter(Boolean));
    el.reviewEmpty.hidden = n > 0;
    el.btnSave.disabled = !n || b.pageIds.some((id) => (S.pages.get(id) || {}).status !== "ready");
  }

  function tile(p, i) {
    if (!p) return null;
    const li = node("li", "tile");
    const btn = node("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Page ${i + 1}${p.auto === false ? ", not cropped" : ""}. Open to edit.`);
    const frame = node("div", "frame");
    const url = S.urls.get(p.id);
    if (p.status === "ready" && url) {
      const img = new Image();
      img.src = url; img.alt = ""; img.decoding = "async";
      frame.append(img);
    } else {
      frame.append(node("span", "spinner"));
    }
    const cap = node("div", "cap");
    cap.append(node("span", null, `p. ${i + 1}`));
    cap.append(p.auto === false ? node("span", "flag", "Not cropped") : node("span", null, filterLabel(p.filter)));
    btn.append(frame, cap);
    btn.addEventListener("click", () => { if (p.status === "ready") openEditor(p.id); });
    li.append(btn);
    // Delete straight from the grid: tap ×, then tap again to confirm.
    if (p.status === "ready") {
      const del = node("button", "tile-del", "×");
      del.type = "button";
      del.setAttribute("aria-label", `Delete page ${i + 1}`);
      let armed = false, t = 0;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.textContent = "Delete?";
          del.classList.add("armed");
          del.setAttribute("aria-label", `Tap again to delete page ${i + 1}`);
          t = setTimeout(() => { armed = false; del.textContent = "×"; del.classList.remove("armed"); del.setAttribute("aria-label", `Delete page ${i + 1}`); }, 3500);
          return;
        }
        clearTimeout(t);
        if (await removePage(p.id)) toast(`Page ${i + 1} deleted.`);
      });
      li.append(del);
    }
    return li;
  }

  /* ---------- Page editor ---------- */
  let edUrl = null, cropUrl = null, drag = null;
  const curPage = () => (S.editor ? S.pages.get(S.editor.id) : null);

  function fillFilters() {
    el.filterChips.replaceChildren(...FILTERS.map((f) => {
      const b = node("button", "chip-btn", f.label);
      b.type = "button";
      b.dataset.filter = f.value;
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => setFilter(f.value));
      return b;
    }));
  }

  function openEditor(id) {
    S.editor = { id, crop: false, quad: null, busy: false, delArmed: false };
    ensureGuard();
    show("editor");
  }

  function leaveEditor() {
    if (edUrl) { URL.revokeObjectURL(edUrl); edUrl = null; }
    if (cropUrl) { URL.revokeObjectURL(cropUrl); cropUrl = null; }
    el.edImg.removeAttribute("src");
    el.cropImg.removeAttribute("src");
    S.editor = null;
  }

  function renderEditor() {
    const p = curPage();
    if (!p || !S.batch) { show("review"); return; }
    const ed = S.editor;
    const ids = S.batch.pageIds;
    const idx = ids.indexOf(p.id);
    el.edTitle.textContent = `Page ${idx + 1} of ${ids.length}`;
    const flattened = p.flat === true && p.flatInfo && p.flatInfo.applied;
    el.edMeta.textContent = [filterLabel(p.filter), flattened ? "flattened" : "", p.rotation ? `rotated ${p.rotation}°` : "",
      p.auto === false ? "not cropped" : ""].filter(Boolean).join(" · ");
    if (edUrl) URL.revokeObjectURL(edUrl);
    edUrl = URL.createObjectURL(p.output);
    el.edImg.src = edUrl;
    el.edImg.alt = `Page ${idx + 1}`;
    const pf = normFilter(p.filter);
    for (const b of el.filterChips.children) b.setAttribute("aria-pressed", String(b.dataset.filter === pf));
    el.btnApplyAll.hidden = ids.length < 2;
    el.btnApplyAll.textContent = `Use ${filterLabel(pf)} on all ${ids.length} pages`;
    el.btnMoveUp.disabled = idx <= 0;
    el.btnMoveDown.disabled = idx >= ids.length - 1;
    el.btnCrop.disabled = !p.frame;
    el.btnFlatten.disabled = !p.frame || p.auto === false;
    el.btnFlatten.setAttribute("aria-pressed", String(p.flat === true));
    el.edTools.hidden = ed.crop;
    el.cropBar.hidden = !ed.crop;
    el.cropWrap.hidden = !ed.crop;
    el.edImg.hidden = ed.crop;
    el.btnEdDelete.textContent = ed.delArmed ? "Tap again" : "Delete";
  }

  function setBusy(on) {
    if (S.editor) S.editor.busy = on;
    el.edBusy.hidden = !on;
  }

  async function rerender(p, changes, recrop) {
    if (!S.editor || S.editor.busy) return;
    setBusy(true);
    try {
      const next = Object.assign({}, p, changes);
      const req = recrop
        ? { frameBlob: p.frame, quad: next.quad, rotation: next.rotation, filter: next.filter, flatten: next.flat === true }
        : { warpedBlob: p.warped, rotation: next.rotation, filter: next.filter };
      const r = await engine.call("render", req);
      Object.assign(p, changes, { output: r.outputBlob, thumb: r.thumbBlob, w: r.w, h: r.h });
      if (r.warpedBlob) { p.warped = r.warpedBlob; p.flatInfo = r.flat; }
      await DB.put("pages", p);
      setThumb(p);
      if (S.screen === "editor") renderEditor();
    } catch (err) {
      toast(storageErr(err) || "That change couldn't be applied. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function setFilter(f) {
    const p = curPage();
    if (!p || normFilter(p.filter) === f) return;
    ls.set("as.filter", f);   // new pages use the last mode chosen
    rerender(p, { filter: f }, false);
  }

  // Apply the current page's mode to every page in the batch.
  async function applyAll() {
    const p = curPage();
    if (!p || !S.editor || S.editor.busy) return;
    const f = normFilter(p.filter);
    const targets = S.batch.pageIds.map((id) => S.pages.get(id)).filter((x) => x && x.status === "ready" && x.warped && normFilter(x.filter) !== f);
    if (!targets.length) { toast(`All pages already use ${filterLabel(f)}.`); return; }
    setBusy(true);
    let done = 0;
    try {
      for (const t of targets) {
        el.edMeta.textContent = `Applying ${filterLabel(f)}… ${done + 1} of ${targets.length}`;
        const r = await engine.call("render", { warpedBlob: t.warped, rotation: t.rotation, filter: f });
        Object.assign(t, { filter: f, output: r.outputBlob, thumb: r.thumbBlob, w: r.w, h: r.h });
        await DB.put("pages", t);
        setThumb(t);
        done++;
      }
      toast(`${filterLabel(f)} applied to ${plural(done, "more page", "more pages")}.`);
    } catch (err) {
      toast(storageErr(err) || `Stopped after ${plural(done, "page", "pages")}. Try again.`);
    } finally {
      setBusy(false);
      if (S.screen === "editor") renderEditor();
    }
  }

  // Retake: go back to the camera; the next capture replaces this page in the same position.
  function retakePage() {
    const p = curPage();
    if (!p || !S.editor || S.editor.busy) return;
    S.retake = { id: p.id, filter: p.filter };
    show("camera");
    toast("Retake: the next page you capture replaces this one.");
  }
  // Flatten on/off for this page (on by default). Re-crops from the stored photo.
  function toggleFlatten() {
    const p = curPage();
    if (!p || !p.frame || !S.editor || S.editor.busy) return;
    const on = p.flat !== true;
    rerender(p, { flat: on }, true).then(() => {
      if (!S.editor || curPage() !== p) return;
      if (on) toast(p.flatInfo && p.flatInfo.applied ? "Page flattened." : "This page already looks flat, so nothing changed.");
      else toast("Flattening off for this page.");
    });
  }
  function rotatePage() {
    const p = curPage();
    if (p) rerender(p, { rotation: ((p.rotation || 0) + 90) % 360 }, false);
  }

  async function movePage(dir) {
    const p = curPage();
    if (!p) return;
    const ids = S.batch.pageIds;
    const i = ids.indexOf(p.id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await saveBatch().catch(() => {});
    renderEditor();
  }

  let delTimer = 0;
  async function deletePage() {
    const p = curPage();
    if (!p || !S.editor) return;
    if (!S.editor.delArmed) {
      S.editor.delArmed = true;
      renderEditor();
      delTimer = setTimeout(() => { if (S.editor) { S.editor.delArmed = false; renderEditor(); } }, 3500);
      return;
    }
    clearTimeout(delTimer);
    const idx = S.batch.pageIds.indexOf(p.id);
    await removePage(p.id);
    const nextId = S.batch.pageIds[Math.min(idx, S.batch.pageIds.length - 1)];
    toast(`Page ${idx + 1} deleted.`);
    if (nextId) { S.editor = { id: nextId, crop: false, quad: null, busy: false, delArmed: false }; renderEditor(); }
    else goBack();
  }

  // Crop: drag the corners on the original photo.
  function enterCrop() {
    const p = curPage();
    if (!p || !p.frame || S.editor.busy) return;
    S.editor.crop = true;
    S.editor.quad = (p.quad || FULL).map((pt) => pt.slice());
    if (cropUrl) URL.revokeObjectURL(cropUrl);
    cropUrl = URL.createObjectURL(p.frame);
    el.cropImg.src = cropUrl;
    el.cropSvg.setAttribute("viewBox", `0 0 ${p.frameW} ${p.frameH}`);
    el.cropHandles.replaceChildren(...[0, 1, 2, 3].map(() => svgEl("circle", { class: "handle" })));
    renderEditor();
    requestAnimationFrame(drawCrop);
  }
  function exitCrop() {
    if (!S.editor) return;
    S.editor.crop = false;
    S.editor.quad = null;
    drag = null;
    renderEditor();
  }
  function drawCrop() {
    const p = curPage(), q = S.editor && S.editor.quad;
    if (!p || !q) return;
    const pts = q.map(([x, y]) => [x * p.frameW, y * p.frameH]);
    el.cropPoly.setAttribute("points", pts.map((a) => a.map((v) => v.toFixed(1)).join(",")).join(" "));
    const ctm = el.cropSvg.getScreenCTM();
    const unit = ctm && ctm.a ? 1 / ctm.a : 1;
    [...el.cropHandles.children].forEach((c, i) => {
      c.setAttribute("cx", pts[i][0]);
      c.setAttribute("cy", pts[i][1]);
      c.setAttribute("r", (drag && drag.i === i ? 18 : 13) * unit);
    });
  }
  function svgPoint(e) {
    const pt = el.cropSvg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(el.cropSvg.getScreenCTM().inverse());
  }
  function onCropDown(e) {
    const p = curPage(), q = S.editor && S.editor.quad;
    if (!p || !q) return;
    const pt = svgPoint(e);
    const ctm = el.cropSvg.getScreenCTM();
    const unit = ctm && ctm.a ? 1 / ctm.a : 1;
    let best = -1, bestD = 56 * unit;
    q.forEach(([x, y], i) => {
      const d = Math.hypot(x * p.frameW - pt.x, y * p.frameH - pt.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    drag = { i: best, id: e.pointerId };
    el.cropSvg.setPointerCapture(e.pointerId);
    e.preventDefault();
    drawCrop();
  }
  function onCropMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const p = curPage();
    const pt = svgPoint(e);
    S.editor.quad[drag.i] = [clamp(pt.x / p.frameW, 0, 1), clamp(pt.y / p.frameH, 0, 1)];
    drawCrop();
  }
  function onCropUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    drawCrop();
  }
  // Detect: the best outline first; tapping again steps through the other outlines found.
  async function cropDetect() {
    const p = curPage();
    if (!p || S.editor.busy) return;
    const ed = S.editor;
    if (!ed.detected) {
      setBusy(true);
      try {
        let hint = null, looks = [];
        if (finder.state === "ready") {
          const s = Math.min(1, 1280 / Math.max(p.frameW || 1280, p.frameH || 1280));
          const bmp = p.frameW
            ? await createImageBitmap(p.frame, { resizeWidth: Math.round(p.frameW * s), resizeHeight: Math.round(p.frameH * s), resizeQuality: "medium" })
            : await createImageBitmap(p.frame);
          try {
            hint = await findPage(bmp);
            if (hint) looks = await secondLooks(bmp, hint);
          } finally { bmp.close(); }
        }
        const r = await engine.call("detectFrame", { frameBlob: p.frame, hint, looks, frameW: p.frameW, frameH: p.frameH });
        ed.detected = r.cands && r.cands.length ? r.cands : r.quad ? [r.quad] : [];
      } catch (_) {
        toast("Edge detection didn't work this time.");
        return;
      } finally {
        setBusy(false);
      }
    }
    const list = ed.detected;
    if (!list.length) { toast("No page edges found. Drag the corners by hand."); return; }
    const at = ed.quad ? list.findIndex((q) => maxDelta(q, ed.quad) < 0.006) : -1;
    ed.quad = list[at >= 0 ? (at + 1) % list.length : 0].map((pt) => pt.slice());
    drawCrop();
    if (list.length > 1) toast(at >= 0 ? `Outline ${((at + 1) % list.length) + 1} of ${list.length}. Tap Detect again for another.` : "Tap Detect again to try another outline.");
  }
  function cropFull() {
    if (!S.editor) return;
    S.editor.quad = FULL.map((pt) => pt.slice());
    drawCrop();
  }
  async function cropApply() {
    const p = curPage(), q = S.editor && S.editor.quad;
    if (!p || !q) return;
    const ordered = orderQuad(q);
    if (!quadOk(ordered)) { toast("The corners cross over. Drag each one back to a page corner."); return; }
    S.editor.crop = false;
    S.editor.quad = null;
    renderEditor();
    await rerender(p, { quad: ordered, auto: true }, true);
  }

  /* ---------- Save sheet ---------- */
  function canShareFiles() {
    try {
      const f = new File([new Blob(["%PDF-1.4"], { type: "application/pdf" })], "test.pdf", { type: "application/pdf" });
      return !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (_) { return false; }
  }

  async function loadPagesFor(batch) {
    if (S.batch && batch.id === S.batch.id) return batch.pageIds.map((id) => S.pages.get(id));
    const pages = await DB.pagesOf(batch.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    return batch.pageIds.map((id) => byId.get(id)).filter(Boolean);
  }

  async function openSave(batch, mode) {
    const job = { batch, mode, blob: null, via: "" };
    S.save = job;
    el.saveName.value = mode === "again" && batch.fileName ? batch.fileName.replace(/\.pdf$/i, "") : fileNameFor(batch);
    el.saveInfo.textContent = "Making the PDF…";
    el.btnShare.disabled = true;
    el.btnDownload.disabled = true;
    el.saveActions.hidden = false;
    el.saveDone.hidden = true;
    const share = canShareFiles();
    el.saveHelp.innerHTML = share
      ? "In the share list, tap <strong>Drive</strong>, then choose Audit Inbox and the client's folder."
      : "This browser can't hand files to Drive. Save to phone, then upload it from the Drive app.";
    el.saveSheet.hidden = false;
    ensureGuard();
    try {
      const pages = await loadPagesFor(batch);
      const parts = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        if (!p || !p.output) continue;
        el.saveInfo.textContent = `Making the PDF… page ${i + 1} of ${pages.length}`;
        parts.push({ bytes: new Uint8Array(await p.output.arrayBuffer()), w: p.w, h: p.h });
      }
      const blob = PDF.build(parts, { title: el.saveName.value });
      if (S.save !== job) return;
      job.blob = blob;
      job.pageCount = parts.length;
      window.__auditScanLastPdf = blob;    // read by the automated test
      el.saveInfo.textContent = `${plural(parts.length, "page", "pages")} · ${mb(blob.size)}`;
      el.btnShare.disabled = !share;
      el.btnDownload.disabled = false;
    } catch (err) {
      if (S.save === job) el.saveInfo.textContent = "The PDF couldn't be made: " + ((err && err.message) || err);
    }
  }

  function currentFileName() {
    const base = cleanName(el.saveName.value).replace(/\.pdf$/i, "") || "Scan";
    return base + ".pdf";
  }

  async function shareToDrive() {
    const job = S.save;
    if (!job || !job.blob) return;
    const name = currentFileName();
    const file = new File([job.blob], name, { type: "application/pdf" });
    try {
      await navigator.share({ files: [file], title: name });
      job.via = "drive";
      showSaveDone(job, name);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      toast("The share list couldn't open" + (err && err.name ? ` (${err.name})` : "") + ". Use Save to phone instead.");
    }
  }

  function downloadPdf() {
    const job = S.save;
    if (!job || !job.blob) return;
    const name = currentFileName();
    const url = URL.createObjectURL(job.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    job.via = "phone";
    showSaveDone(job, name);
  }

  function showSaveDone(job, name) {
    job.fileName = name;
    el.saveActions.hidden = true;
    el.saveDone.hidden = false;
    if (job.mode === "open") {
      el.saveDoneText.textContent = job.via === "drive"
        ? `Sent “${name}”. In Drive, check it's in Audit Inbox under the client's folder.`
        : `Saved “${name}” to your phone's Downloads.`;
      el.btnNewBatch.hidden = false;
      el.btnKeepBatch.textContent = "Keep this batch open";
    } else {
      el.saveDoneText.textContent = job.via === "drive" ? `Sent “${name}” again.` : `Saved “${name}” to your phone's Downloads.`;
      el.btnNewBatch.hidden = true;
      el.btnKeepBatch.textContent = "Close";
    }
  }

  function closeSave() {
    el.saveSheet.hidden = true;
    S.save = null;
  }

  async function finishBatch() {
    const job = S.save;
    const b = S.batch;
    if (!job || !b || job.batch.id !== b.id) { closeSave(); return; }
    b.status = "saved";
    b.savedAt = Date.now();
    b.fileName = job.fileName;
    b.savedVia = job.via;
    b.pageCount = b.pageIds.length;
    try {
      // Keep only the finished pages; drop the original photos and crops to free space.
      for (const id of b.pageIds) {
        const p = S.pages.get(id);
        if (p) { delete p.frame; delete p.warped; await DB.put("pages", p); }
      }
      await DB.put("batches", { ...b, pageIds: [...b.pageIds] });
    } catch (err) {
      toast(storageErr(err) || "The batch couldn't be closed: " + err.message);
      return;
    }
    S.saved.push({ ...b, pageIds: [...b.pageIds] });
    clearBatchState();
    closeSave();
    if (S.screen !== "setup") goBack(); else renderSetup();
    toast("Batch saved. Ready for the next one.");
  }

  /* ---------- Updates ---------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offer = (w) => {
        el.updateBar.hidden = false;
        el.btnUpdate.onclick = () => { el.btnUpdate.disabled = true; w.postMessage("skipWaiting"); };
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) offer(nw);
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => { /* offline install not available */ });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  /* ---------- Boot ---------- */
  async function loadBatch(b) {
    const pages = await DB.pagesOf(b.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    b.pageIds = (b.pageIds || []).filter((id) => byId.has(id) && byId.get(id).status === "ready");
    S.batch = b;
    S.pages = new Map();
    for (const id of b.pageIds) {
      const p = byId.get(id);
      S.pages.set(id, p);
      setThumb(p);
    }
  }

  function bind() {
    const ids = [
      "scrSetup", "scrCamera", "scrReview", "scrEditor", "engineChip", "updateBar", "btnUpdate", "batchForm", "batchState",
      "client", "clientList", "fye", "area", "note", "formMsg", "btnStart", "openBatch", "openSummary", "btnOpenReview",
      "btnDiscard", "savedList", "savedEmpty", "savedSum", "verText", "video", "preview", "overlay", "quadPoly", "flash", "hint",
      "camError", "camErrorText", "btnRetryCam", "btnCamBack", "camLabel", "btnTorch", "btnAuto", "btnThumb", "thumbImg",
      "pageCount", "btnShutter", "ringArc", "btnDone", "btnReviewBack", "reviewMeta", "reviewEmpty", "grid", "btnAddPages",
      "importInput", "btnSave", "btnEdBack", "edTitle", "edMeta", "btnEdDelete", "edImg", "cropWrap", "cropImg", "cropSvg",
      "cropPoly", "cropHandles", "edBusy", "edTools", "filterChips", "btnMoveUp", "btnCrop", "btnRotate", "btnMoveDown",
      "cropBar", "btnCropAuto", "btnCropFull", "btnCropCancel", "btnCropApply", "saveSheet", "saveName", "saveInfo",
      "saveActions", "saveHelp", "btnShare", "btnDownload", "btnSaveCancel", "saveDone", "saveDoneText", "btnNewBatch",
      "btnKeepBatch", "toast", "modeStrip", "undoBar", "undoText", "btnUndo", "btnApplyAll", "btnRetake", "btnDeleteAllSaved", "btnFlatten",
    ];
    for (const id of ids) {
      el[id] = $(id);
      if (!el[id]) throw new Error("Missing element #" + id);
    }

    el.batchForm.addEventListener("submit", (e) => { e.preventDefault(); onStart(); });
    for (const f of [el.client, el.fye, el.area, el.note]) { f.addEventListener("input", onField); f.addEventListener("change", onField); }
    el.note.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onStart(); } });
    el.btnStart.addEventListener("click", onStart);
    el.btnOpenReview.addEventListener("click", () => { ensureGuard(); show("review"); });
    el.btnDiscard.addEventListener("click", onDiscard);

    el.btnCamBack.addEventListener("click", goBack);
    el.btnRetryCam.addEventListener("click", () => { el.camError.hidden = true; startCamera(); });
    el.btnTorch.addEventListener("click", toggleTorch);
    el.btnAuto.setAttribute("aria-pressed", ls.get("as.auto", "true"));
    el.btnAuto.textContent = autoOn() ? "Auto" : "Manual";
    el.btnAuto.addEventListener("click", () => {
      const next = !autoOn();
      el.btnAuto.setAttribute("aria-pressed", String(next));
      el.btnAuto.textContent = next ? "Auto" : "Manual";
      ls.set("as.auto", String(next));
      cam.steadySince = 0;
      setRing(0);
    });
    el.btnShutter.addEventListener("click", () => { cam.armed = true; captureFromCamera(); });
    el.btnThumb.addEventListener("click", () => show("review"));
    el.btnDone.addEventListener("click", () => show("review"));
    el.video.addEventListener("resize", sizeOverlay);

    el.btnReviewBack.addEventListener("click", goBack);
    el.btnAddPages.addEventListener("click", () => show("camera"));
    el.importInput.addEventListener("change", () => {
      const files = Array.from(el.importInput.files || []);
      el.importInput.value = "";
      if (files.length) importFiles(files);
    });
    el.btnSave.addEventListener("click", () => { if (S.batch) openSave(S.batch, "open"); });

    el.btnEdBack.addEventListener("click", () => { if (S.editor && S.editor.crop) exitCrop(); else goBack(); });
    el.btnEdDelete.addEventListener("click", deletePage);
    el.btnRetake.addEventListener("click", retakePage);
    el.btnApplyAll.addEventListener("click", applyAll);
    el.btnDeleteAllSaved.addEventListener("click", onDeleteAllSaved);
    el.btnRotate.addEventListener("click", rotatePage);
    el.btnFlatten.addEventListener("click", toggleFlatten);
    el.btnCrop.addEventListener("click", enterCrop);
    el.btnMoveUp.addEventListener("click", () => movePage(-1));
    el.btnMoveDown.addEventListener("click", () => movePage(1));
    el.btnCropAuto.addEventListener("click", cropDetect);
    el.btnCropFull.addEventListener("click", cropFull);
    el.btnCropCancel.addEventListener("click", exitCrop);
    el.btnCropApply.addEventListener("click", cropApply);
    el.cropSvg.addEventListener("pointerdown", onCropDown);
    el.cropSvg.addEventListener("pointermove", onCropMove);
    el.cropSvg.addEventListener("pointerup", onCropUp);
    el.cropSvg.addEventListener("pointercancel", onCropUp);
    window.addEventListener("resize", () => { if (S.editor && S.editor.crop) drawCrop(); sizeView(); });

    el.btnShare.addEventListener("click", shareToDrive);
    el.btnDownload.addEventListener("click", downloadPdf);
    el.btnSaveCancel.addEventListener("click", closeSave);
    el.btnNewBatch.addEventListener("click", finishBatch);
    el.btnKeepBatch.addEventListener("click", closeSave);
    el.saveSheet.addEventListener("click", (e) => { if (e.target === el.saveSheet) closeSave(); });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopCamera();
      else if (S.screen === "camera") startCamera();
    });
  }

  async function boot() {
    bind();
    fillAreas();
    fillFilters();
    fillModes();
    renderVersion();
    engine.start();
    finder.start();
    startTracker();
    renderEngine();
    registerSW();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* best effort */ }
    try {
      const all = await DB.getAll("batches");
      S.saved = all.filter((b) => b.status === "saved");
      const open = all.filter((b) => b.status === "open").sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (open) await loadBatch(open);
    } catch (err) {
      toast("Saved scans couldn't be loaded: " + ((err && err.message) || err), 8000);
    }
    show("setup");
  }

  // Read by the automated tests; debugSlow makes the AI and the live outline take longer, like a slower phone.
  window.__auditScan = {
    S, engine, finder, cam, live, stats, tracker, TUNE,
    debugSlow(mlMs, liveMs, trace, fuzz, read) {
      if (finder.worker) finder.worker.postMessage({ type: "debug", minMs: mlMs || 0, fuzz: fuzz || null });
      if (tracker.worker) tracker.worker.postMessage({ type: "debug", liveMs: liveMs || 0, trace: !!trace, read: read || "" });
      if (trace) tracker.trace = [];
    },
  };
  boot().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML("afterbegin", '<p style="padding:16px">Audit Scan failed to start. Reload the page.</p>');
  });
})();
