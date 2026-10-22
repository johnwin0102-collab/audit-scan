/* Audit Scan: phone document scanner for audit fieldwork.
   Camera -> page edges (worker) -> cropped, enhanced pages -> one PDF per batch -> Save to Drive. */
/* global DB, PDF */
"use strict";

(() => {
  const VERSION = "1.0.0";

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
  const FILTERS = [
    { value: "enhanced", label: "Enhanced" },
    { value: "original", label: "Original" },
    { value: "grey", label: "Grey" },
    { value: "bw", label: "B&W" },
  ];
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const DETECT_EDGE = 420;     // px, preview frame used for edge detection
  const HOLD_MS = 900;         // page must be steady this long before an automatic capture
  const STEADY = 0.022;        // corner movement (share of the frame) still counted as steady
  const COOLDOWN_MS = 1200;    // minimum gap between automatic captures
  const MAX_IN_FLIGHT = 2;     // captures being processed at once
  const KEEP_DAYS = 14;        // saved batches are kept this long
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
  const filterLabel = (v) => (FILTERS.find((f) => f.value === v) || FILTERS[0]).label;
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
    saved: [],            // saved batches (kept 14 days)
    save: null,           // the save sheet's job
    editor: null,         // { id, crop, quad, busy, delArmed }
  };

  /* ---------- Image engine (Web Worker) ---------- */
  const engine = {
    worker: null, seq: 0, pending: new Map(), state: "loading",
    start() {
      try { this.worker = new Worker("cv-worker.js"); }
      catch (e) { this.fail(e); return; }
      this.worker.onmessage = (e) => {
        const { id, ok, result, error } = e.data || {};
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (ok) p.resolve(result); else p.reject(new Error(error));
      };
      this.worker.onerror = (e) => { e.preventDefault(); this.fail(e); };
      this.call("init").then(() => { this.state = "ready"; renderEngine(); }, (e) => this.fail(e));
    },
    call(type, payload = {}, transfer = []) {
      if (!this.worker || this.state === "failed") return Promise.reject(new Error("The scanner engine isn't running."));
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage(Object.assign({ id, type }, payload), transfer);
      });
    },
    fail(e) {
      console.error("Scanner engine failed", e);
      this.state = "failed";
      for (const p of this.pending.values()) p.reject(new Error("The scanner engine stopped."));
      this.pending.clear();
      renderEngine();
    },
  };

  function renderEngine() {
    const st = engine.state;
    el.engineChip.className = "chip" + (st === "ready" ? " is-ok" : st === "failed" ? " is-bad" : "");
    el.engineChip.textContent = st === "ready" ? "Scanner ready" : st === "failed" ? "Scanner didn't load" : "Loading scanner";
    el.btnShutter.disabled = st !== "ready";
    if (st === "failed") toast("The scanner engine didn't load. Check your connection, then close and reopen the app.", 8000);
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
    });
    act.append(again, del);
    li.append(main, act);
    return li;
  }

  /* ---------- Camera ---------- */
  const cam = {
    stream: null, track: null, torch: false, raf: 0, busy: false, wakeLock: null, res: "",
    det: document.createElement("canvas"), sigC: document.createElement("canvas"),
    lastQuad: null, lastQuadAt: 0, shown: null, steadySince: 0, misses: 0,
    armed: true, capturedSig: null, capturedAt: 0, sig: null, inFlight: 0, starting: false,
  };
  const detCtx = cam.det.getContext("2d", { willReadFrequently: true });
  cam.sigC.width = cam.sigC.height = 24;
  const sigCtx = cam.sigC.getContext("2d", { willReadFrequently: true });

  const autoOn = () => el.btnAuto.getAttribute("aria-pressed") === "true";

  function setHint(t) { if (el.hint.textContent !== t) el.hint.textContent = t; }

  function renderCamLabel() {
    const b = S.batch;
    el.camLabel.textContent = b ? [b.client, areaOf(b.area).short].filter(Boolean).join(" · ") : "";
  }

  async function startCamera() {
    renderCamLabel();
    updateCounter();
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
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30, max: 30 } },
      });
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
  }

  function stopCamera() {
    cancelAnimationFrame(cam.raf);
    cam.raf = 0;
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
    cam.lastQuad = null; cam.shown = null; cam.steadySince = 0; cam.misses = 0; cam.armed = true;
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

  function loopStart() { if (!cam.raf) cam.raf = requestAnimationFrame(tick); }

  function tick() {
    cam.raf = requestAnimationFrame(tick);
    const v = el.video;
    if (cam.busy || engine.state !== "ready" || !cam.stream || v.readyState < 2 || !v.videoWidth) return;
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = DETECT_EDGE / Math.max(vw, vh);
    const w = Math.round(vw * s), h = Math.round(vh * s);
    if (cam.det.width !== w || cam.det.height !== h) { cam.det.width = w; cam.det.height = h; }
    detCtx.drawImage(v, 0, 0, w, h);
    sigCtx.drawImage(cam.det, 0, 0, 24, 24);
    cam.sig = signature(sigCtx.getImageData(0, 0, 24, 24).data);
    const img = detCtx.getImageData(0, 0, w, h);
    cam.busy = true;
    engine.call("detect", { width: w, height: h, buffer: img.data.buffer }, [img.data.buffer])
      .then((r) => { if (cam.stream) onDetect(r.quad); })
      .catch(() => {})
      .finally(() => { cam.busy = false; });
  }

  function signature(data) {
    const out = new Uint8Array(data.length / 4);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) out[j] = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
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
      const moved = cam.lastQuad ? maxDelta(cam.lastQuad, quad) : 1;
      cam.steadySince = moved < STEADY ? (cam.steadySince || now) : 0;
      cam.lastQuad = quad;
      cam.lastQuadAt = now;
      cam.misses = 0;
      cam.shown = cam.shown ? lerpQuad(cam.shown, quad, 0.55) : quad;
    } else {
      cam.misses++;
      cam.steadySince = 0;
      if (cam.misses >= 3) { cam.lastQuad = null; cam.shown = null; }
    }
    // After a capture, wait until the scene changes (page turned, hand passed over, page lifted).
    if (!cam.armed && now - cam.capturedAt > COOLDOWN_MS) {
      if (cam.misses >= 3 || sigDiff(cam.sig, cam.capturedSig) > 14) cam.armed = true;
    }
    const auto = autoOn();
    const progress = auto && cam.armed && cam.steadySince && cam.inFlight < MAX_IN_FLIGHT
      ? Math.min(1, (now - cam.steadySince) / HOLD_MS) : 0;
    drawQuad(cam.shown, progress > 0);
    setRing(progress);
    if (progress >= 1) { captureFromCamera(); return; }
    let hint;
    if (!cam.lastQuad) hint = cam.misses > 25 ? "No page found. Try a darker background, or tap the shutter" : "Point the camera at a page";
    else if (!cam.armed && auto) hint = "Captured. Turn to the next page";
    else if (auto) hint = cam.steadySince ? "Hold steady…" : "Page found";
    else hint = "Page found. Tap the shutter";
    setHint(hint);
  }

  function drawQuad(q, steady) {
    if (!q) { el.quadPoly.setAttribute("points", ""); return; }
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
    const hint = cam.lastQuad && now - cam.lastQuadAt < 500 ? cam.lastQuad : null;
    cam.armed = false;
    cam.capturedAt = now;
    cam.capturedSig = cam.sig;
    cam.steadySince = 0;
    setRing(0);
    flash();
    try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) { /* no vibration */ }
    let bitmap;
    try { bitmap = await createImageBitmap(el.video); }
    catch (_) { toast("That frame couldn't be captured. Try again."); return; }
    await processCapture(bitmap, hint);
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
      if (await processCapture(bitmap, null)) done++; else failed++;
    }
    toast(`Imported ${plural(done, "page", "pages")}` + (failed ? `. ${failed} couldn't be read.` : "."));
  }

  async function processCapture(bitmap, hint) {
    const page = { id: uid(), batchId: S.batch.id, createdAt: Date.now(), filter: ls.get("as.filter", "enhanced"), rotation: 0, status: "processing" };
    const batch = S.batch;
    batch.pageIds.push(page.id);
    S.pages.set(page.id, page);
    cam.inFlight++;
    updateCounter();
    if (S.screen === "review") renderReview();
    try {
      const r = await engine.call("capture", { bitmap, hint, filter: page.filter }, [bitmap]);
      Object.assign(page, {
        status: "ready", frame: r.frameBlob, frameW: r.frameW, frameH: r.frameH, quad: r.quad, auto: r.auto,
        warped: r.warpedBlob, output: r.outputBlob, thumb: r.thumbBlob, w: r.w, h: r.h,
      });
      if (S.batch !== batch) return false;   // batch was discarded meanwhile
      await DB.put("pages", page);
      batch.updatedAt = Date.now();
      await saveBatch();
      setThumb(page);
      if (!r.auto) toast("No page edges found, so the whole photo was kept. You can crop it in Review.");
      return true;
    } catch (err) {
      batch.pageIds = batch.pageIds.filter((x) => x !== page.id);
      S.pages.delete(page.id);
      await saveBatch().catch(() => {});
      toast(storageErr(err) || "That page couldn't be processed. Try again.");
      return false;
    } finally {
      cam.inFlight--;
      updateCounter();
      if (S.screen === "review") renderReview();
    }
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
    el.edMeta.textContent = [filterLabel(p.filter), p.rotation ? `rotated ${p.rotation}°` : "", p.auto === false ? "not cropped" : ""].filter(Boolean).join(" · ");
    if (edUrl) URL.revokeObjectURL(edUrl);
    edUrl = URL.createObjectURL(p.output);
    el.edImg.src = edUrl;
    el.edImg.alt = `Page ${idx + 1}`;
    for (const b of el.filterChips.children) b.setAttribute("aria-pressed", String(b.dataset.filter === p.filter));
    el.btnMoveUp.disabled = idx <= 0;
    el.btnMoveDown.disabled = idx >= ids.length - 1;
    el.btnCrop.disabled = !p.frame;
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
        ? { frameBlob: p.frame, quad: next.quad, rotation: next.rotation, filter: next.filter }
        : { warpedBlob: p.warped, rotation: next.rotation, filter: next.filter };
      const r = await engine.call("render", req);
      Object.assign(p, changes, { output: r.outputBlob, thumb: r.thumbBlob, w: r.w, h: r.h });
      if (r.warpedBlob) p.warped = r.warpedBlob;
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
    if (!p || p.filter === f) return;
    ls.set("as.filter", f);   // new pages use the last filter chosen
    rerender(p, { filter: f }, false);
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
    const ids = S.batch.pageIds;
    const idx = ids.indexOf(p.id);
    S.batch.pageIds = ids.filter((x) => x !== p.id);
    S.pages.delete(p.id);
    dropThumb(p.id);
    await DB.del("pages", p.id).catch(() => {});
    await saveBatch().catch(() => {});
    const nextId = S.batch.pageIds[Math.min(idx, S.batch.pageIds.length - 1)];
    toast("Page deleted.");
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
  async function cropDetect() {
    const p = curPage();
    if (!p || S.editor.busy) return;
    setBusy(true);
    try {
      const r = await engine.call("detectFrame", { frameBlob: p.frame });
      if (r.quad) { S.editor.quad = r.quad; drawCrop(); }
      else toast("No page edges found. Drag the corners by hand.");
    } catch (_) {
      toast("Edge detection didn't work this time.");
    } finally {
      setBusy(false);
    }
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
      "btnDiscard", "savedList", "savedEmpty", "savedSum", "verText", "video", "overlay", "quadPoly", "flash", "hint",
      "camError", "camErrorText", "btnRetryCam", "btnCamBack", "camLabel", "btnTorch", "btnAuto", "btnThumb", "thumbImg",
      "pageCount", "btnShutter", "ringArc", "btnDone", "btnReviewBack", "reviewMeta", "reviewEmpty", "grid", "btnAddPages",
      "importInput", "btnSave", "btnEdBack", "edTitle", "edMeta", "btnEdDelete", "edImg", "cropWrap", "cropImg", "cropSvg",
      "cropPoly", "cropHandles", "edBusy", "edTools", "filterChips", "btnMoveUp", "btnCrop", "btnRotate", "btnMoveDown",
      "cropBar", "btnCropAuto", "btnCropFull", "btnCropCancel", "btnCropApply", "saveSheet", "saveName", "saveInfo",
      "saveActions", "saveHelp", "btnShare", "btnDownload", "btnSaveCancel", "saveDone", "saveDoneText", "btnNewBatch",
      "btnKeepBatch", "toast",
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
    el.btnRotate.addEventListener("click", rotatePage);
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
    window.addEventListener("resize", () => { if (S.editor && S.editor.crop) drawCrop(); });

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
    el.verText.textContent = `Version ${VERSION}.`;
    engine.start();
    renderEngine();
    registerSW();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) { /* best effort */ }
    try {
      const all = await DB.getAll("batches");
      const cutoff = Date.now() - KEEP_DAYS * 864e5;
      for (const b of all) if (b.status === "saved" && b.savedAt < cutoff) await DB.deleteBatch(b.id);
      S.saved = all.filter((b) => b.status === "saved" && b.savedAt >= cutoff);
      const open = all.filter((b) => b.status === "open").sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (open) await loadBatch(open);
    } catch (err) {
      toast("Saved scans couldn't be loaded: " + ((err && err.message) || err), 8000);
    }
    show("setup");
  }

  window.__auditScan = { S, engine, cam };   // read by the automated test
  boot().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML("afterbegin", '<p style="padding:16px">Audit Scan failed to start. Reload the page.</p>');
  });
})();
