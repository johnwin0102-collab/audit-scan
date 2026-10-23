/* Audit Scan page flattening. Loaded into the image engine worker (cv-worker.js).

   Pages that aren't lying flat (curled, lifted, bowed) still look bent after the four-corner crop.
   This finds what has to be straight on a flat page (text lines, table rules, column lines and the
   paper edges), fits a smooth correction (two cubic B-spline displacement fields) that makes them
   straight, and samples the photo through it. Each pass works on the image the previous passes
   flattened, so steep, strongly bent areas straighten step by step. Flat pages are left alone.

   Prototyped and tested against synthetic bent pages with known ground truth; the numbers in the
   comments come from that work. */
/* global cv */
"use strict";

const FLAT = {
  LA: 1000,          // px, long side of the page in the analysis image
  MARGIN: 0.12,      // analysis margin around the page, share of LA (bent edges bulge out)
  INSET: 0.008,      // the crop's corner inset (keeps desk slivers out of the output)
  GRID: [8, 11],     // B-spline cells across and down, portrait
  PASSES: 3,
  STOP: 2.0,         // px at LA: a later pass that moves less than this isn't worth applying
  SUB: 40,           // points per structure used in the fit (more adds time, not accuracy)
  LAMBDA: 0.5,       // smoothness of the correction
  MIN_NONAFFINE: 2.5,  // px at LA: bending below this, and...
  MIN_MOVE: 6,         // ...overall correction below this, counts as a flat page
  MAX_MOVE: 120,       // px at LA: anything bigger is a misreading, so the page is left as cropped
};

/* ---------- small numeric helpers ---------- */

function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// Python-style rounding (half to even), so results match the reference implementation.
function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Least-squares polynomial fit b = sum c_k a^k (k = 0..d). Returns c (lowest order first).
function polyfit(a, b, d, use) {
  const n = d + 1;
  let mean = 0, cnt = 0, span = 0;
  for (let i = 0; i < a.length; i++) if (!use || use[i]) { mean += a[i]; cnt++; }
  mean /= cnt || 1;
  for (let i = 0; i < a.length; i++) if (!use || use[i]) span = Math.max(span, Math.abs(a[i] - mean));
  span = span || 1;
  const M = new Float64Array(n * n), v = new Float64Array(n), p = new Float64Array(n);
  for (let i = 0; i < a.length; i++) {
    if (use && !use[i]) continue;
    const t = (a[i] - mean) / span;
    p[0] = 1;
    for (let k = 1; k < n; k++) p[k] = p[k - 1] * t;
    for (let r = 0; r < n; r++) {
      v[r] += p[r] * b[i];
      for (let c = 0; c < n; c++) M[r * n + c] += p[r] * p[c];
    }
  }
  const c = solveDense(M, v, n) || new Float64Array(n);
  return { c, mean, span, d };
}
function polyval(f, x) {
  const t = (x - f.mean) / f.span;
  let s = 0, p = 1;
  for (let k = 0; k <= f.d; k++) { s += f.c[k] * p; p *= t; }
  return s;
}

// Symmetric positive-definite solve (Cholesky). M is overwritten. Returns null if not positive definite.
function solveDense(M, v, n) {
  for (let j = 0; j < n; j++) {
    let s = M[j * n + j];
    for (let k = 0; k < j; k++) s -= M[j * n + k] * M[j * n + k];
    if (!(s > 1e-12)) return null;
    const d = Math.sqrt(s);
    M[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = M[i * n + j];
      for (let k = 0; k < j; k++) t -= M[i * n + k] * M[j * n + k];
      M[i * n + j] = t / d;
    }
  }
  const x = Float64Array.from(v);
  for (let i = 0; i < n; i++) {
    let t = x[i];
    for (let k = 0; k < i; k++) t -= M[i * n + k] * x[k];
    x[i] = t / M[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = x[i];
    for (let k = i + 1; k < n; k++) t -= M[k * n + i] * x[k];
    x[i] = t / M[i * n + i];
  }
  return x;
}

/* ---------- cubic B-spline displacement field ---------- */

function Spline(W, H, nx, ny) {
  this.W = W; this.H = H; this.nx = nx; this.ny = ny;
  this.cx = W / nx; this.cy = H / ny;
  this.kx = nx + 3; this.ky = ny + 3;
  this.n = this.kx * this.ky;
  this.wx = new Float64Array(4); this.wy = new Float64Array(4);
}
function bsw(t, o) {
  const t2 = t * t, t3 = t2 * t, u = 1 - t;
  o[0] = (u * u * u) / 6;
  o[1] = (3 * t3 - 6 * t2 + 4) / 6;
  o[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  o[3] = t3 / 6;
}
// Writes the 16 coefficient indices and weights for point (x, y).
Spline.prototype.basis = function (x, y, idx, w) {
  let gx = x / this.cx, gy = y / this.cy;
  const mx = this.nx - 1e-9, my = this.ny - 1e-9;
  gx = gx < 0 ? 0 : gx > mx ? mx : gx;
  gy = gy < 0 ? 0 : gy > my ? my : gy;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  bsw(gx - ix, this.wx); bsw(gy - iy, this.wy);
  let k = 0;
  for (let j = 0; j < 4; j++) {
    const row = (iy + j) * this.kx + ix;
    for (let i = 0; i < 4; i++, k++) { idx[k] = row + i; w[k] = this.wy[j] * this.wx[i]; }
  }
};
Spline.prototype.eval = function (coef, x, y) {
  let gx = x / this.cx, gy = y / this.cy;
  const mx = this.nx - 1e-9, my = this.ny - 1e-9;
  gx = gx < 0 ? 0 : gx > mx ? mx : gx;
  gy = gy < 0 ? 0 : gy > my ? my : gy;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const wx = this.wx, wy = this.wy;
  bsw(gx - ix, wx); bsw(gy - iy, wy);
  let s = 0;
  for (let j = 0; j < 4; j++) {
    const row = (iy + j) * this.kx + ix;
    s += wy[j] * (coef[row] * wx[0] + coef[row + 1] * wx[1] + coef[row + 2] * wx[2] + coef[row + 3] * wx[3]);
  }
  return s;
};
// Roughness penalty: squared second differences across, down and mixed.
Spline.prototype.penalty = function () {
  if (this._P) return this._P;
  const n = this.n, kx = this.kx, ky = this.ky, P = new Float64Array(n * n);
  const add = (ids, vals) => {
    for (let a = 0; a < ids.length; a++) for (let b = 0; b < ids.length; b++) P[ids[a] * n + ids[b]] += vals[a] * vals[b];
  };
  for (let j = 0; j < ky; j++) for (let i = 1; i < kx - 1; i++) add([j * kx + i - 1, j * kx + i, j * kx + i + 1], [1, -2, 1]);
  for (let j = 1; j < ky - 1; j++) for (let i = 0; i < kx; i++) add([(j - 1) * kx + i, j * kx + i, (j + 1) * kx + i], [1, -2, 1]);
  for (let j = 0; j < ky - 1; j++) {
    for (let i = 0; i < kx - 1; i++) add([j * kx + i, j * kx + i + 1, (j + 1) * kx + i, (j + 1) * kx + i + 1], [1, -1, -1, 1]);
  }
  this._P = P;
  return P;
};

/* ---------- finding the structures that should be straight ---------- */

function inkMask(gray) {
  const ink = new cv.Mat();
  cv.adaptiveThreshold(gray, ink, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 12);
  return ink;
}

// Typical character height, from the ink's connected components.
function charHeight(ink) {
  const lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
  try {
    const n = cv.connectedComponentsWithStats(ink, lab, st, ce, 8, cv.CV_32S);
    const S = st.data32S, hs = [];
    for (let k = 1; k < n; k++) {
      const w = S[k * 5 + 2], h = S[k * 5 + 3], a = S[k * 5 + 4];
      if (h >= 5 && h <= 60 && w <= 80 && a >= 12) hs.push(h);
    }
    return hs.length > 20 ? median(hs) : 0;
  } finally {
    lab.delete(); st.delete(); ce.delete();
  }
}

// Thin-line pixels running across (within about 40 degrees) and down, from the local orientation
// (structure tensor). Grid crossings and text strokes, which have no single direction, drop out.
function lineMasks(ink) {
  const H = ink.rows, W = ink.cols;
  const f = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat(), xx = new cv.Mat(), yy = new cv.Mat(), xy = new cv.Mat();
  try {
    ink.convertTo(f, cv.CV_32F, 1 / 255);
    cv.GaussianBlur(f, f, new cv.Size(0, 0), 1.0);
    cv.Sobel(f, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(f, gy, cv.CV_32F, 0, 1, 3);
    cv.multiply(gx, gx, xx); cv.multiply(gy, gy, yy); cv.multiply(gx, gy, xy);
    const k = new cv.Size(7, 7);
    cv.blur(xx, xx, k); cv.blur(yy, yy, k); cv.blur(xy, xy, k);
    const hmask = cv.Mat.zeros(H, W, cv.CV_8U), vmask = cv.Mat.zeros(H, W, cv.CV_8U);
    const I = ink.data, A = xx.data32F, B = yy.data32F, C = xy.data32F, HM = hmask.data, VM = vmask.data;
    for (let i = 0; i < W * H; i++) {
      if (!I[i]) continue;
      const tr = A[i] + B[i];
      if (tr <= 0.02) continue;
      const d = A[i] - B[i], r = Math.sqrt(d * d + 4 * C[i] * C[i]);
      if (r / (tr + 1e-6) <= 0.55) continue;
      if (d < -0.17 * r) HM[i] = 255;
      else if (d > 0.17 * r) VM[i] = 255;
    }
    return { hmask, vmask };
  } finally {
    f.delete(); gx.delete(); gy.delete(); xx.delete(); yy.delete(); xy.delete();
  }
}

// Centre lines of a mask's connected components: y = f(x) per column (horizontal) or x = f(y) per row.
function centerlines(mask, horizontal, minLen, maxThick, step = 3) {
  const lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
  try {
    const n = cv.connectedComponentsWithStats(mask, lab, st, ce, 8, cv.CV_32S);
    const S = st.data32S, L = lab.data32S, W = mask.cols, H = mask.rows;
    const slot = new Int32Array(n).fill(-1), items = [];
    let total = 0;
    for (let k = 1; k < n; k++) {
      const x0 = S[k * 5], y0 = S[k * 5 + 1], w = S[k * 5 + 2], h = S[k * 5 + 3];
      if ((horizontal ? w : h) < minLen) continue;
      slot[k] = items.length;
      items.push({ x0, y0, w, h, off: total });
      total += horizontal ? w : h;
    }
    if (!items.length) return [];
    const cnt = new Int32Array(total), sum = new Float64Array(total);
    const lo = new Int32Array(total).fill(1 << 30), hi = new Int32Array(total).fill(-1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const k = L[row + x];
        if (k <= 0) continue;
        const s = slot[k];
        if (s < 0) continue;
        const it = items[s];
        const j = it.off + (horizontal ? x - it.x0 : y - it.y0);
        const v = horizontal ? y : x;
        cnt[j]++; sum[j] += v;
        if (v < lo[j]) lo[j] = v;
        if (v > hi[j]) hi[j] = v;
      }
    }
    const out = [];
    for (const it of items) {
      const len = horizontal ? it.w : it.h;
      const pos = [];
      for (let q = 0; q < len; q++) if (cnt[it.off + q] > 0) pos.push(q);
      const used = [];
      for (let q = 0; q < pos.length; q += step) used.push(pos[q]);
      if (used.length < 5) continue;
      const th = used.map((q) => hi[it.off + q] - lo[it.off + q] + 1);
      if (median(th) > maxThick) continue;
      const xs = new Float64Array(used.length), ys = new Float64Array(used.length);
      used.forEach((q, i) => {
        const j = it.off + q, c = sum[j] / cnt[j] + 0.5;
        if (horizontal) { xs[i] = it.x0 + q + 0.5; ys[i] = c; } else { xs[i] = c; ys[i] = it.y0 + q + 0.5; }
      });
      out.push({ x: xs, y: ys });
    }
    return out;
  } finally {
    lab.delete(); st.delete(); ce.delete();
  }
}

// Keep a centre line only if a low-order curve fits it; drops stray points.
function polyOk(p, horizontal, tol) {
  const a = horizontal ? p.x : p.y, b = horizontal ? p.y : p.x;
  let amin = Infinity, amax = -Infinity;
  for (const v of a) { if (v < amin) amin = v; if (v > amax) amax = v; }
  if (amax - amin < 1) return null;
  const d = Math.min(2, Math.max(1, Math.floor((amax - amin) / 60)));
  let f = polyfit(a, b, d);
  const r = new Float64Array(a.length);
  let mean = 0;
  for (let i = 0; i < a.length; i++) { r[i] = b[i] - polyval(f, a[i]); mean += r[i]; }
  mean /= a.length;
  let sd = 0;
  for (let i = 0; i < a.length; i++) sd += (r[i] - mean) ** 2;
  sd = Math.sqrt(sd / a.length);
  const lim = Math.max(2.5 * sd, 1.0);
  const keep = new Uint8Array(a.length);
  let nk = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(r[i]) < lim) { keep[i] = 1; nk++; }
  if (nk >= 5) f = polyfit(a, b, d, keep);
  if (!nk) return null;
  let ss = 0;
  for (let i = 0; i < a.length; i++) if (keep[i]) ss += (b[i] - polyval(f, a[i])) ** 2;
  if (Math.sqrt(ss / nk) > tol) return null;
  const xs = new Float64Array(nk), ys = new Float64Array(nk);
  for (let i = 0, j = 0; i < a.length; i++) if (keep[i]) { xs[j] = p.x[i]; ys[j] = p.y[i]; j++; }
  return { x: xs, y: ys };
}
const keepOk = (list, horizontal, tol) => list.map((p) => polyOk(p, horizontal, tol)).filter(Boolean);

function drawLines(mat, list, thickness) {
  for (const p of list) {
    for (let i = 1; i < p.x.length; i++) {
      cv.line(mat, new cv.Point(Math.trunc(p.x[i - 1]), Math.trunc(p.y[i - 1])), new cv.Point(Math.trunc(p.x[i]), Math.trunc(p.y[i])),
        new cv.Scalar(255), thickness);
    }
  }
}

function findStructures(gray) {
  const H = gray.rows, W = gray.cols;
  const ink = inkMask(gray);
  const mats = [ink];
  try {
    const hc = charHeight(ink) || 12;
    const { hmask, vmask } = lineMasks(ink);
    mats.push(hmask, vmask);
    const vlines = keepOk(centerlines(vmask, false, Math.max(0.05 * H, 4 * hc), 6), false, 2.0);
    const rules = keepOk(centerlines(hmask, true, Math.max(0.06 * W, 5 * hc), 6), true, 2.0);
    // Text lines: take the rules and column lines out, then smear characters sideways into line blobs.
    const lines = cv.Mat.zeros(H, W, cv.CV_8U);
    mats.push(lines);
    drawLines(lines, vlines, 7);
    drawLines(lines, rules, 7);
    cv.bitwise_not(lines, lines);
    const inkT = new cv.Mat(), blobs = new cv.Mat();
    mats.push(inkT, blobs);
    cv.bitwise_and(ink, lines, inkT);
    const kc = Math.max(9, roundEven(1.4 * hc));
    const k1 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kc, 1));
    const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    mats.push(k1, k2);
    cv.morphologyEx(inkT, blobs, cv.MORPH_CLOSE, k1, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    cv.morphologyEx(blobs, blobs, cv.MORPH_OPEN, k2, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const texts = keepOk(centerlines(blobs, true, Math.max(40, 4 * hc), 2.6 * hc), true, 2.5);
    return { rules, texts, vlines, hc };
  } finally {
    for (const m of mats) m.delete();
  }
}

/* ---------- paper edges ---------- */

// Each side traced as one smooth path from corner to corner (dynamic programming over a band
// either side of the cropped edge), scored by how much brighter the paper is than what lies outside.
function findEdges(gray, m, Wa, Ha, delta) {
  const g8 = new cv.Mat();
  cv.GaussianBlur(gray, g8, new cv.Size(0, 0), 1.2);
  const G = g8.data, W = g8.cols, H = g8.rows;
  const at = (x, y) => {
    x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
    y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = G[y0 * W + x0], b = G[y0 * W + x1], c = G[y1 * W + x0], d = G[y1 * W + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  const bandOut = Math.trunc(0.92 * m), bandIn = Math.trunc(0.06 * FLAT.LA);
  const nOff = bandOut + bandIn + 1;
  const win = 9, gap = 1, N = 96, ext = nOff + 2 * (win + gap);
  const sides = {
    top: [[m, m], [m + Wa, m], [0, 1], m - delta[1], -delta[1]],
    bottom: [[m, m + Ha], [m + Wa, m + Ha], [0, -1], m + Ha + delta[1], -delta[1]],
    left: [[m, m], [m, m + Ha], [1, 0], m - delta[0], -delta[0]],
    right: [[m + Wa, m], [m + Wa, m + Ha], [-1, 0], m + Wa + delta[0], -delta[0]],
  };
  const out = {};
  const resp = new Float64Array(N * nOff), csum = new Float64Array(ext + 1);
  try {
    for (const side of Object.keys(sides)) {
      const [a, b, nin, target, d0] = sides[side];
      const base = [];
      for (let j = 0; j < N; j++) {
        const t = j / (N - 1);
        const bx = a[0] + t * (b[0] - a[0]), by = a[1] + t * (b[1] - a[1]);
        base.push([bx, by]);
        csum[0] = 0;
        for (let e = 0; e < ext; e++) {
          const o = e - bandOut - win - gap;
          csum[e + 1] = csum[e] + at(bx + o * nin[0], by + o * nin[1]);
        }
        for (let i = 0; i < nOff; i++) {
          const idx = i + win + gap;
          const inside = (csum[idx + gap + win] - csum[idx + gap]) / win;
          const outside = (csum[idx - gap + 1] - csum[idx - gap - win + 1]) / win;
          resp[j * nOff + i] = inside - outside;
        }
      }
      // smooth path that starts and ends near the corners
      const lam = 1.0, jump = 6, tol = 12;
      const endOk = new Uint8Array(nOff);
      for (let i = 0; i < nOff; i++) endOk[i] = Math.abs(i - bandOut - d0) <= tol ? 1 : 0;
      let score = new Float64Array(nOff), next = new Float64Array(nOff);
      const back = new Int32Array(N * nOff);
      for (let i = 0; i < nOff; i++) score[i] = endOk[i] ? resp[i] : -1e9;
      for (let j = 1; j < N; j++) {
        for (let i = 0; i < nOff; i++) {
          let best = -1e18, arg = i;
          const lo = Math.max(0, i - jump), hi = Math.min(nOff - 1, i + jump);
          for (let k = lo; k <= hi; k++) {
            const sc = score[k] - lam * Math.abs(i - k);
            if (sc > best) { best = sc; arg = k; }
          }
          next[i] = best + resp[j * nOff + i];
          back[j * nOff + i] = arg;
        }
        const t = score; score = next; next = t;
      }
      let o = -1, bestEnd = -Infinity;
      for (let i = 0; i < nOff; i++) if (endOk[i] && score[i] > bestEnd) { bestEnd = score[i]; o = i; }
      const path = new Int32Array(N);
      path[N - 1] = o;
      for (let j = N - 1; j > 0; j--) path[j - 1] = back[j * nOff + path[j]];
      const r = new Float64Array(N), po = new Float64Array(N);
      for (let j = 0; j < N; j++) { r[j] = resp[j * nOff + path[j]]; po[j] = path[j] - bandOut; }
      const med = median(r);
      const good = new Uint8Array(N);
      let ng = 0;
      for (let j = 0; j < N; j++) if (r[j] > Math.max(12, 0.35 * med)) { good[j] = 1; ng++; }
      const sm = new Float64Array(N);
      for (let j = 0; j < N; j++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += po[Math.min(N - 1, Math.max(0, j + k))];
        sm[j] = s / 5;
      }
      let rough = 0;
      for (let j = 1; j < N - 1; j++) rough += Math.abs(sm[j - 1] - 2 * sm[j] + sm[j + 1]);
      rough /= N - 2;
      // a real page edge bends gently; a path that ducks in to follow a heading doesn't
      let dev = 99;
      if (ng > 8) {
        const ts = new Float64Array(N);
        for (let j = 0; j < N; j++) ts[j] = j / (N - 1);
        const fit = polyfit(ts, po, 4, good);
        let ss = 0;
        for (let j = 0; j < N; j++) if (good[j]) ss += (po[j] - polyval(fit, ts[j])) ** 2;
        dev = Math.sqrt(ss / ng);
      }
      if (!(med > 20 && ng / N > 0.65 && rough < 1.2 && dev < 2.5)) continue;
      const xs = [], ys = [];
      for (let j = 2; j < N - 2; j++) {
        if (!good[j]) continue;
        xs.push(base[j][0] + sm[j] * nin[0]);
        ys.push(base[j][1] + sm[j] * nin[1]);
      }
      out[side] = { x: Float64Array.from(xs), y: Float64Array.from(ys), target };
    }
    return out;
  } finally {
    g8.delete();
  }
}

// The page's area: detected edge paths where found, otherwise the straight side between corners.
function pageRegion(H, W, m, Wa, Ha, edges, shrink = 6) {
  const pts = [];
  const add = (xs, ys, rev) => {
    const n = xs.length;
    for (let i = 0; i < n; i++) { const j = rev ? n - 1 - i : i; pts.push(Math.trunc(Math.round(xs[j])), Math.trunc(Math.round(ys[j]))); }
  };
  if (edges.top) add(edges.top.x, edges.top.y, false); else pts.push(m, m, m + Wa, m);
  if (edges.right) add(edges.right.x, edges.right.y, false); else pts.push(m + Wa, m, m + Wa, m + Ha);
  if (edges.bottom) add(edges.bottom.x, edges.bottom.y, true); else pts.push(m + Wa, m + Ha, m, m + Ha);
  if (edges.left) add(edges.left.x, edges.left.y, true); else pts.push(m, m + Ha, m, m);
  const mask = cv.Mat.zeros(H, W, cv.CV_8U);
  const poly = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
  const vec = new cv.MatVector();
  vec.push_back(poly);
  cv.fillPoly(mask, vec, new cv.Scalar(255));
  vec.delete(); poly.delete();
  const k = cv.Mat.ones(2 * shrink + 1, 2 * shrink + 1, cv.CV_8U);
  cv.erode(mask, mask, k);
  k.delete();
  return mask;
}

function insideOnly(list, mask, minShare = 0.6) {
  const W = mask.cols, H = mask.rows, M = mask.data, out = [];
  for (const p of list) {
    const xs = [], ys = [];
    for (let i = 0; i < p.x.length; i++) {
      const xi = Math.min(W - 1, Math.max(0, Math.round(p.x[i]))), yi = Math.min(H - 1, Math.max(0, Math.round(p.y[i])));
      if (M[yi * W + xi]) { xs.push(p.x[i]); ys.push(p.y[i]); }
    }
    if (xs.length >= 5 && xs.length >= minShare * p.x.length) out.push({ x: Float64Array.from(xs), y: Float64Array.from(ys) });
  }
  return out;
}

/* ---------- fitting the correction ---------- */

// Fit one displacement field: axis 1 = Dv from structures that run across (each must become one
// straight row), axis 0 = Du from structures that run down. Each structure gets a free row/column
// position; edges have fixed targets (the page border). A shared slope term keeps any skew the
// printing itself has, so only geometry is corrected. `other` is the other field's coefficients,
// used to place points along their structure.
function subsample(p, k) {
  const n = p.x.length;
  if (!k || n <= k) return p;
  const xs = new Float64Array(k), ys = new Float64Array(k);
  for (let i = 0; i < k; i++) { const j = roundEven((i * (n - 1)) / (k - 1)); xs[i] = p.x[j]; ys[i] = p.y[j]; }
  return Object.assign({}, p, { x: xs, y: ys });
}

function fitField(spl, structs, edges, other, axis, lam = FLAT.LAMBDA, iters = 3) {
  const n = spl.n, nb = n + 1;                       // spline coefficients + shared slope
  const groups = structs.map((p) => ({ p: subsample(p, FLAT.SUB), tgt: null, w0: 1 }))
    .concat(edges.map((e) => ({ p: subsample(e, FLAT.SUB), tgt: e.target, w0: 4 })));
  if (!groups.length) return { coef: new Float64Array(n), slope: 0 };
  const ctr = axis === 1 ? spl.W / 2 : spl.H / 2;
  const P = spl.penalty();
  const idx = new Int32Array(16), w = new Float64Array(16);
  const wg = new Float64Array(groups.length).fill(1);
  const consts = new Float64Array(groups.length);
  let coef = new Float64Array(n), slope = 0;
  const pos = (g, i, c0) => {
    const along = axis === 1 ? g.p.x[i] : g.p.y[i];
    if (axis === 1) return [along - (other ? spl.eval(other, along, c0) : 0), c0, along];
    return [c0, along - (other ? spl.eval(other, c0, along) : 0), along];
  };
  const dense = new Float64Array(nb), mark = new Uint8Array(nb), touched = new Int32Array(nb);
  for (let it = 0; it < iters; it++) {
    const A = new Float64Array(nb * nb), bv = new Float64Array(nb);
    const schur = [];                                 // per free structure: coupling (sparse), diagonal, rhs
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi], np = g.p.x.length;
      const obs = axis === 1 ? g.p.y : g.p.x;
      let c0;
      if (g.tgt === null) c0 = it ? consts[gi] : median(obs); else c0 = g.tgt;
      const ww = (g.w0 * wg[gi]) / Math.max(1, Math.sqrt(np / 20));
      const cpl = g.tgt === null ? dense : null;
      let D = 0, rc = 0, nt = 0;
      for (let i = 0; i < np; i++) {
        const [x, y, along] = pos(g, i, c0);
        spl.basis(x, y, idx, w);
        const sl = (along - ctr) / spl.W;
        const rhs = g.tgt === null ? obs[i] : obs[i] - g.tgt;
        for (let a = 0; a < 16; a++) {
          const ia = idx[a], wa = ww * w[a];
          bv[ia] += wa * rhs;
          for (let b2 = 0; b2 < 16; b2++) A[ia * nb + idx[b2]] += wa * w[b2];
          if (cpl) {
            A[ia * nb + n] += wa * sl; A[n * nb + ia] += wa * sl;
            if (!mark[ia]) { mark[ia] = 1; touched[nt++] = ia; }
            cpl[ia] += wa;
          }
        }
        if (cpl) {
          A[n * nb + n] += ww * sl * sl;
          bv[n] += ww * sl * rhs;
          if (!mark[n]) { mark[n] = 1; touched[nt++] = n; }
          cpl[n] += ww * sl;
          D += ww;
          rc += ww * rhs;
        }
      }
      if (cpl) {
        const ids = touched.slice(0, nt), vals = new Float64Array(nt);
        for (let q = 0; q < nt; q++) { vals[q] = cpl[ids[q]]; cpl[ids[q]] = 0; mark[ids[q]] = 0; }
        schur.push({ gi, ids, vals, D: D + 1e-6, rc });
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i * nb + j] += lam * P[i * n + j];
      A[i * nb + i] += 1e-3;
    }
    A[n * nb + n] += 1e-6;
    // eliminate each structure's own row/column position (Schur complement)
    for (const s of schur) {
      const ids = s.ids, vals = s.vals, k = ids.length;
      for (let a = 0; a < k; a++) {
        const i = ids[a], ci = vals[a] / s.D;
        bv[i] -= ci * s.rc;
        const row = i * nb;
        for (let b2 = 0; b2 < k; b2++) A[row + ids[b2]] -= ci * vals[b2];
      }
    }
    const x = solveDense(A, bv, nb);
    if (!x) break;
    coef = x.subarray(0, n);
    slope = x[n];
    for (const s of schur) {
      let t = s.rc;
      for (let a = 0; a < s.ids.length; a++) t -= s.vals[a] * x[s.ids[a]];
      consts[s.gi] = t / s.D;
    }
    // robust weights: structures that disagree with the rest count less
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi], np = g.p.x.length;
      const obs = axis === 1 ? g.p.y : g.p.x;
      const c0 = g.tgt === null ? consts[gi] : g.tgt;
      let ss = 0;
      for (let i = 0; i < np; i++) {
        const [px, py, along] = pos(g, i, c0);
        const pred = spl.eval(coef, px, py) + (g.tgt === null ? c0 + (slope * (along - ctr)) / spl.W : g.tgt);
        ss += (obs[i] - pred) ** 2;
      }
      const rms = Math.sqrt(ss / np);
      wg[gi] = 1 / (1 + (rms / 1.5) ** 2);
    }
  }
  return { coef: Float64Array.from(coef), slope };
}

const TIMES = { structures: 0, edges: 0, fit: 0, maps: 0 };
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function fitPass(gray, m, Wa, Ha) {
  const H = gray.rows, W = gray.cols;
  let t = now();
  let st = findStructures(gray);
  TIMES.structures += now() - t; t = now();
  const tdelta = FLAT.INSET / (2 * (1 - FLAT.INSET));
  const delta = [Wa * tdelta, Ha * tdelta];
  const edges = findEdges(gray, m, Wa, Ha, delta);
  TIMES.edges += now() - t; t = now();
  const region = pageRegion(H, W, m, Wa, Ha, edges);
  st = { rules: insideOnly(st.rules, region), texts: insideOnly(st.texts, region), vlines: insideOnly(st.vlines, region), hc: st.hc };
  region.delete();
  const [gx, gy] = H >= W ? FLAT.GRID : [FLAT.GRID[1], FLAT.GRID[0]];
  const spl = new Spline(W, H, gx, gy);
  const hor = st.rules.concat(st.texts);
  const horE = ["top", "bottom"].filter((k) => edges[k]).map((k) => edges[k]);
  const verE = ["left", "right"].filter((k) => edges[k]).map((k) => edges[k]);
  const cvv = fitField(spl, hor, horE, null, 1).coef;
  const cu = fitField(spl, st.vlines, verE, cvv, 0).coef;
  // how far the correction would move things inside the page, and how much of it is bending
  const pts = [];
  for (let y = m; y < m + Ha; y += 20) for (let x = m; x < m + Wa; x += 20) pts.push([x, y, spl.eval(cu, x, y), spl.eval(cvv, x, y)]);
  let move = 0, nonaff = 0;
  for (const p of pts) move = Math.max(move, Math.abs(p[2]), Math.abs(p[3]));
  for (const k of [2, 3]) {
    const M = new Float64Array(9), v = new Float64Array(3);
    for (const p of pts) {
      const r = [1, p[0], p[1]];
      for (let a = 0; a < 3; a++) { v[a] += r[a] * p[k]; for (let b = 0; b < 3; b++) M[a * 3 + b] += r[a] * r[b]; }
    }
    const c = solveDense(M, v, 3);
    if (c) for (const p of pts) nonaff = Math.max(nonaff, Math.abs(p[k] - (c[0] + c[1] * p[0] + c[2] * p[1])));
  }
  const info = { texts: st.texts.length, rules: st.rules.length, vlines: st.vlines.length, edges: Object.keys(edges).sort(), move, nonaff, hc: st.hc };
  TIMES.fit += now() - t;
  return { field: { spl, cu, cv: cvv }, info };
}

// Flat coordinates of the last pass -> analysis coordinates, through every pass (last first).
function compose(fields, x, y) {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    const dx = f.spl.eval(f.cu, x, y), dy = f.spl.eval(f.cv, x, y);
    x += dx; y += dy;
  }
  return [x, y];
}

// A W x H sampling map from a function, computed every 8 px and filled in by a bilinear resize.
// Samples sit at x = 8i - 4.5, so pixel X of the resized map is exactly x = X - 8.
function smoothMap(W, H, fn) {
  const step = 8, nx = Math.floor(W / step) + 3, ny = Math.floor(H / step) + 3;
  const mx = new cv.Mat(ny, nx, cv.CV_32F), my = new cv.Mat(ny, nx, cv.CV_32F);
  const X = mx.data32F, Y = my.data32F;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [sx, sy] = fn(i * step - 4.5, j * step - 4.5);
      X[j * nx + i] = sx; Y[j * nx + i] = sy;
    }
  }
  const big = new cv.Size(nx * step, ny * step), rect = new cv.Rect(step, step, W, H);
  const out = [];
  for (const m of [mx, my]) {
    const r = new cv.Mat();
    cv.resize(m, r, big, 0, 0, cv.INTER_LINEAR);
    const roi = r.roi(rect);
    out.push(roi.clone());
    roi.delete(); r.delete(); m.delete();
  }
  return out;
}

// Fit the correction for an analysis image (grey, page at [m, m+Wa] x [m, m+Ha]).
function solveFlatten(gray, m, Wa, Ha, passes = FLAT.PASSES) {
  for (const k of Object.keys(TIMES)) TIMES[k] = 0;
  const H = gray.rows, W = gray.cols;
  const fields = [], infos = [];
  let cur = gray;
  try {
    for (let p = 0; p < passes; p++) {
      const { field, info } = fitPass(cur, m, Wa, Ha);
      infos.push(info);
      if (p === 0) {
        if (!(info.nonaff > FLAT.MIN_NONAFFINE || info.move > FLAT.MIN_MOVE)) break;
        if (info.move > FLAT.MAX_MOVE) break;
      } else if (info.move < FLAT.STOP) {
        break;
      }
      fields.push(field);
      if (p < passes - 1) {
        const t = now();
        const [mx, my] = smoothMap(W, H, (x, y) => compose(fields, x, y));
        const next = new cv.Mat();
        cv.remap(gray, next, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
        mx.delete(); my.delete();
        if (cur !== gray) cur.delete();
        cur = next;
        TIMES.maps += now() - t;
      }
    }
  } finally {
    if (cur !== gray) cur.delete();
  }
  const first = infos[0] || {};
  const times = {};
  for (const k of Object.keys(TIMES)) times[k] = Math.round(TIMES[k]);
  return { fields, info: Object.assign({}, first, { applied: fields.length > 0, passes: fields.length, moves: infos.map((i) => +i.move.toFixed(1)), times }) };
}

// Crop, straighten and flatten one page. frame: RGBA Mat; quad: inset corners in frame px (TL TR BR BL);
// outW x outH: output size; resize(w, h) may change it once the page has been flattened (a bent page's
// corners understate its size). Returns { mat, info }.
function flattenPage(frame, quad, outW, outH, resize) {
  const Hf = frame.rows, Wf = frame.cols;
  const s = FLAT.LA / Math.max(outW, outH);
  const Wa = Math.round(outW * s), Ha = Math.round(outH * s);
  const m = Math.round(FLAT.MARGIN * FLAT.LA);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const side = Math.max(d(quad[0], quad[1]), d(quad[1], quad[2]), d(quad[2], quad[3]), d(quad[3], quad[0]));
  const sf = Math.min(1, (1.3 * FLAT.LA) / side);
  const mats = [];
  try {
    const grayF = new cv.Mat();
    mats.push(grayF);
    cv.cvtColor(frame, grayF, cv.COLOR_RGBA2GRAY);
    let small = grayF;
    if (sf < 1) {
      small = new cv.Mat();
      mats.push(small);
      cv.resize(grayF, small, new cv.Size(Math.round(Wf * sf), Math.round(Hf * sf)), 0, 0, cv.INTER_AREA);
    }
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(([x, y]) => [x * sf, y * sf]));
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [m, m, m + Wa, m, m + Wa, m + Ha, m, m + Ha]);
    const T = cv.getPerspectiveTransform(src, dst);
    mats.push(src, dst, T);
    const AW = Wa + 2 * m, AH = Ha + 2 * m;
    const ana = new cv.Mat();
    mats.push(ana);
    cv.warpPerspective(small, ana, T, new cv.Size(AW, AH), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const { fields, info } = solveFlatten(ana, m, Wa, Ha);
    if (fields.length && resize) [outW, outH] = resize(outW, outH);
    // output pixel -> flat analysis -> (through the correction) analysis -> frame
    const Ti = new cv.Mat();
    mats.push(Ti);
    cv.invert(T, Ti, cv.DECOMP_LU);
    const t = Ti.data64F;
    const [mx, my] = smoothMap(outW, outH, (ox, oy) => {
      let [ax, ay] = compose(fields, m + (ox / (outW - 1)) * Wa, m + (oy / (outH - 1)) * Ha);
      const den = t[6] * ax + t[7] * ay + t[8];
      return [(t[0] * ax + t[1] * ay + t[2]) / den / sf, (t[3] * ax + t[4] * ay + t[5]) / den / sf];
    });
    mats.push(mx, my);
    const out = new cv.Mat();
    cv.remap(frame, out, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    return { mat: out, info };
  } finally {
    for (const x of mats) x.delete();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { FLAT, Spline, polyfit, polyval, solveDense, findStructures, findEdges, fitField, fitPass, solveFlatten, flattenPage, compose, smoothMap, median, subsample };
}
