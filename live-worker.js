/* Audit Scan live outline. Every camera frame comes here (as a VideoFrame, or as a small picture drawn by
   the page when VideoFrame copies aren't usable). The outline is snapped to the paper's edges in each frame,
   so it follows the page closely, and the AI page finder (ml-worker, reached through a MessagePort) is asked
   where the page is, to find it in the first place and to catch the outline drifting off it. */
"use strict";

const GL = 640;          // long side of the grey picture the edges are looked for in (px)
const AI = 224;          // AI page finder input (px)
const AI_MIN = 0.5;      // AI confidence needed to call something a page

/* ---------- Grey picture and AI input from a camera frame ---------- */
let grey = null, blurTmp = null, gw = 0, gh = 0;
let planes = null;                    // reused copy of the frame's pixels
let colIdx = null, rowIdx = null, idxKey = "";
let aiCol = null, aiRow = null, aiCCol = null, aiCRow = null, aiKey = "", aiN = 3;

function sizeGrey(w, h) {
  const s = GL / Math.max(w, h);
  const nw = Math.max(16, Math.round(w * s)), nh = Math.max(16, Math.round(h * s));
  if (nw !== gw || nh !== gh) {
    gw = nw; gh = nh;
    grey = new Float32Array(gw * gh);
    blurTmp = new Float32Array(gw * gh);
    trk.reset();
  }
}

// 3 x 3 box blur in place (two passes)
function blur3(g, w, h) {
  const t = blurTmp;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    t[o] = (g[o] * 2 + g[o + 1]) / 3;
    for (let x = 1; x < w - 1; x++) t[o + x] = (g[o + x - 1] + g[o + x] + g[o + x + 1]) / 3;
    t[o + w - 1] = (g[o + w - 2] + g[o + w - 1] * 2) / 3;
  }
  for (let x = 0; x < w; x++) g[x] = (t[x] * 2 + t[x + w]) / 3;
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) g[o + x] = (t[o + x - w] + t[o + x] + t[o + x + w]) / 3;
  }
  const o = (h - 1) * w;
  for (let x = 0; x < w; x++) g[o + x] = (t[o + x - w] + t[o + x] * 2) / 3;
}

// Where to sample the copied frame (vw x vh): two points per grey pixel each way, a quarter and three
// quarters across; for the AI picture three brightness points each way (four for big frames, so fine
// print doesn't turn into noise) and two colour points.
function indexFor(vw, vh) {
  const key = `${vw},${vh},${gw},${gh}`;
  if (key === idxKey) return;
  idxKey = key;
  colIdx = new Int32Array(gw * 2); rowIdx = new Int32Array(gh * 2);
  const sx = vw / gw, sy = vh / gh;
  for (let x = 0; x < gw; x++) {
    colIdx[2 * x] = Math.min(vw - 1, Math.floor((x + 0.25) * sx));
    colIdx[2 * x + 1] = Math.min(vw - 1, Math.floor((x + 0.75) * sx));
  }
  for (let y = 0; y < gh; y++) {
    rowIdx[2 * y] = Math.min(vh - 1, Math.floor((y + 0.25) * sy));
    rowIdx[2 * y + 1] = Math.min(vh - 1, Math.floor((y + 0.75) * sy));
  }
}
function aiIndexFor(vw, vh) {
  const key = `${vw},${vh}`;
  if (key === aiKey) return;
  aiKey = key;
  const bx = vw / AI, by = vh / AI;
  aiN = Math.max(bx, by) >= 6 ? 4 : 3;
  aiCol = new Int32Array(AI * aiN); aiRow = new Int32Array(AI * aiN);
  aiCCol = new Int32Array(AI * 2); aiCRow = new Int32Array(AI * 2);
  for (let i = 0; i < AI; i++) {
    for (let j = 0; j < aiN; j++) {
      aiCol[aiN * i + j] = Math.min(vw - 1, Math.floor((i + (2 * j + 1) / (2 * aiN)) * bx));
      aiRow[aiN * i + j] = Math.min(vh - 1, Math.floor((i + (2 * j + 1) / (2 * aiN)) * by));
    }
    for (let j = 0; j < 2; j++) {
      aiCCol[2 * i + j] = Math.min(vw - 1, Math.floor((i + 0.25 + 0.5 * j) * bx)) >> 1;
      aiCRow[2 * i + j] = Math.min(vh - 1, Math.floor((i + 0.25 + 0.5 * j) * by)) >> 1;
    }
  }
}

// YUV -> RGB for the frame's colour space (BT.601, limited range, unless the frame says otherwise).
function yuvMatrix(cs) {
  const bt709 = cs && cs.matrix === "bt709";
  const full = cs && cs.fullRange === true;
  const kr = bt709 ? 0.2126 : 0.299, kb = bt709 ? 0.0722 : 0.114, kg = 1 - kr - kb;
  return {
    ys: full ? 1 : 255 / 219, yo: full ? 0 : 16, cs: full ? 1 : 255 / 224,
    rv: 2 * (1 - kr), gu: (-2 * kb * (1 - kb)) / kg, gv: (-2 * kr * (1 - kr)) / kg, bu: 2 * (1 - kb),
  };
}

const RGBX = new Set(["RGBA", "RGBX", "BGRA", "BGRX"]);
const FORMATS = new Set(["I420", "I420A", "NV12", ...RGBX]);

// Grey picture (and, when wanted, the AI's 224 x 224 picture) from a copied frame. The copy holds the
// frame's visible area only, so positions run from 0.
function fromPlanes(buf, layout, format, vw, vh, cs, wantAI) {
  if (!FORMATS.has(format)) throw new Error("Frame format " + format + " isn't handled");
  sizeGrey(vw, vh);
  indexFor(vw, vh);
  const rgb = RGBX.has(format), bgr = format[0] === "B";
  const yOff = layout[0].offset, yStr = layout[0].stride;
  if (rgb) {
    const r = bgr ? 2 : 0, b = bgr ? 0 : 2;
    for (let y = 0; y < gh; y++) {
      const r0 = yOff + rowIdx[2 * y] * yStr, r1 = yOff + rowIdx[2 * y + 1] * yStr, o = y * gw;
      for (let x = 0; x < gw; x++) {
        const c0 = colIdx[2 * x] * 4, c1 = colIdx[2 * x + 1] * 4;
        const p = r0 + c0, q = r0 + c1, s = r1 + c0, t = r1 + c1;
        grey[o + x] = 0.25 * (0.299 * (buf[p + r] + buf[q + r] + buf[s + r] + buf[t + r]) +
          0.587 * (buf[p + 1] + buf[q + 1] + buf[s + 1] + buf[t + 1]) + 0.114 * (buf[p + b] + buf[q + b] + buf[s + b] + buf[t + b]));
      }
    }
  } else {
    for (let y = 0; y < gh; y++) {
      const r0 = yOff + rowIdx[2 * y] * yStr, r1 = yOff + rowIdx[2 * y + 1] * yStr, o = y * gw;
      for (let x = 0; x < gw; x++) {
        const c0 = colIdx[2 * x], c1 = colIdx[2 * x + 1];
        grey[o + x] = (buf[r0 + c0] + buf[r0 + c1] + buf[r1 + c0] + buf[r1 + c1]) * 0.25;
      }
    }
  }
  blur3(grey, gw, gh);
  if (!wantAI) return null;
  aiIndexFor(vw, vh);
  const out = new Uint8ClampedArray(AI * AI * 4);
  if (rgb) {
    const r = bgr ? 2 : 0, b = bgr ? 0 : 2;
    const nn = aiN * aiN;
    for (let y = 0; y < AI; y++) {
      for (let x = 0; x < AI; x++) {
        let R = 0, Gc = 0, B = 0;
        for (let j = 0; j < aiN; j++) {
          const row = yOff + aiRow[aiN * y + j] * yStr;
          for (let i = 0; i < aiN; i++) { const p = row + aiCol[aiN * x + i] * 4; R += buf[p + r]; Gc += buf[p + 1]; B += buf[p + b]; }
        }
        const o = (y * AI + x) * 4;
        out[o] = R / nn; out[o + 1] = Gc / nn; out[o + 2] = B / nn; out[o + 3] = 255;
      }
    }
    return out;
  }
  const M = yuvMatrix(cs);
  const nv12 = format === "NV12";
  const uOff = layout[1].offset, uStr = layout[1].stride;
  const vOff = nv12 ? uOff + 1 : layout[2].offset, vStr = nv12 ? uStr : layout[2].stride, cStep = nv12 ? 2 : 1;
  const rows = new Int32Array(aiN), nn = aiN * aiN;
  for (let y = 0; y < AI; y++) {
    for (let j = 0; j < aiN; j++) rows[j] = yOff + aiRow[aiN * y + j] * yStr;
    const cu0 = uOff + aiCRow[2 * y] * uStr, cu1 = uOff + aiCRow[2 * y + 1] * uStr;
    const cv0 = vOff + aiCRow[2 * y] * vStr, cv1 = vOff + aiCRow[2 * y + 1] * vStr;
    for (let x = 0; x < AI; x++) {
      let Y = 0;
      for (let j = 0; j < aiN; j++) {
        const row = rows[j];
        for (let i = 0; i < aiN; i++) Y += buf[row + aiCol[aiN * x + i]];
      }
      Y /= nn;
      const u0 = aiCCol[2 * x] * cStep, u1 = aiCCol[2 * x + 1] * cStep;
      const U = (buf[cu0 + u0] + buf[cu0 + u1] + buf[cu1 + u0] + buf[cu1 + u1]) / 4;
      const V = (buf[cv0 + u0] + buf[cv0 + u1] + buf[cv1 + u0] + buf[cv1 + u1]) / 4;
      const yy = (Y - M.yo) * M.ys, u = (U - 128) * M.cs, v = (V - 128) * M.cs;
      const o = (y * AI + x) * 4;
      out[o] = yy + M.rv * v; out[o + 1] = yy + M.gu * u + M.gv * v; out[o + 2] = yy + M.bu * u; out[o + 3] = 255;
    }
  }
  return out;
}

// Grey picture (and AI picture) from an RGBA picture of the whole frame drawn by the page.
function fromRGBA(px, w, h, wantAI) {
  sizeGrey(w, h);
  if (w !== gw || h !== gh) throw new Error("Unexpected picture size");
  for (let i = 0, j = 0; i < gw * gh; i++, j += 4) grey[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  blur3(grey, gw, gh);
  if (!wantAI) return null;
  const out = new Uint8ClampedArray(AI * AI * 4);
  const bx = w / AI, by = h / AI;
  for (let y = 0; y < AI; y++) {
    const y0 = Math.floor(y * by), y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
    for (let x = 0; x < AI; x++) {
      const x0 = Math.floor(x * bx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx));
      let R = 0, Gc = 0, B = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { const p = (yy * w + xx) * 4; R += px[p]; Gc += px[p + 1]; B += px[p + 2]; n++; }
      }
      const o = (y * AI + x) * 4;
      out[o] = R / n; out[o + 1] = Gc / n; out[o + 2] = B / n; out[o + 3] = 255;
    }
  }
  return out;
}

// 24 x 24 brightness sketch of the frame, used by the page to notice a page being turned.
function signature() {
  const out = new Uint8Array(576);
  for (let gy = 0, j = 0; gy < 24; gy++) {
    const y0 = Math.floor((gy * gh) / 24), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * gh) / 24));
    for (let gx = 0; gx < 24; gx++, j++) {
      const x0 = Math.floor((gx * gw) / 24), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * gw) / 24));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += grey[y * gw + x]; n++; }
      out[j] = n ? s / n : 0;
    }
  }
  return out;
}

/* ---------- Snapping the outline to the paper's edges ----------
   Each side is searched along its normal, within R px, at K points. A paper edge is a brightness step that
   holds at two scales: a narrow one (2 px each side) that places it precisely, and a wide one (9 px each side,
   3 px clear of the edge) that a thin printed line or table rule can't fake. The points found are fitted with
   a straight line, robustly, so text and shadows that fool a few points don't move it. */
const K = 20, NA = 2, WG = 3, WB = 8, MM = WG + WB, T_STEP = 7, INL = 1.6, RMAX = 28;
const prof = new Float64Array(2 * (RMAX + MM) + 2);
const cum = new Float64Array(prof.length + 1);
const okv = new Uint8Array(prof.length);
const resp = [new Float64Array(prof.length), new Float64Array(prof.length)];
const OUTER = 0.6;   // an edge further out wins if it's at least this strong compared with the strongest
const tk = new Float64Array(K), offs = [new Float64Array(K), new Float64Array(K)], good = [new Uint8Array(K), new Uint8Array(K)];
for (let k = 0; k < K; k++) tk[k] = 0.07 + (0.86 * k) / (K - 1);

function bil(x, y) {
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * gw + x0;
  const a = grey[i], b = grey[i + 1], c = grey[i + gw], d = grey[i + gw + 1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

function fitLine(sign, out) {
  const g = good[sign], o = offs[sign];
  const tt = [], oo = [];
  for (let k = 0; k < K; k++) if (g[k]) { tt.push(tk[k] - 0.5); oo.push(o[k]); }
  const m = tt.length;
  if (m < 4) return 0;
  const sorted = oo.slice().sort((a, b) => a - b);
  const cands = [[sorted[m >> 1], 0]];
  for (let i = 0; i < m; i += 2) {
    for (let j = i + 1; j < m; j += 3) {
      if (Math.abs(tt[j] - tt[i]) > 0.15) { const b = (oo[j] - oo[i]) / (tt[j] - tt[i]); cands.push([oo[i] - b * tt[i], b]); }
    }
  }
  let bestN = -1, ba = 0, bb = 0;
  for (const [a, b] of cands) {
    let n = 0;
    for (let i = 0; i < m; i++) if (Math.abs(oo[i] - (a + b * tt[i])) < INL) n++;
    if (n > bestN) { bestN = n; ba = a; bb = b; }
  }
  if (bestN >= 3) {
    let s1 = 0, st = 0, so = 0, stt = 0, sto = 0;
    for (let i = 0; i < m; i++) {
      if (Math.abs(oo[i] - (ba + bb * tt[i])) >= INL) continue;
      s1++; st += tt[i]; so += oo[i]; stt += tt[i] * tt[i]; sto += tt[i] * oo[i];
    }
    const den = s1 * stt - st * st;
    if (Math.abs(den) > 1e-9) { bb = (s1 * sto - st * so) / den; ba = (so - bb * st) / s1; }
    else ba = so / s1;
  }
  out.a = ba; out.b = bb; out.c = 0;
  // A page that isn't lying flat has bowed edges. Try a gentle curve, o = a + b u + c (u^2 - 1/12), through
  // the points near the line, and keep it if it fits clearly more of them.
  if (bestN >= 8) {
    const sel = [];
    for (let i = 0; i < m; i++) if (Math.abs(oo[i] - (ba + bb * tt[i])) < 4) sel.push(i);
    if (sel.length >= 8) {
      // normal equations for (a, b, c); the basis is orthogonal for evenly spread u
      let A00 = 0, A01 = 0, A02 = 0, A11 = 0, A12 = 0, A22 = 0, r0 = 0, r1 = 0, r2 = 0;
      for (const i of sel) {
        const u = tt[i], w = u * u - 1 / 12, o = oo[i];
        A00 += 1; A01 += u; A02 += w; A11 += u * u; A12 += u * w; A22 += w * w; r0 += o; r1 += u * o; r2 += w * o;
      }
      const det = A00 * (A11 * A22 - A12 * A12) - A01 * (A01 * A22 - A12 * A02) + A02 * (A01 * A12 - A11 * A02);
      if (Math.abs(det) > 1e-12) {
        const qa = (r0 * (A11 * A22 - A12 * A12) - A01 * (r1 * A22 - A12 * r2) + A02 * (r1 * A12 - A11 * r2)) / det;
        const qb = (A00 * (r1 * A22 - A12 * r2) - r0 * (A01 * A22 - A12 * A02) + A02 * (A01 * r2 - r1 * A02)) / det;
        const qc = (A00 * (A11 * r2 - r1 * A12) - A01 * (A01 * r2 - r1 * A02) + r0 * (A01 * A12 - A11 * A02)) / det;
        let nq = 0;
        for (let i = 0; i < m; i++) if (Math.abs(oo[i] - (qa + qb * tt[i] + qc * (tt[i] * tt[i] - 1 / 12))) < INL) nq++;
        // only when the straight line clearly misses (a straight edge fits nearly all its points)
        if (nq >= bestN + 3 && bestN < 0.7 * m && Math.abs(qc) >= 3) { out.a = qa; out.b = qb; out.c = qc; return nq; }
      }
    }
  }
  return bestN;
}

// One side, P0 -> P1 in grey px, page centre (cx, cy). Returns null, or where the edge found starts and
// ends with its direction at each end: [sx, sy, ex, ey, dsx, dsy, dex, dey].
function snapSide(P0x, P0y, P1x, P1y, cx, cy, R) {
  const dx = P1x - P0x, dy = P1y - P0y, L = Math.hypot(dx, dy) || 1e-9;
  let nx = -dy / L, ny = dx / L;
  if (((P0x + P1x) / 2 - cx) * nx + ((P0y + P1y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
  const S = 2 * (R + MM) + 1;
  for (let k = 0; k < K; k++) {
    const px = P0x + tk[k] * dx, py = P0y + tk[k] * dy;
    cum[0] = 0;
    for (let j = 0; j < S; j++) {
      const s = j - R - MM, x = px + s * nx, y = py + s * ny;
      const inside = x >= 0 && y >= 0 && x <= gw - 1.001 && y <= gh - 1.001;
      okv[j] = inside ? 1 : 0;
      cum[j + 1] = cum[j] + (inside ? bil(x, y) : 0);
    }
    // the part of the profile inside the frame (one stretch, as the frame is convex)
    let lo = 0, hi = S - 1;
    while (lo < S && !okv[lo]) lo++;
    while (hi >= 0 && !okv[hi]) hi--;
    let best0 = -1e9, best1 = -1e9, j0 = -1, j1 = -1;
    const r0 = resp[0], r1 = resp[1];
    for (let j = MM; j <= MM + 2 * R; j++) {
      r0[j] = -1e9; r1[j] = -1e9;
      // an edge close to the frame border still counts if a few px of what's beyond it are in view
      if (j - MM < lo || j + NA > hi) continue;
      const e = j + MM < hi ? j + MM : hi;
      if (e - (j + WG) + 1 < 3) continue;
      const rn = (cum[j] - cum[j - NA]) / NA - (cum[j + NA + 1] - cum[j + 1]) / NA;
      const rw = (cum[j - WG + 1] - cum[j - MM]) / (WB + 1) - (cum[e + 1] - cum[j + WG]) / (e - (j + WG) + 1);
      const p = rn < rw ? rn : rw, q = -rn < -rw ? -rn : -rw;
      r0[j] = p; r1[j] = q;
      if (p > best0) { best0 = p; j0 = j; }
      if (q > best1) { best1 = q; j1 = j; }
    }
    // The page's own edge is the outermost thing on the page: a table column or a printed rule inside it
    // can look like an edge too, so a peak further out that is nearly as strong is taken instead.
    for (let sign = 0; sign < 2; sign++) {
      const r = resp[sign], best = sign === 0 ? best0 : best1;
      if (best <= T_STEP) continue;
      for (let j = MM + 2 * R; j > (sign === 0 ? j0 : j1); j--) {
        if (r[j] >= OUTER * best && r[j] > T_STEP && r[j] >= r[j - 1] && (j === MM + 2 * R || r[j] >= r[j + 1])) {
          if (sign === 0) { j0 = j; best0 = r[j]; } else { j1 = j; best1 = r[j]; }
          break;
        }
      }
    }
    for (let sign = 0; sign < 2; sign++) {
      const jb = sign === 0 ? j0 : j1, val = sign === 0 ? best0 : best1;
      if (jb < 0 || val <= T_STEP) { good[sign][k] = 0; continue; }
      good[sign][k] = 1;
      let off = jb - R - MM;
      if (jb > MM && jb < MM + 2 * R) {
        const sg = sign === 0 ? 1 : -1;
        const rnAt = (j) => sg * ((cum[j] - cum[j - NA]) / NA - (cum[j + NA + 1] - cum[j + 1]) / NA);
        const a = rnAt(jb - 1), b = rnAt(jb), c = rnAt(jb + 1), den = a - 2 * b + c;
        if (den < 0) off += Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
      }
      offs[sign][k] = off;
    }
  }
  const f0 = {}, f1 = {};
  const n0 = fitLine(0, f0), n1 = fitLine(1, f1);
  const f = n0 >= n1 ? f0 : f1, n = Math.max(n0, n1);
  if (n < Math.max(6, 0.45 * K)) return null;
  const o0 = f.a - 0.5 * f.b + f.c / 6, o1 = f.a + 0.5 * f.b + f.c / 6, g0 = f.b - f.c, g1 = f.b + f.c;
  return [P0x + o0 * nx, P0y + o0 * ny, P1x + o1 * nx, P1y + o1 * ny, dx + g0 * nx, dy + g0 * ny, dx + g1 * nx, dy + g1 * ny];
}

function intersect(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  const d1x = ax1 - ax0, d1y = ay1 - ay0, d2x = bx1 - bx0, d2y = by1 - by0;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((bx0 - ax0) * d2y - (by0 - ay0) * d2x) / den;
  return [ax0 + t * d1x, ay0 + t * d1y];
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}
function area(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}

// A side lying along the frame's border: the AI pins corners it can't see there, so it isn't a real edge.
function onBorder(a, b, tol = 1.5) {
  return (a[0] <= tol && b[0] <= tol) || (a[1] <= tol && b[1] <= tol) ||
    (a[0] >= gw - tol && b[0] >= gw - tol) || (a[1] >= gh - tol && b[1] >= gh - tol);
}

// Returns { q, sides, ok } in grey px; q is the input unchanged when the snap isn't trustworthy.
function snapQuad(Q, R) {
  const cx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, cy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
  const lines = [], ok = [false, false, false, false];
  let sides = 0;
  for (let i = 0; i < 4; i++) {
    const a = Q[i], b = Q[(i + 1) % 4];
    const s = onBorder(a, b) ? null : snapSide(a[0], a[1], b[0], b[1], cx, cy, R);
    if (s) { sides++; ok[i] = true; lines.push(s); } else lines.push([a[0], a[1], b[0], b[1], b[0] - a[0], b[1] - a[1], b[0] - a[0], b[1] - a[1]]);
  }
  const out = [];
  const lim = R * 1.6 + 4;
  for (let i = 0; i < 4; i++) {
    // corner i: where the end of side i-1 meets the start of side i
    const e = lines[(i + 3) % 4], st = lines[i];
    const p = intersect(e[2], e[3], e[2] + e[6], e[3] + e[7], st[0], st[1], st[0] + st[4], st[1] + st[5]);
    if (!p || Math.abs(p[0] - Q[i][0]) > lim || Math.abs(p[1] - Q[i][1]) > lim) return { q: Q, sides: 0, ok: [false, false, false, false] };
    out.push(p);
  }
  if (!convex(out) || area(out) < 0.03 * gw * gh) return { q: Q, sides: 0, ok: [false, false, false, false] };
  return { q: out, sides, ok };
}

/* ---------- Tracker ---------- */
const trk = {
  q: null, v: null, src: "", miss: 0, weak: 0, boost: 0, hist: new Map(), strong: 0, agreeAt: 0, cvAt: 0, differ: 0, cf: -1, jumped: false,
  sideOk: [0, 0, 0, 0],      // frames in a row each side has sat on an edge
  cfOf: new Map(),           // worker frame number -> camera frame number
  unsure: -1,                // last frame before which a stall happened, until the AI confirms the outline
  reset() { this.q = null; this.v = null; this.src = ""; this.miss = 0; this.weak = 0; this.boost = 0; this.hist.clear(); this.strong = 0; this.differ = 0; this.cf = -1; this.sideOk = [0, 0, 0, 0]; this.unsure = -1; },
};
const ZERO = () => [[0, 0], [0, 0], [0, 0], [0, 0]];
const toPx = (q) => q.map(([x, y]) => [x * gw, y * gh]);
const toNorm = (q) => q.map(([x, y]) => [x / gw, y / gh]);

// Best corner correspondence between two quads (a finder may number the corners from another corner).
function align(A, ref) {
  let best = null, bd = Infinity;
  for (const order of [A, [A[0], A[3], A[2], A[1]]]) {
    for (let k = 0; k < 4; k++) {
      const r = [0, 1, 2, 3].map((i) => order[(i + k) % 4]);
      let d = 0;
      for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(r[i][0] - ref[i][0], r[i][1] - ref[i][1]));
      if (d < bd) { bd = d; best = r; }
    }
  }
  return { q: best, d: bd };
}

// A finder's answer about frame f: normalised corners, or null for "no page". src: "ai" or "cv".
function onFinder(f, quad, src) {
  if (!gw) return;
  const now = performance.now();
  if (!quad) {
    if (src !== "ai") return;
    ai.prev = null;
    trk.miss++;
    if (trk.miss >= 3 && trk.src === "ai") trk.reset();
    return;
  }
  if (src === "ai") trk.miss = 0;
  else {
    trk.cvAt = now;
    if (trk.q && trk.src === "ai") return;     // the AI's page wins
  }
  const A = toPx(quad);
  const ref = trk.hist.get(f);
  // The answer is a few frames old. Where its page is now: moved on as the AI's own last two answers moved
  // (used while the tracked outline isn't firmly on edges, so its own motion can't be trusted).
  const cfF = trk.cfOf.has(f) ? trk.cfOf.get(f) : f;
  let Ax = A;
  if (src === "ai") {
    const pv = ai.prev;
    if (pv && cfF > pv.cf && cfF - pv.cf <= 10) {
      const P = align(pv.q, A).q, k = (trk.cf - cfF) / (cfF - pv.cf);
      const lim = 0.03 * Math.hypot(gw, gh) * (cfF - pv.cf);
      if (k > 0 && P.every((p, i) => Math.hypot(A[i][0] - p[0], A[i][1] - p[1]) < lim)) {
        Ax = A.map((p, i) => [p[0] + (p[0] - P[i][0]) * k, p[1] + (p[1] - P[i][1]) * k]);
      }
    }
    ai.prev = { cf: cfF, q: A };
  }
  // No edges to hold on to (white paper on a white desk, say): the outline just follows the AI.
  if (src === "ai" && trk.q && trk.weak >= 2) {
    trk.q = align(Ax, trk.q).q; trk.src = src; trk.agreeAt = now; trk.v = ZERO();
    return;
  }
  if (trk.q && ref) {
    // The AI pins corners outside the view to its edge, so compare with the tracked corners pinned the same way.
    const refC = ref.map(([x, y]) => [Math.min(gw, Math.max(0, x)), Math.min(gh, Math.max(0, y))]);
    const m = align(A, refC);
    if (st.trace) st.events.push({ f, src, d: +(m.d / Math.hypot(gw, gh) * 100).toFixed(2), firm: trk.sideOk.every((n) => n >= 3), ok: trk.sideOk.join(",") });
    // An outline with all four sides on edges is trusted further than one with a side that's only a guess.
    const firm = trk.sideOk.every((n) => n >= 3) && !(trk.unsure >= 0 && f <= trk.unsure);
    const diag = Math.hypot(gw, gh);
    if (m.d < (firm ? 0.025 : 0.012) * diag) {
      trk.src = src; trk.differ = 0;
      if (src === "ai") { trk.agreeAt = now; if (trk.unsure >= 0 && f > trk.unsure) trk.unsure = -1; }
      return;
    }
    // Further off than that: start again from the finder's outline, moved on by however far the tracked
    // outline has moved since frame f. A firm outline waits for a second look that disagrees, so one odd
    // AI answer doesn't throw it off.
    if (src === "ai" && trk.src === "ai" && firm && ++trk.differ < 2) return;
    trk.differ = 0;
    if (firm || Ax === A) trk.q = m.q.map((p, i) => [p[0] + trk.q[i][0] - ref[i][0], p[1] + trk.q[i][1] - ref[i][1]]);
    else trk.q = align(Ax, trk.q).q;
  } else {
    trk.q = Ax;
  }
  trk.v = ZERO();
  trk.src = src; trk.boost = 2; trk.weak = 0; trk.strong = 0; trk.jumped = true;
  trk.sideOk = [0, 0, 0, 0];
  if (src === "ai") trk.agreeAt = now;
}

// f: frame number in this worker's sequence; cf: the camera's frame number (frames the page skipped count).
function track(f, cf) {
  trk.cfOf.set(f, cf);
  if (trk.q && trk.src === "cv" && performance.now() - trk.cvAt > 700) trk.reset();   // classical find not confirmed
  if (!trk.q) { trk.hist.set(f, null); trk.cf = cf; prune(f); return null; }
  // Expect the outline where its recent motion (per camera frame) takes it, and look further the faster it moves.
  const gap0 = trk.cf >= 0 && cf > trk.cf ? cf - trk.cf : 1;
  const gap = Math.min(8, gap0);
  trk.cf = cf;
  // After a stall (the phone was busy for a few frames) the outline may have lost the page: until the AI
  // has confirmed it on a frame from after the stall, it doesn't count as firm.
  if (gap0 > 3) trk.unsure = f;
  const v = trk.v || ZERO();
  // (over a long gap the motion may have stopped or turned, so expect at most two frames' worth and
  // look wider instead)
  const ahead = gap > 3 ? 2 : 0.8 * gap;
  const pred = trk.q.map((p, i) => [p[0] + ahead * v[i][0], p[1] + ahead * v[i][1]]);
  let vmax = 0;
  for (const d of v) vmax = Math.max(vmax, Math.abs(d[0]), Math.abs(d[1]));
  const R = Math.round(Math.min(RMAX, (trk.boost > 0 ? 22 : 12) + vmax * gap));
  if (trk.boost > 0) trk.boost--;
  const { q, sides, ok } = snapQuad(pred, R);
  for (let i = 0; i < 4; i++) trk.sideOk[i] = ok[i] ? trk.sideOk[i] + 1 : 0;
  if (sides >= 2) {
    trk.v = q.map((p, i) => [0.5 * (p[0] - trk.q[i][0]) / gap + 0.5 * v[i][0], 0.5 * (p[1] - trk.q[i][1]) / gap + 0.5 * v[i][1]]);
    trk.q = q; trk.weak = 0;
    trk.strong = sides >= 3 ? trk.strong + 1 : 0;
  } else {
    trk.weak++; trk.strong = 0;
    trk.q = pred;
    trk.v = v.map((d) => [d[0] * 0.5, d[1] * 0.5]);
  }
  // A page that has mostly left the view isn't worth outlining.
  if (insideShare(trk.q) < 0.5) { trk.reset(); trk.hist.set(f, null); prune(f); return null; }
  trk.hist.set(f, trk.q.map((p) => p.slice()));
  prune(f);
  return { quad: toNorm(trk.q), sides };
}
function prune(f) {
  for (const k of trk.hist.keys()) if (k < f - 40) trk.hist.delete(k);
  for (const k of trk.cfOf.keys()) if (k < f - 40) trk.cfOf.delete(k);
}

// Share of the quad's area inside the frame (the quad clipped to the frame, Sutherland-Hodgman).
function insideShare(q) {
  let poly = q.map((p) => p.slice());
  const edges = [[0, 1, 0], [0, -1, gw], [1, 1, 0], [1, -1, gh]];   // [axis, sign, offset]: sign * p[axis] + offset >= 0
  for (const [ax, sg, off] of edges) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = sg * a[ax] + off, db = sg * b[ax] + off;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
    poly = out;
    if (!poly.length) return 0;
  }
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const full = area(q);
  return full > 0 ? Math.abs(s) / 2 / full : 0;
}

/* ---------- AI requests ---------- */
const ai = { port: null, busy: false, frame: -1, sent: 0, seq: 0, ms: 0, n: 0, since: 0, hz: 0, ease: false, prev: null };
function wantAI(now) {
  if (!ai.port || ai.busy) return false;
  // While the outline sits firmly on the paper's edges and the AI agreed with it recently, a look every
  // 120 ms is plenty; while pages are being processed, one every 100 ms; otherwise as often as it can.
  const firm = trk.q && trk.src === "ai" && trk.strong >= 5 && now - trk.agreeAt < 400 && trk.unsure < 0 && insideShare(trk.q) > 0.98;
  return now - ai.sent >= (firm ? 120 : ai.ease ? 100 : 0);
}
function sendAI(px, f) {
  ai.busy = true; ai.frame = f; ai.sent = performance.now();
  ai.port.postMessage({ id: ++ai.seq, type: "detect", buffer: px.buffer }, [px.buffer]);
}
function onAIResult(e) {
  const m = e.data || {};
  if (m.id !== ai.seq) return;           // an answer from before a reset
  ai.busy = false;
  if (!m.ok) return;
  const r = m.result, now = performance.now();
  ai.ms = ai.ms ? ai.ms * 0.9 + r.ms * 0.1 : r.ms;
  ai.n++;
  if (!ai.since) ai.since = now;
  if (now - ai.since >= 1000) { const hz = (ai.n * 1000) / (now - ai.since); ai.hz = ai.hz ? ai.hz * 0.7 + hz * 0.3 : hz; ai.n = 0; ai.since = now; }
  const q = r.quad && r.score >= AI_MIN && area(r.quad) > 0.06 && convex(r.quad) ? r.quad : null;
  onFinder(ai.frame, q, "ai");
}

/* ---------- Frames from the page ---------- */
const st = { ms: 0, hz: 0, n: 0, since: 0, pad: 0, trace: false, events: [] };

async function onFrameMsg(m) {
  const t0 = performance.now();
  const f = m.seq;
  const wantsAI = wantAI(t0);
  let px = null;
  try {
    if (m.frame) {
      const vf = m.frame;
      try {
        if (vf.rotation || vf.flip) throw new Error("rotated frame");
        const size = vf.allocationSize();
        if (!planes || planes.length < size) planes = new Uint8Array(size);
        const layout = await vf.copyTo(planes);
        px = fromPlanes(planes, layout, vf.format, vf.visibleRect.width, vf.visibleRect.height, vf.colorSpace, wantsAI);
      } finally {
        vf.close();
      }
    } else {
      px = fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, wantsAI);
    }
  } catch (err) {
    self.postMessage({ type: "quad", seq: f, epoch: m.epoch, quad: null, error: String((err && err.message) || err), fallback: !!m.frame });
    return;
  }
  let res = null;
  try {
    if (px) sendAI(px, f);
    res = track(f, m.cf === undefined ? f : m.cf);
  } catch (err) {
    trk.reset();
    self.postMessage({ type: "quad", seq: f, epoch: m.epoch, quad: null, error: String((err && err.message) || err) });
    return;
  }
  if (st.pad) { const end = t0 + st.pad; while (performance.now() < end) { /* test hook: a slower phone */ } }
  const ms = performance.now() - t0;
  st.ms = st.ms ? st.ms * 0.9 + ms * 0.1 : ms;
  st.n++;
  if (!st.since) st.since = t0;
  if (t0 - st.since >= 1000) { const hz = (st.n * 1000) / (t0 - st.since); st.hz = st.hz ? st.hz * 0.7 + hz * 0.3 : hz; st.n = 0; st.since = t0; }
  self.postMessage({
    type: "quad", seq: f, epoch: m.epoch, quad: res ? res.quad : null, sides: res ? res.sides : 0, src: res ? trk.src : "", jump: !!trk.jumped,
    sig: signature(), stats: { liveMs: st.ms, liveHz: st.hz, aiMs: ai.ms, aiHz: ai.hz },
    trace: st.trace ? { ok: trk.sideOk.join(","), ev: st.events.splice(0) } : undefined,
  });
  trk.jumped = false;
}

// Checks that VideoFrame copies show the same picture as the video on screen (same way up, same framing).
async function onCheck(m) {
  const vf = m.frame;
  let ok = false, corr = 0, ms = 0;
  const format = vf.format || "";
  try {
    if (!vf.rotation && !vf.flip && FORMATS.has(format)) {
      const t0 = performance.now();
      const size = vf.allocationSize();
      if (!planes || planes.length < size) planes = new Uint8Array(size);
      const layout = await vf.copyTo(planes);
      fromPlanes(planes, layout, format, vf.visibleRect.width, vf.visibleRect.height, vf.colorSpace, false);
      ms = performance.now() - t0;
      const a = grey.slice();
      fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, false);
      const b = grey, n = a.length;
      let sa = 0, sb = 0;
      for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
      sa /= n; sb /= n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const x = a[i] - sa, y = b[i] - sb; num += x * y; da += x * x; db += y * y; }
      corr = da > 1 && db > 1 ? num / Math.sqrt(da * db) : (Math.abs(sa - sb) < 8 ? 1 : 0);
      ok = corr > 0.85;
    }
  } catch (_) {
    ok = false;
  } finally {
    try { vf.close(); } catch (_) { /* already closed */ }
  }
  self.postMessage({ type: "check", epoch: m.epoch, ok, corr, ms, format });
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "frame") onFrameMsg(m);
  else if (m.type === "check") onCheck(m);
  else if (m.type === "port") { ai.port = m.port; ai.port.onmessage = onAIResult; ai.busy = false; }
  else if (m.type === "ai-off") { ai.port = null; ai.busy = false; }
  else if (m.type === "cv") onFinder(m.seq, m.quad, "cv");
  else if (m.type === "reset") { trk.reset(); trk.cfOf.clear(); ai.busy = false; ai.seq++; ai.prev = null; }
  else if (m.type === "ease") ai.ease = !!m.on;
  else if (m.type === "debug") { st.pad = m.liveMs || 0; st.trace = !!m.trace; }
};
