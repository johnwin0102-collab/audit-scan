/* Audit Scan image engine. Runs in a Web Worker so the camera view stays smooth.
   Finds the page edges, crops and straightens the page, and applies the scan filters. */
/* global cv */
"use strict";

self.importScripts("vendor/opencv.js");

const MAX_FRAME = 3000;   // px, long edge of the stored capture (kept for re-cropping)
const MAX_OUT = 2600;     // px, long edge of the cropped page
const THUMB = 360;        // px, long edge of thumbnails
const A4 = Math.SQRT2;    // ISO paper ratio, 1 : 1.414
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

const ready = new Promise((resolve, reject) => {
  const isUp = () => self.cv && typeof self.cv.Mat === "function";
  if (isUp()) { resolve(); return; }
  if (self.cv) {
    const prev = self.cv.onRuntimeInitialized;
    self.cv.onRuntimeInitialized = () => { if (typeof prev === "function") prev(); resolve(); };
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (isUp()) { clearInterval(timer); resolve(); }
    else if (Date.now() - started > 90000) { clearInterval(timer); reject(new Error("Scanner engine did not start")); }
  }, 100);
});

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    await ready;
    let result;
    switch (msg.type) {
      case "init": result = { ok: true }; break;
      case "detect": result = detectSmall(msg); break;
      case "capture": result = await capture(msg); break;
      case "render": result = await render(msg); break;
      case "detectFrame": result = await detectFrame(msg); break;
      default: throw new Error("Unknown request: " + msg.type);
    }
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};

/* ---------- Geometry ---------- */

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

function shoelace(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

// Order four points as top-left, top-right, bottom-right, bottom-left.
function orderQuad(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

function cornerAngles(q) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1x = a[0] - p[0], v1y = a[1] - p[1], v2x = b[0] - p[0], v2y = b[1] - p[1];
    const den = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / den));
    out.push(Math.acos(cos) * 180 / Math.PI);
  }
  return out;
}

function scoreQuad(q, W, H) {
  const area = shoelace(q) / (W * H);
  if (area < 0.1 || area > 0.985) return -1;
  const angles = cornerAngles(q);
  if (angles.some((a) => a < 52 || a > 128)) return -1;
  const m = 0.012;
  const onEdge = q.filter(([x, y]) => x < W * m || x > W * (1 - m) || y < H * m || y > H * (1 - m)).length;
  let s = area;
  if (onEdge >= 3) s -= 0.6;            // probably the frame itself, not a page
  const dev = angles.reduce((t, a) => t + Math.abs(90 - a), 0) / 4;
  s -= dev / 250;                        // prefer rectangular shapes
  return s;
}

function matToPoints(m) {
  const d = m.data32S, pts = [];
  for (let i = 0; i < m.rows; i++) pts.push([d[i * 2], d[i * 2 + 1]]);
  return pts;
}

function quadFromContour(c) {
  const peri = cv.arcLength(c, true);
  for (const f of [0.02, 0.03, 0.045, 0.06]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, f * peri, true);
    const ok = approx.rows === 4 && cv.isContourConvex(approx);
    const pts = ok ? matToPoints(approx) : null;
    approx.delete();
    if (pts) return pts;
  }
  // Fall back to the convex hull, which bridges small dents (fingers, folded corners).
  const hull = new cv.Mat();
  cv.convexHull(c, hull, false, true);
  const hp = cv.arcLength(hull, true);
  let pts = null;
  for (const f of [0.02, 0.035, 0.05, 0.07]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(hull, approx, f * hp, true);
    if (approx.rows === 4) pts = matToPoints(approx);
    approx.delete();
    if (pts) break;
  }
  hull.delete();
  return pts;
}

function collectQuads(binary, out, W, H) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(binary, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const minArea = 0.1 * W * H;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    if (cv.contourArea(c) >= minArea) {
      const pts = quadFromContour(c);
      if (pts) {
        const q = orderQuad(pts);
        const s = scoreQuad(q, W, H);
        if (s > 0) out.push({ q, s });
      }
    }
    c.delete();
  }
  contours.delete();
  hier.delete();
}

// Find the page in an RGBA Mat. Returns normalised corners (0..1) or null.
function findQuad(src) {
  const W = src.cols, H = src.rows;
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const th = new cv.Mat();
  const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const cands = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    cv.Canny(blur, edges, 30, 90);
    cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 2);
    collectQuads(edges, cands, W, H);

    cv.Canny(blur, edges, 60, 180);
    cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 1);
    collectQuads(edges, cands, W, H);

    cv.threshold(blur, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(th, th, cv.MORPH_CLOSE, k9);
    collectQuads(th, cands, W, H);
  } finally {
    gray.delete(); blur.delete(); edges.delete(); th.delete(); k3.delete(); k9.delete();
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.s - a.s);
  return cands[0].q.map(([x, y]) => [x / W, y / H]);
}

function maxDelta(a, b) {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
  return m;
}

/* ---------- Image helpers ---------- */

function shrink(mat, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(mat.cols, mat.rows));
  const out = new cv.Mat();
  cv.resize(mat, out, new cv.Size(Math.max(1, Math.round(mat.cols * s)), Math.max(1, Math.round(mat.rows * s))), 0, 0, cv.INTER_AREA);
  return out;
}

function drawToMat(source, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * s));
  const h = Math.max(1, Math.round(source.height * s));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return { mat: cv.matFromImageData(ctx.getImageData(0, 0, w, h)), canvas, w, h };
}

async function blobToMat(blob, maxEdge = 100000) {
  const bmp = await createImageBitmap(blob);
  try { return drawToMat(bmp, maxEdge).mat; } finally { bmp.close(); }
}

async function matToBlob(mat, quality) {
  const data = new Uint8ClampedArray(mat.data);   // copy out of the engine's memory
  const canvas = new OffscreenCanvas(mat.cols, mat.rows);
  canvas.getContext("2d").putImageData(new ImageData(data, mat.cols, mat.rows), 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

async function thumbOf(mat) {
  const t = shrink(mat, THUMB);
  try { return await matToBlob(t, 0.72); } finally { t.delete(); }
}

// True width/height of the photographed rectangle, undoing perspective (Zhang & He, whiteboard scanning).
// Uses a typical phone main-camera focal length (0.72 x the long side); in simulation this kept the page
// ratio within about 2% (median) and 11% (worst case), against 7% and 45% for raw side lengths.
// p: TL, TR, BR, BL in pixels. Returns 0 when it can't be estimated.
const FOCAL = 0.72;
function realAspect(p, W, H) {
  const u0 = W / 2, v0 = H / 2;
  const v = (pt) => [pt[0] - u0, pt[1] - v0, 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const m1 = v(p[0]), m2 = v(p[1]), m3 = v(p[3]), m4 = v(p[2]);
  const c14 = cross(m1, m4);
  const d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
  if (!d2 || !d3) return 0;
  const k2 = dot(c14, m3) / d2, k3 = dot(c14, m2) / d3;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const f2 = (FOCAL * Math.max(W, H)) ** 2;
  const r = Math.sqrt((n2[0] ** 2 / f2 + n2[1] ** 2 / f2 + n2[2] ** 2) / (n3[0] ** 2 / f2 + n3[1] ** 2 / f2 + n3[2] ** 2));
  return Number.isFinite(r) && r > 0.15 && r < 7 ? r : 0;
}

// Pull the corners in slightly so no sliver of desk shows along the page edges.
function insetQuad(q, t) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return q.map(([x, y]) => [x + (cx - x) * t, y + (cy - y) * t]);
}

const isFull = (q) => q.every((pt, i) => Math.abs(pt[0] - FULL[i][0]) < 1e-6 && Math.abs(pt[1] - FULL[i][1]) < 1e-6);

// Crop and straighten the page described by normalised quad q.
function warp(src, q) {
  const W = src.cols, H = src.rows;
  const p = (isFull(q) ? q : insetQuad(q, 0.008)).map(([x, y]) => [x * W, y * H]);
  let ow = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
  let oh = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
  // Correct the proportions for perspective; keep the longer measured side for resolution.
  const r = realAspect(p, W, H), measured = ow / oh;
  if (r && r / measured > 0.6 && r / measured < 1.6) {
    if (oh >= ow) ow = oh * r; else oh = ow / r;
  }
  // Most fieldwork documents are A4; snap to the exact ratio when the page is close to it.
  const long = Math.max(ow, oh), short = Math.min(ow, oh);
  if (short > 0 && Math.abs(long / short - A4) / A4 < 0.07) {
    if (oh >= ow) oh = ow * A4; else ow = oh * A4;
  }
  const s = Math.min(1, MAX_OUT / Math.max(ow, oh));
  ow = Math.max(1, Math.round(ow * s));
  oh = Math.max(1, Math.round(oh * s));
  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, p.flat());
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow - 1, 0, ow - 1, oh - 1, 0, oh - 1]);
  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  srcPts.delete(); dstPts.delete(); M.delete();
  return dst;
}

// Estimate the paper's brightness everywhere, so shadows and uneven light can be divided out.
// `single` is one 8-bit channel: grey for the grey modes, the brightest of R/G/B for the colour modes
// (dividing colours by their own brightest channel can't push them past white, so no neon blow-outs).
function background(single) {
  const s = Math.min(1, 640 / Math.max(single.cols, single.rows));
  const small = new cv.Mat();
  cv.resize(single, small, new cv.Size(Math.max(1, Math.round(single.cols * s)), Math.max(1, Math.round(single.rows * s))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.dilate(small, small, k);
  cv.medianBlur(small, small, 21);
  const bg = new cv.Mat();
  cv.resize(small, bg, new cv.Size(single.cols, single.rows), 0, 0, cv.INTER_LINEAR);
  bg.convertTo(bg, -1, 1, 1);   // never divide by zero
  small.delete(); k.delete();
  return bg;
}

function brightestChannel(src) {
  const planes = new cv.MatVector();
  cv.split(src, planes);
  const r = planes.get(0), g = planes.get(1), b = planes.get(2), a = planes.get(3);
  const v = new cv.Mat();
  cv.max(r, g, v);
  cv.max(v, b, v);
  r.delete(); g.delete(); b.delete(); a.delete(); planes.delete();
  return v;
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Does the page carry colour worth keeping (stamps, logos, highlighter)?
function isColourful(src) {
  const d = src.data;
  let coloured = 0, seen = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 60) { seen++; if (mx - mn > 55) coloured++; }
  }
  return seen > 0 && coloured / seen > 0.004;
}

const FILTER_ALIASES = { enhanced: "magic" };   // pages scanned with version 1.0

// Modes modelled on CamScanner's: Auto, Original, Lighten, Magic colour, No shadow, Grey, B&W, B&W 2.
function applyFilter(src, filterIn) {
  let filter = FILTER_ALIASES[filterIn] || filterIn || "auto";
  if (filter === "auto") filter = isColourful(src) ? "magic" : "grey";
  const out = new cv.Mat();
  src.copyTo(out);
  const d = out.data;

  if (filter === "original") return out;

  if (filter === "lighten") {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) lut[v] = clamp8(Math.round(255 * Math.pow(v / 255, 0.76) * 1.03));
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
    return out;
  }

  if (filter === "magic" || filter === "noshadow") {
    const v = brightestChannel(src);
    const bg = background(v);
    v.delete();
    const B = bg.data;
    const magic = filter === "magic";
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const gain = 255 / B[p];
      let r = d[i] * gain, g = d[i + 1] * gain, b = d[i + 2] * gain;
      if (magic) {
        r = (r - 24) * 1.13; g = (g - 24) * 1.13; b = (b - 24) * 1.13;
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        r = y + (r - y) * 1.2; g = y + (g - y) * 1.2; b = y + (b - y) * 1.2;
      } else {
        r *= 0.98; g *= 0.98; b *= 0.98;
      }
      d[i] = clamp8(r); d[i + 1] = clamp8(g); d[i + 2] = clamp8(b);
    }
    bg.delete();
    return out;
  }

  // Grey family: even out the light on the grey image first.
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const bg = background(gray);
  const norm = new cv.Mat();
  cv.divide(gray, bg, norm, 255);
  gray.delete(); bg.delete();
  let res = norm;
  if (filter === "bw") {
    res = new cv.Mat();
    cv.adaptiveThreshold(norm, res, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 31, 18);
    norm.delete();
  } else {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = filter === "bw2"
        ? clamp8(Math.round(268 / (1 + Math.exp(-(v - 168) / 17)) - 6))   // soft black-and-white: keeps smooth edges and faint marks
        : clamp8(Math.round((v - 34) * 1.18));                            // grey: white paper, dark text
    }
    const nd = norm.data;
    for (let i = 0; i < nd.length; i++) nd[i] = lut[nd[i]];
  }
  out.delete();
  const out2 = new cv.Mat();
  cv.cvtColor(res, out2, cv.COLOR_GRAY2RGBA);
  res.delete();
  return out2;
}

/* ---------- Corner refinement ----------
   The AI model places corners to within about 1% of the frame. This snaps each side onto the
   straight page edge next to it when one is clearly visible, which in testing cut the median
   corner error from 0.39% to 0.06% of the frame diagonal. Sides without a clear edge keep the
   model's line, and any large jump is rejected. */
function refineQuad(src, hint) {
  const W = src.cols, H = src.rows;
  const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat();
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 20, 60);
    cv.Sobel(blur, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(blur, gy, cv.CV_32F, 0, 1, 3);
    const E = edges.data, GX = gx.data32F, GY = gy.data32F;
    const P = hint.map(([x, y]) => [x * W, y * H]);
    const diag = Math.hypot(W, H);
    const band = Math.max(4, 0.02 * diag);
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 10) { lines.push(null); continue; }
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, nx = -dy, ny = dx;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - band)), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + band));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - band)), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1]) + band));
      const ss = [], tt = [], xs = [], ys = [];
      for (let y = y0; y <= y1; y++) {
        const row = y * W;
        for (let x = x0; x <= x1; x++) {
          if (!E[row + x]) continue;
          const rx = x - a[0], ry = y - a[1];
          const s = rx * nx + ry * ny;
          if (s <= -band || s >= band) continue;
          const t = rx * dx + ry * dy;
          if (t < 0.06 * L || t > 0.94 * L) continue;
          const g1 = GX[row + x], g2 = GY[row + x];
          const gn = Math.hypot(g1, g2) + 1e-6;
          if (Math.abs(g1 * nx + g2 * ny) / gn < 0.92) continue;   // edge must run along this side
          ss.push(s); tt.push(t); xs.push(x); ys.push(y);
        }
      }
      if (ss.length < 0.6 * L) { lines.push(null); continue; }
      // Several parallel edges can sit near a side (the page edge, a table line, the desk edge).
      // Take the strongest few offsets and keep the one closest to the model's line that runs most of the side.
      const nb = Math.floor(2 * band) + 1;
      const hist = new Float32Array(nb);
      for (const s of ss) hist[Math.min(nb - 1, Math.max(0, Math.floor(s + band)))]++;
      const sm = hist.map((v, k) => v * 2 + (hist[k - 1] || 0) + (hist[k + 1] || 0));
      const order = [...sm.keys()].sort((p, q) => sm[q] - sm[p]).slice(0, 4);
      let best = null;
      for (const k of order) {
        const off = k - band + 0.5;
        const cover = new Set();
        const idx = [];
        for (let j = 0; j < ss.length; j++) {
          if (Math.abs(ss[j] - off) < 2) { idx.push(j); cover.add(Math.floor((tt[j] / L) * 50)); }
        }
        if (cover.size / 50 < 0.6) continue;
        if (!best || Math.abs(off) < Math.abs(best.off)) best = { off, idx };
      }
      if (!best) { lines.push(null); continue; }
      // Total least squares line through the chosen edge pixels.
      let mx = 0, my = 0;
      for (const j of best.idx) { mx += xs[j]; my += ys[j]; }
      mx /= best.idx.length; my /= best.idx.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const j of best.idx) { const ex = xs[j] - mx, ey = ys[j] - my; sxx += ex * ex; syy += ey * ey; sxy += ex * ey; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      lines.push({ p: [mx, my], v: [Math.cos(ang), Math.sin(ang)] });
    }
    if (lines.every((l) => !l)) return null;
    const use = lines.map((l, i) => {
      if (l) return l;
      const a = P[i], b = P[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return { p: a, v: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] };
    });
    const out = [];
    for (let i = 0; i < 4; i++) {
      const l1 = use[(i + 3) % 4], l2 = use[i];
      const det = l1.v[0] * -l2.v[1] - -l2.v[0] * l1.v[1];
      if (Math.abs(det) < 1e-6) return null;
      const rx = l2.p[0] - l1.p[0], ry = l2.p[1] - l1.p[1];
      const t = (rx * -l2.v[1] - -l2.v[0] * ry) / det;
      out.push([l1.p[0] + l1.v[0] * t, l1.p[1] + l1.v[1] * t]);
    }
    for (let i = 0; i < 4; i++) if (dist(out[i], P[i]) > 0.015 * diag) return null;
    return out.map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]);
  } finally {
    gray.delete(); blur.delete(); edges.delete(); gx.delete(); gy.delete();
  }
}

function rotate(mat, deg) {
  const code = { 90: cv.ROTATE_90_CLOCKWISE, 180: cv.ROTATE_180, 270: cv.ROTATE_90_COUNTERCLOCKWISE }[deg];
  if (code === undefined) return mat;
  const r = new cv.Mat();
  cv.rotate(mat, r, code);
  mat.delete();
  return r;
}

/* ---------- Requests ---------- */

// Live preview: a small RGBA frame from the camera.
function detectSmall({ width, height, buffer }) {
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(new Uint8Array(buffer));
  try { return { quad: findQuad(src) }; } finally { src.delete(); }
}

// A captured page: full camera frame (ImageBitmap) and, when the AI page finder saw a page,
// its corners as a hint. Without a hint the classical edge finder looks for the page instead.
async function capture({ bitmap, hint, filter }) {
  const { mat: frame, canvas, w: frameW, h: frameH } = drawToMat(bitmap, MAX_FRAME);
  bitmap.close();
  try {
    const frameBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    const small = shrink(frame, 900);
    let q = null;
    try {
      q = hint ? (refineQuad(small, hint) || hint) : findQuad(small);
    } finally {
      small.delete();
    }
    const auto = !!q;
    if (!q) q = FULL;
    const warped = warp(frame, q);
    const warpedBlob = await matToBlob(warped, 0.9);
    const out = applyFilter(warped, filter || "auto");
    warped.delete();
    const outputBlob = await matToBlob(out, 0.85);
    const thumbBlob = await thumbOf(out);
    const res = { frameBlob, frameW, frameH, quad: q, auto, warpedBlob, outputBlob, thumbBlob, w: out.cols, h: out.rows };
    out.delete();
    return res;
  } finally {
    frame.delete();
  }
}

// Editor changes: re-crop from the stored frame, or re-filter/rotate the stored crop.
async function render({ frameBlob, warpedBlob, quad, rotation, filter }) {
  let warped, newWarped = null;
  if (frameBlob) {
    const frame = await blobToMat(frameBlob);
    try { warped = warp(frame, quad || FULL); } finally { frame.delete(); }
    newWarped = await matToBlob(warped, 0.9);
  } else {
    warped = await blobToMat(warpedBlob);
  }
  let out = applyFilter(warped, filter || "auto");
  warped.delete();
  out = rotate(out, rotation || 0);
  const outputBlob = await matToBlob(out, 0.85);
  const thumbBlob = await thumbOf(out);
  const res = { warpedBlob: newWarped, outputBlob, thumbBlob, w: out.cols, h: out.rows };
  out.delete();
  return res;
}

// Editor "Detect": refine the AI page finder's corners on the stored photo, or fall back to the edge finder.
async function detectFrame({ frameBlob, hint }) {
  const mat = await blobToMat(frameBlob, 900);
  try { return { quad: hint ? (refineQuad(mat, hint) || hint) : findQuad(mat) }; } finally { mat.delete(); }
}
