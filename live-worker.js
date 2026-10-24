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
    mo.prev = null;
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

// Grey picture (and AI picture) from an RGBA picture of the whole frame: the grey picture's size, or (k = 2)
// twice that each way, averaged down (finer edges than a picture shrunk straight to size).
function fromRGBA(px, w, h, wantAI, k = 1) {
  sizeGrey(w / k, h / k);
  if (w !== gw * k || h !== gh * k) throw new Error("Unexpected picture size");
  if (k === 1) {
    for (let i = 0, j = 0; i < gw * gh; i++, j += 4) grey[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  } else {
    const rs = w * 4;
    for (let y = 0; y < gh; y++) {
      const r0 = 2 * y * rs, r1 = r0 + rs, o = y * gw;
      for (let x = 0, c = 0; x < gw; x++, c += 8) {
        const p = r0 + c, q = r1 + c;
        grey[o + x] = 0.25 * (0.299 * (px[p] + px[p + 4] + px[q] + px[q + 4]) + 0.587 * (px[p + 1] + px[p + 5] + px[q + 1] + px[q + 5]) +
          0.114 * (px[p + 2] + px[p + 6] + px[q + 2] + px[q + 6]));
      }
    }
  }
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
const cum = new Float64Array(prof.length + 1), cum2 = new Float64Array(prof.length + 1);
// A paper edge has blank paper on its inside: the profile there is flat. A block of text or a printed box (the
// column's edge looks like a step at the wide scale) isn't, so a candidate whose inside varies more than this
// (grey levels, standard deviation over the wide window) doesn't count.
let FLAT_IN = 10;

const okv = new Uint8Array(prof.length);
const resp = [new Float64Array(prof.length), new Float64Array(prof.length)];
const OUTER = 0.6;   // (mode "outer") an edge further out wins if it's at least this strong compared with the strongest
let PICK = "near";   // how a side picks among the edges in reach: "near" the expected line, or the "outer"most
let SWITCH = "edges";   // (tests) when the outline goes over to the finder's: "edges" when better on edges, "ai" when it insists
// A clear edge a little inside the expected line counts for more than one outside it: on a stack of sheets, or a page
// on a bigger sheet, the sheet underneath peeks out beyond the page's own edge, and the AI's outline tends to take
// that in; the page's edge is the inner of the two. Only within INNER_R (share of the diagonal) inward, so boxes and
// blocks printed on the page, further in, aren't preferred.
let INNER = 2.5, INNER_R = 0.015;
const tk = new Float64Array(K), offs = [new Float64Array(K), new Float64Array(K)], good = [new Uint8Array(K), new Uint8Array(K)];
const vals = [new Float64Array(K), new Float64Array(K)];
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

// One side, P0 -> P1 in grey px, page centre (cx, cy). Returns null, or { l, frac, str }: where the edge
// found starts and ends with its direction at each end (l = [sx, sy, ex, ey, dsx, dsy, dex, dey]), the
// share of the side it was found along, and how strong a step it is (grey levels).
// pick: "near" takes, at each point, the clear edge nearest the expected line (so a side stays on the edge
// it's on, or goes to the edge it's sent to, instead of hopping to a printed box or a sheet underneath);
// "outer" takes the outermost edge nearly as strong as the strongest.
// settled: the side has sat on its edge for a while, so the pick keeps sharply to where it's expected (the reach
// R still grows with the motion, but another edge within it has to be much the stronger to take the side).
function snapSide(P0x, P0y, P1x, P1y, cx, cy, R, pick = PICK, settled = false) {
  const sig = settled ? 3 : Math.max(3, R / 2.5), inw = Math.min(R, INNER_R * Math.hypot(gw, gh));
  const dx = P1x - P0x, dy = P1y - P0y, L = Math.hypot(dx, dy) || 1e-9;
  let nx = -dy / L, ny = dx / L;
  if (((P0x + P1x) / 2 - cx) * nx + ((P0y + P1y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
  const S = 2 * (R + MM) + 1;
  for (let k = 0; k < K; k++) {
    const px = P0x + tk[k] * dx, py = P0y + tk[k] * dy;
    cum[0] = 0; cum2[0] = 0;
    for (let j = 0; j < S; j++) {
      const s = j - R - MM, x = px + s * nx, y = py + s * ny;
      const inside = x >= 0 && y >= 0 && x <= gw - 1.001 && y <= gh - 1.001;
      okv[j] = inside ? 1 : 0;
      const v = inside ? bil(x, y) : 0;
      cum[j + 1] = cum[j] + v; cum2[j + 1] = cum2[j] + v * v;
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
      const sI = cum[j - WG + 1] - cum[j - MM], mI = sI / (WB + 1);
      if ((cum2[j - WG + 1] - cum2[j - MM]) / (WB + 1) - mI * mI > FLAT_IN * FLAT_IN) continue;   // not blank paper inside
      const rw = mI - (cum[e + 1] - cum[j + WG]) / (e - (j + WG) + 1);
      const p = rn < rw ? rn : rw, q = -rn < -rw ? -rn : -rw;
      r0[j] = p; r1[j] = q;
      if (p > best0) { best0 = p; j0 = j; }
      if (q > best1) { best1 = q; j1 = j; }
    }
    if (pick === "near") {
      // the peak (a local maximum) that's strongest once weighed by how near the expected line it is
      for (let sign = 0; sign < 2; sign++) {
        const r = resp[sign], best = sign === 0 ? best0 : best1;
        if (best <= T_STEP) continue;
        let bw = -1, bj = -1;
        for (let j = MM; j <= MM + 2 * R; j++) {
          const v = r[j];
          if (v <= T_STEP || v < 0.25 * best || (j > MM && v < r[j - 1]) || (j < MM + 2 * R && v < r[j + 1])) continue;
          const off = j - R - MM, sd = off / sig;
          const w = (v / (1 + sd * sd)) * (off < 0 && -off <= inw ? INNER : 1);
          if (w > bw) { bw = w; bj = j; }
        }
        if (bj >= 0) { if (sign === 0) { j0 = bj; best0 = r[bj]; } else { j1 = bj; best1 = r[bj]; } }
      }
    } else {
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
    }
    for (let sign = 0; sign < 2; sign++) {
      const jb = sign === 0 ? j0 : j1, val = sign === 0 ? best0 : best1;
      if (jb < 0 || val <= T_STEP) { good[sign][k] = 0; continue; }
      good[sign][k] = 1;
      vals[sign][k] = val;
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
  // (paper is brighter than what's around it: a step the other way, dark inside, is a printed block's edge more
  // often than a page's, and is taken only when it fits clearly more points)
  const sg = n1 >= n0 + 4 ? 1 : 0, f = sg ? f1 : f0, n = sg ? n1 : n0;
  if (n < Math.max(6, 0.45 * K)) return null;
  let sum = 0, cnt = 0;
  for (let k = 0; k < K; k++) {
    if (!good[sg][k]) continue;
    const u = tk[k] - 0.5;
    if (Math.abs(offs[sg][k] - (f.a + f.b * u + f.c * (u * u - 1 / 12))) < INL) { sum += vals[sg][k]; cnt++; }
  }
  const o0 = f.a - 0.5 * f.b + f.c / 6, o1 = f.a + 0.5 * f.b + f.c / 6, g0 = f.b - f.c, g1 = f.b + f.c;
  return {
    l: [P0x + o0 * nx, P0y + o0 * ny, P1x + o1 * nx, P1y + o1 * ny, dx + g0 * nx, dy + g0 * ny, dx + g1 * nx, dy + g1 * ny],
    frac: n / K, str: cnt ? sum / cnt : 0,
  };
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

// Does side i of outline Q (grey px) lie on a printed line rather than a paper edge? A printed rule or box border
// is a dark line with the same paper either side of it: along most of the side, the picture dips well below both
// 6 px inside and 6 px outside, and those two are about as bright as each other. A paper edge is a step (paper
// against the desk, or against the shadowed sheet underneath), not a dip between alike sides.
function onPrintedLine(Q, i) {
  const a = Q[i], b = Q[(i + 1) % 4];
  const cx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, cy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
  let nx = -dy / L, ny = dx / L;
  if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
  let n = 0, hits = 0;
  for (let k = 0; k < K; k++) {
    const px = a[0] + tk[k] * dx, py = a[1] + tk[k] * dy;
    const xi = px - 6 * nx, yi = py - 6 * ny, xo = px + 6 * nx, yo = py + 6 * ny;
    if (xi < 0 || yi < 0 || xi > gw - 1.001 || yi > gh - 1.001 || xo < 0 || yo < 0 || xo > gw - 1.001 || yo > gh - 1.001) continue;
    const vi = bil(xi, yi), vo = bil(xo, yo);
    let dip = Infinity;
    for (let o = -2; o <= 2; o++) dip = Math.min(dip, bil(px + o * nx, py + o * ny));
    n++;
    if (Math.abs(vi - vo) < 15 && vi - dip > 40 && vo - dip > 40) hits++;
  }
  return n >= 4 && hits > 0.6 * n;
}

// Returns { q, sides, ok, score } in grey px; q is the input unchanged when the snap isn't trustworthy.
// score: how well the outline sits on paper edges (0 to 4: each side's share on an edge, weighed by how
// clear the edge is).
const NONE = { sides: 0, ok: [false, false, false, false], score: 0 };
function snapQuad(Q, R, pick = PICK, settled = null) {
  const cx = (Q[0][0] + Q[1][0] + Q[2][0] + Q[3][0]) / 4, cy = (Q[0][1] + Q[1][1] + Q[2][1] + Q[3][1]) / 4;
  const lines = [], ok = [false, false, false, false];
  let sides = 0, score = 0;
  for (let i = 0; i < 4; i++) {
    const a = Q[i], b = Q[(i + 1) % 4];
    const s = onBorder(a, b) ? null : snapSide(a[0], a[1], b[0], b[1], cx, cy, R, pick, !!(settled && settled[i]));
    if (s) { sides++; ok[i] = true; lines.push(s.l); score += s.frac * Math.min(1, s.str / 30); }
    else lines.push([a[0], a[1], b[0], b[1], b[0] - a[0], b[1] - a[1], b[0] - a[0], b[1] - a[1]]);
  }
  const out = [];
  const lim = R * 1.6 + 4;
  for (let i = 0; i < 4; i++) {
    // corner i: where the end of side i-1 meets the start of side i
    const e = lines[(i + 3) % 4], st = lines[i];
    const p = intersect(e[2], e[3], e[2] + e[6], e[3] + e[7], st[0], st[1], st[0] + st[4], st[1] + st[5]);
    if (!p || Math.abs(p[0] - Q[i][0]) > lim || Math.abs(p[1] - Q[i][1]) > lim) return { q: Q, ...NONE };
    out.push(p);
  }
  if (!convex(out) || area(out) < 0.03 * gw * gh) return { q: Q, ...NONE };
  return { q: out, sides, ok, score };
}

/* ---------- Tracker ---------- */
const trk = {
  q: null, v: null, src: "", miss: 0, weak: 0, boost: 0, hist: new Map(), strong: 0, agreeAt: 0, cvAt: 0, differ: 0, cf: -1, jumped: false,
  proposal: null,            // a finder's outline to try against the edges in the next frame
  follow: null,              // with no edges to hold on to: the AI's outline the outline glides to ({ q, far })
  moOk: 0,                   // camera frames in a row the outline has kept to the page (on edges, or with the print)
  lastF: -1, jumpF: -1,      // the last frame followed; the frame from which the outline last jumped to a new place
  settled: false,            // the outline has been on the page (on its edges, or agreeing with the AI)
  sideOk: [0, 0, 0, 0],      // frames in a row each side has sat on an edge
  cfOf: new Map(),           // worker frame number -> camera frame number
  unsure: -1,                // last frame before which a stall happened, until the AI confirms the outline
  aiD: 1, aiAt: 0, far: 0,   // the AI's last answer: how far its page was from the outline (share of the diagonal),
                             // when it came, and how many answers running have put the page well away (see noteAI)
  agrees: 0,                 // the AI's answers that have agreed with the outline since it was put where it is
  shown: false, cut: false,  // the outline was shown on the last frame; it wasn't, as part of the page was out of view
  pull: [null, null, null, null], sidePull: null,   // per side: the AI's answers running that put the side a little inward (see notePulls)
  reset() { this.q = null; this.v = null; this.src = ""; this.miss = 0; this.weak = 0; this.boost = 0; this.hist.clear(); this.strong = 0; this.differ = 0; this.cf = -1; this.sideOk = [0, 0, 0, 0]; this.unsure = -1; this.proposal = null; this.lastProp = null; this.follow = null; this.moOk = 0; this.settled = false; this.jumpF = -1; this.aiD = 1; this.aiAt = 0; this.far = 0; this.agrees = 0; this.shown = false; this.pull = [null, null, null, null]; this.sidePull = null; },
};
const ZERO = () => [[0, 0], [0, 0], [0, 0], [0, 0]];
// How close the AI's outline must be to the tracked one to agree with it (share of the diagonal): an outline
// with all four sides on edges is given a little more room. Further off, the AI's outline is tried against
// the edges (see track: a proposal).
let AGREE_FIRM = 0.025, AGREE = 0.012;
const toPx = (q) => q.map(([x, y]) => [x * gw, y * gh]);
const toNorm = (q) => q.map(([x, y]) => [x / gw, y / gh]);

// Corners pinned to the picture, as the AI pins corners outside the view to its edge.
const pinned = (q) => q.map(([x, y]) => [Math.min(gw, Math.max(0, x)), Math.min(gh, Math.max(0, y))]);
// Largest distance between corresponding corners.
function maxApart(A, B) {
  let d = 0;
  for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]));
  return d;
}
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

// The AI's outline (Aq, corners matched to the tracked outline T, both in grey px) puts a side a little inside the
// tracked one: on a stack, a sheet underneath peeks out beyond the page and the side has settled on its edge, while
// the AI sees the page's own edge inside it. A pull on that side is noted; once the AI has said the same twice
// running, track() tries that side on the edge where the AI puts it (see sidePull). A side that isn't on any edge
// is pulled outward the same way (it has drifted inside the page). Sides along the view's border aren't compared
// (the AI pins corners it can't see there).
function notePulls(Aq, T) {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const a = T[i], b = T[(i + 1) % 4];
    if (onBorder(a, b)) { trk.pull[i] = null; continue; }
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    let nx = -dy / L, ny = dx / L;
    const cx = (T[0][0] + T[1][0] + T[2][0] + T[3][0]) / 4, cy = (T[0][1] + T[1][1] + T[2][1] + T[3][1]) / 4;
    if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }   // outward
    let o0 = (Aq[i][0] - a[0]) * nx + (Aq[i][1] - a[1]) * ny, o1 = (Aq[(i + 1) % 4][0] - b[0]) * nx + (Aq[(i + 1) % 4][1] - b[1]) * ny;
    // (a side on no edge may be pulled outward: the test below is written for inward pulls, so flip the signs)
    const sg = trk.sideOk[i] === 0 && o0 > 0 && o1 > 0 ? -1 : 1;
    o0 *= sg; o1 *= sg;
    // inward at both ends (by different amounts when the sheet underneath lies askew), clearly so at one end (more
    // than the AI's usual error), and not more than the reach of a snap
    if (o0 > -4 || o1 > -4 || Math.min(o0, o1) > -8 || Math.min(o0, o1) < -40) { trk.pull[i] = null; continue; }
    o0 *= sg; o1 *= sg;
    const P = trk.pull[i];
    const same = P && Math.abs(P.o0 - o0) < 0.5 * Math.abs(o0) + 6 && Math.abs(P.o1 - o1) < 0.5 * Math.abs(o1) + 6;
    trk.pull[i] = same ? { n: P.n + 1, o0: (P.o0 + o0) / 2, o1: (P.o1 + o1) / 2 } : { n: 1, o0, o1 };
    const size = Math.abs(o0 + o1) / 2;
    if (trk.pull[i].n >= 2 && (!best || size > best.size)) best = { i, o0: trk.pull[i].o0, o1: trk.pull[i].o1, size };
  }
  if (best) trk.sidePull = best;
}

// What the AI's answer says of the outline (d: how far apart, share of the diagonal). "Well away" is further than
// the AI is usually off: a little further for an outline that sits on paper edges.
function noteAI(d, now) {
  const edges = trk.sideOk.filter((n) => n >= 3).length >= 3;
  trk.aiD = d; trk.aiAt = now;
  trk.far = d > (edges ? 0.05 : 0.035) ? trk.far + 1 : 0;
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
  // An answer about a frame from before the outline last jumped to a new place says nothing about where the
  // outline is now (the jump came after it).
  if (trk.q && f < trk.jumpF) return;
  // No edges to hold on to (white paper on a white desk, say): the outline follows the AI, moved on to now as
  // the outline has moved since (see track: with the print on the page, or gliding).
  if (src === "ai" && trk.q && trk.weak >= 2) {
    // (moved on as the outline has moved since, when it has kept to the page all along, on edges or with the
    // print; otherwise as the AI's own last two answers moved)
    let T;
    if (ref && trk.moOk >= trk.cf - cfF) { const m = align(A, ref).q; T = m.map((p, i) => [p[0] + trk.q[i][0] - ref[i][0], p[1] + trk.q[i][1] - ref[i][1]]); }
    else T = align(Ax, trk.q).q;
    trk.src = src;
    // An answer well away from the outline: the outline goes straight there; but once the outline has been on
    // the page (on its edges, or agreeing with the AI), only when the answer before was well away too, so one
    // odd answer doesn't throw it off. Either way, the next frame also looks for edges around the AI's outline.
    const F = trk.follow, diag = Math.hypot(gw, gh), d = maxApart(pinned(T), pinned(trk.q));
    noteAI(d / diag, now);
    if (d > 0.025 * diag) {
      if (trk.settled && !(F && F.far)) { trk.follow = { q: F ? F.q : null, far: true }; return; }
      trk.q = T; trk.v = ZERO(); trk.boost = 1; trk.jumped = true; trk.settled = false; trk.jumpF = trk.lastF + 1; trk.moOk = 0;
      trk.follow = { q: T, far: true }; trk.agrees = 1;
    } else {
      trk.follow = { q: T };
      trk.settled = true; trk.agrees++;
    }
    trk.agreeAt = now;
    trk.proposal = { q: T, d: d / diag, src };
    return;
  }
  if (trk.q && ref) {
    // The AI pins corners outside the view to its edge, so compare with the tracked corners pinned the same way.
    const refC = ref.map(([x, y]) => [Math.min(gw, Math.max(0, x)), Math.min(gh, Math.max(0, y))]);
    const m = align(A, refC);
    if (src === "ai") { noteAI(m.d / Math.hypot(gw, gh), now); notePulls(m.q, refC); }
    if (st.trace) st.events.push({ f, src, d: +(m.d / Math.hypot(gw, gh) * 100).toFixed(2), firm: trk.sideOk.every((n) => n >= 3), ok: trk.sideOk.join(",") });
    // An outline with all four sides on edges is trusted further than one with a side that's only a guess.
    const firm = trk.sideOk.every((n) => n >= 3) && !(trk.unsure >= 0 && f <= trk.unsure);
    const diag = Math.hypot(gw, gh);
    if (m.d < (firm ? AGREE_FIRM : AGREE) * diag) {
      trk.src = src; trk.differ = 0; trk.lastProp = null;
      if (src === "ai") { trk.agreeAt = now; trk.agrees++; if (trk.unsure >= 0 && f > trk.unsure) trk.unsure = -1; }
      return;
    }
    // The finder sees the page somewhere else. It isn't always right (a desk edge or a shadow can fool the AI
    // by a few per cent), and the outline shouldn't be pulled to and fro: the next frame tries the finder's
    // outline, moved on to now, against the paper's edges, and keeps whichever sits on them better.
    const moved = firm || Ax === A ? m.q.map((p, i) => [p[0] + trk.q[i][0] - ref[i][0], p[1] + trk.q[i][1] - ref[i][1]]) : align(Ax, trk.q).q;
    // (does it say the same as the finder's last answer did, moved on as the outline has moved since?)
    const L = trk.lastProp;
    let run = 1;
    if (L && trk.differ >= 1) {
      const pm = L.q.map((p, i) => [p[0] + trk.q[i][0] - L.at[i][0], p[1] + trk.q[i][1] - L.at[i][1]]);
      if (maxApart(align(moved, pm).q, pm) < 0.015 * diag) run = L.run + 1;
    }
    trk.lastProp = { q: moved, at: trk.q.map((p) => p.slice()), run };
    trk.proposal = { q: moved, d: m.d / diag, src, run };
    trk.differ++;
    return;
  } else {
    trk.q = Ax;
  }
  trk.v = ZERO(); trk.follow = null; trk.settled = false;
  trk.src = src; trk.boost = 2; trk.weak = 0; trk.strong = 0; trk.jumped = true; trk.jumpF = trk.lastF + 1; trk.moOk = 0;
  trk.sideOk = [0, 0, 0, 0];
  trk.agrees = src === "ai" ? 1 : 0;
  if (src === "ai") { trk.agreeAt = now; noteAI(0, now); }
}

// f: frame number in this worker's sequence; cf: the camera's frame number (frames the page skipped count).
function track(f, cf) {
  trk.cfOf.set(f, cf);
  trk.lastF = f;
  halfNow();
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
  // (a side that has sat on its edge for a while keeps sharply to it, unless the outline is moving fast)
  let { q, sides, ok, score } = snapQuad(pred, R, PICK, vmax * gap < 4 ? trk.sideOk.map((n) => n >= 5) : null);
  let jumped = false;
  if (trk.proposal) {
    const P = trk.proposal;
    trk.proposal = null;
    const alt = snapQuad(P.q, 22);
    const diag = Math.hypot(gw, gh);
    // (the page is the outermost thing: an outline around the current one, on edges nearly as clear, wins;
    // the current one was probably on a table rule or the edge of the print)
    const aq = area(q), aa = area(alt.q), inter = clipShare(q, alt.q) * aq, iou = inter / (aq + aa - inter);
    const around = alt.sides >= 3 && aa > 1.03 * aq && inter > 0.97 * aq && alt.score >= 0.6 * score;
    // (an outline with a side on a printed line, the same paper either side of it, isn't the page: the finder's
    // outline around it is)
    const onPrint = [0, 1, 2, 3].some((i) => !onBorder(q[i], q[(i + 1) % 4]) && onPrintedLine(q, i));
    const sliver = aa < 1.15 * aq && sides >= 3 && !onPrint;
    const within = alt.sides >= 3 && maxApart(alt.q, P.q) < 0.035 * diag && aa >= 0.5 * aq && clipShare(alt.q, q) > 0.95;
    if (alt.sides >= 3 && sides >= 3 && (align(alt.q, q).d < 0.015 * diag || iou > 0.96)) {
      // The finder's outline lands on the same edges: it was just off a little. Nothing to change.
      trk.differ = 0; trk.lastProp = null;
      if (P.src === "ai") { trk.agreeAt = performance.now(); trk.aiD = 0; trk.far = 0; trk.agrees++; }
    } else if ((alt.sides >= 2 && sides < 2) || (P.run >= 2 && P.d > 0.035 && alt.sides >= 3 && maxApart(alt.q, P.q) < 0.035 * diag) ||
      (P.run >= 3 && P.d > 0.035)) {
      // Switch when the current outline barely sits on edges and the finder's does; when the finder has said twice
      // running that the page is well away (further than it's usually off) and there are paper edges along its
      // outline; or when it has said so three times running, edges or not. Which edges are the page's is the
      // finder's call: a stack of sheets, or the boxes printed on a page, has strong edges that aren't the page's
      // own, and a page on a white desk has none. The next frames look wider for edges (boost), so an outline put
      // a little off by the finder locks onto the page's edges nearby.
      ({ q, sides, ok, score } = alt.sides >= 2 ? alt : { q: P.q, ...NONE });
      jumped = true;
      trk.src = P.src; trk.differ = 0; trk.lastProp = null; trk.boost = 3; trk.sideOk = [0, 0, 0, 0];
      if (P.src === "ai") { trk.agreeAt = performance.now(); trk.aiD = 0; trk.far = 0; trk.agrees = 1; }
    } else if (SWITCH === "edges" && ((alt.score > score + 0.4 && !(around && sliver)) || (around && !sliver) || (trk.differ >= 6 && P.d > 0.05 && alt.score >= 1.5))) {
      // Switch when the finder's outline sits clearly better on paper edges, or around the current one (the page
      // around a printed table or box the outline sat on). Not to an outline that's only a little bigger all round
      // when the current one sits on edges: that's the sheets peeking out from under the page, not the page.
      ({ q, sides, ok, score } = alt.sides >= 2 ? alt : { q: P.q, ...NONE });
      jumped = true;
      trk.src = P.src; trk.differ = 0; trk.lastProp = null; trk.boost = 2; trk.sideOk = [0, 0, 0, 0];
      if (P.src === "ai") { trk.agreeAt = performance.now(); trk.aiD = 0; trk.far = 0; trk.agrees = 1; }
    }
  }
  // A side the AI keeps putting a little inside where it sits (the edge of a sheet peeking out from under the page):
  // try it on the edge where the AI puts it, and take that if there's a clear edge there.
  if (trk.sidePull && !jumped && sides >= 2) {
    const { i, o0, o1 } = trk.sidePull;
    const a = q[i], b = q[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    let nx = -dy / L, ny = dx / L;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const Q2 = q.map((p) => p.slice());
    Q2[i] = [a[0] + o0 * nx, a[1] + o0 * ny]; Q2[(i + 1) % 4] = [b[0] + o1 * nx, b[1] + o1 * ny];
    const alt = snapQuad(Q2, 10);
    if (alt.ok[i] && alt.sides >= Math.min(3, sides)) {
      ({ q, sides, ok, score } = alt);
      trk.sideOk[i] = 0; trk.boost = 0;
      if (st.trace) st.events.push({ f, pull: i, o0: +o0.toFixed(1), o1: +o1.toFixed(1) });
    }
    trk.pull = [null, null, null, null]; trk.sidePull = null;
  }
  for (let i = 0; i < 4; i++) trk.sideOk[i] = ok[i] ? trk.sideOk[i] + 1 : 0;
  if (jumped) {
    trk.q = q; trk.v = ZERO(); trk.jumped = true; trk.weak = sides >= 2 ? 0 : 1; trk.strong = 0; trk.follow = null; trk.settled = false;
    trk.jumpF = f; trk.moOk = 0; trk.pull = [null, null, null, null]; trk.sidePull = null;
  } else if (sides >= 2) {
    trk.v = q.map((p, i) => [0.5 * (p[0] - trk.q[i][0]) / gap + 0.5 * v[i][0], 0.5 * (p[1] - trk.q[i][1]) / gap + 0.5 * v[i][1]]);
    trk.q = q; trk.weak = 0; trk.follow = null; trk.moOk += gap;
    trk.strong = sides >= 3 ? trk.strong + 1 : 0;
    if (trk.strong >= 3) trk.settled = true;
  } else {
    // No edges to snap to. The outline moves as the print on the page moved (or, when that can't be told, as it
    // has been moving), and when the AI has given its outline, glides slowly to that (moved on with the page
    // too): the AI's answers scatter a little from look to look, so the outline doesn't jump to each.
    trk.weak++; trk.strong = 0;
    const F = trk.follow;
    let dx = 0, dy = 0;
    for (let i = 0; i < 4; i++) { dx += (pred[i][0] - trk.q[i][0]) / 4; dy += (pred[i][1] - trk.q[i][1]) / 4; }
    const M = gap <= 3 ? pageMotion(trk.q, dx, dy) : null;
    trk.moOk = M ? trk.moOk + gap : 0;
    const to = M ? moveBy(M, trk.q) : pred;
    // (the AI's outlines move on with the page too)
    const shift = (Q) => (M ? moveBy(M, Q) : Q.map((p, i) => [p[0] + pred[i][0] - trk.q[i][0], p[1] + pred[i][1] - trk.q[i][1]]));
    if (F && F.q) F.q = shift(F.q);
    trk.v = M ? to.map((p, i) => [(p[0] - trk.q[i][0]) / gap, (p[1] - trk.q[i][1]) / gap]) : v.map((d) => [d[0] * (F ? 0.8 : 0.5), d[1] * (F ? 0.8 : 0.5)]);
    if (F && F.q) {
      // (a little faster while it's still a fair way off)
      const a = 1 - Math.pow(maxApart(F.q, to) > 0.012 * Math.hypot(gw, gh) ? 0.5 : M ? 0.85 : 0.75, gap);
      trk.q = to.map((p, i) => [p[0] + a * (F.q[i][0] - p[0]), p[1] + a * (F.q[i][1] - p[1])]);
    } else trk.q = to;
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

// Share of quad q's area inside the convex polygon c (q clipped to c, Sutherland-Hodgman).
function clipShare(q, c) {
  let poly = q.map((p) => p.slice());
  // orientation of c, so "inside" is the same side of every edge
  let o = 0;
  for (let i = 0; i < c.length; i++) { const a = c[i], b = c[(i + 1) % c.length]; o += a[0] * b[1] - b[0] * a[1]; }
  const sg = o >= 0 ? 1 : -1;
  for (let e = 0; e < c.length && poly.length; e++) {
    const a = c[e], b = c[(e + 1) % c.length];
    const side = (p) => sg * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], r = poly[(i + 1) % poly.length], dp = side(p), dr = side(r);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dr >= 0)) { const t = dp / (dp - dr); out.push([p[0] + t * (r[0] - p[0]), p[1] + t * (r[1] - p[1])]); }
    }
    poly = out;
  }
  if (poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  const full = area(q);
  return full > 0 ? Math.abs(s) / 2 / full : 0;
}
// Share of the quad's area inside the frame.
const insideShare = (q) => clipShare(q, [[0, 0], [gw, 0], [gw, gh], [0, gh]]);

/* ---------- How the picture moves from frame to frame ----------
   Small patches of print inside the outline are looked for again in the next frame, and a map fitted to where
   they went (a shift, a turn, a zoom, a slight tilt) says how the page moved in the picture. That keeps the
   outline on the page when there are no paper edges to snap to (white paper on a white desk). Patches are
   found at half size first, then to a fraction of a pixel at full size. */
const MP = 8, MH = 4, MS = 3;   // patch half-size (grey px), the same at half size, search reach at half size (a
// bigger reach lets a patch of print in lines match a line further on)
const mo = { prev: null, half: null, halfPrev: null, hw: 0, hh: 0 };
function halve(src, dst) {
  const hw = mo.hw, hh = mo.hh;
  for (let y = 0; y < hh; y++) {
    const r0 = 2 * y * gw, r1 = r0 + gw, o = y * hw;
    for (let x = 0; x < hw; x++) { const c = r0 + 2 * x, d = r1 + 2 * x; dst[o + x] = 0.25 * (src[c] + src[c + 1] + src[d] + src[d + 1]); }
  }
}
function sad(A, B, w, ax, ay, bx, by, n) {
  let s = 0;
  for (let y = 0; y < n; y++) {
    let ia = (ay + y) * w + ax, ib = (by + y) * w + bx;
    for (let x = 0; x < n; x++) { const d = A[ia++] - B[ib++]; s += d < 0 ? -d : d; }
  }
  return s;
}
function ssd(A, B, w, ax, ay, bx, by, n) {
  let s = 0;
  for (let y = 0; y < n; y++) {
    let ia = (ay + y) * w + ax, ib = (by + y) * w + bx;
    for (let x = 0; x < n; x++) { const d = A[ia++] - B[ib++]; s += d * d; }
  }
  return s;
}
const fineV = new Float64Array(25), coarseV = new Float64Array((2 * MS + 1) * (2 * MS + 1));
// Where the patch around (px, py) in the previous frame went, expected near (px + dx, py + dy). [x, y] or null.
function findPatch(px, py, dx, dy) {
  const n = 2 * MH, hw = mo.hw, hh = mo.hh, H0 = mo.halfPrev, H1 = mo.half;
  const hx = Math.round(px / 2) - MH, hy = Math.round(py / 2) - MH;
  if (hx < 1 || hy < 1 || hx + n >= hw || hy + n >= hh) return null;
  // enough contrast to be found again (print, not blank paper)
  let gsum = 0;
  for (let y = 0; y < n; y++) {
    const o = (hy + y) * hw + hx;
    for (let x = 0; x < n; x++) { const a = H0[o + x]; gsum += Math.abs(H0[o + x + 1] - a) + Math.abs(H0[o + x + hw] - a); }
  }
  if (gsum < 3 * n * n) return null;
  const cx = Math.round((px + dx) / 2) - MH, cy = Math.round((py + dy) / 2) - MH;
  let best = Infinity, bx = 0, by = 0, k = 0;
  for (let sy = -MS; sy <= MS; sy++) {
    const yy = cy + sy;
    for (let sx = -MS; sx <= MS; sx++, k++) {
      const xx = cx + sx;
      const v = yy < 0 || yy + n > hh || xx < 0 || xx + n > hw ? Infinity : sad(H0, H1, hw, hx, hy, xx, yy, n);
      coarseV[k] = v;
      if (v < best) { best = v; bx = xx; by = yy; }
    }
  }
  if (best === Infinity || Math.abs(bx - cx) === MS || Math.abs(by - cy) === MS) return null;   // (at the edge of the reach)
  // full size: the best of 5 x 5 positions around it, then a parabola each way for the fraction
  const N = 2 * MP, fx = Math.round(px) - MP, fy = Math.round(py) - MP;
  const ox = fx + 2 * (bx - hx), oy = fy + 2 * (by - hy);
  if (fx < 0 || fy < 0 || fx + N > gw || fy + N > gh || ox - 2 < 0 || oy - 2 < 0 || ox + 2 + N > gw || oy + 2 + N > gh) return null;
  let bi = 12, bv = Infinity;
  for (let j = 0; j < 25; j++) {
    const v = ssd(mo.prev, grey, gw, fx, fy, ox + (j % 5) - 2, oy + ((j / 5) | 0) - 2, N);
    fineV[j] = v;
    if (v < bv) { bv = v; bi = j; }
  }
  const ix = bi % 5, iy = (bi / 5) | 0;
  if (ix === 0 || ix === 4 || iy === 0 || iy === 4) return null;
  const sub = (a, b, c) => { const den = a - 2 * b + c; return den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0; };
  const sx = sub(fineV[bi - 1], bv, fineV[bi + 1]), sy = sub(fineV[bi - 5], bv, fineV[bi + 5]);
  return [ox + ix - 2 + sx + MP, oy + iy - 2 + sy + MP];
}
// The page's motion from the previous frame to this one, as an affine map (x' = a x + b y + c, y' = d x + e y + f;
// near enough for one frame's worth of a moving phone), from patches inside quad Q (previous frame), expected
// to have moved by about (dx, dy). Null when it can't be told.
function pageMotion(Q, dx, dy) {
  if (!mo.prev || !mo.halfPrev) return null;
  const P = [];
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const u = 0.2 + 0.2 * i, v = 0.2 + 0.2 * j;
      // a point of the quad, bilinearly
      const x = (1 - v) * ((1 - u) * Q[0][0] + u * Q[1][0]) + v * ((1 - u) * Q[3][0] + u * Q[2][0]);
      const y = (1 - v) * ((1 - u) * Q[0][1] + u * Q[1][1]) + v * ((1 - u) * Q[3][1] + u * Q[2][1]);
      const m = findPatch(x, y, dx, dy);
      if (m) P.push([x, y, m[0], m[1]]);
    }
  }
  if (P.length < 6) return null;
  // start from the typical shift (most patches agree on it; a patch matched to the wrong word doesn't)
  const med = (a) => { const s2 = a.slice().sort((x, y) => x - y); return s2[s2.length >> 1]; };
  const tx = med(P.map((p) => p[2] - p[0])), ty = med(P.map((p) => p[3] - p[1]));
  let use = P.filter((p) => Math.hypot(p[2] - p[0] - tx, p[3] - p[1] - ty) < 3);
  let M = null;
  for (let it = 0; it < 3; it++) {
    if (use.length < 6) return null;
    M = fitAffine(use);
    if (!M) return null;
    const res = P.map((p) => Math.hypot(M.a * p[0] + M.b * p[1] + M.c - p[2], M.d * p[0] + M.e * p[1] + M.f - p[3]));
    const keep = P.filter((_, k) => res[k] < 0.8);
    if (keep.length === use.length && keep.every((p, k) => p === use[k])) break;
    use = keep;
  }
  // most of the patches must agree, and a hand-held phone doesn't turn, zoom or tilt much from frame to frame
  if (use.length < 6 || use.length < 0.5 * P.length) return null;
  if (Math.abs(M.a - 1) > 0.06 || Math.abs(M.e - 1) > 0.06 || Math.abs(M.b) > 0.06 || Math.abs(M.d) > 0.06) return null;
  M.n = use.length;
  return M;
}
// Least-squares affine map through point pairs [x, y, x', y'] (centred, for a well-conditioned solve).
function fitAffine(P) {
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (const p of P) { mx += p[0]; my += p[1]; nx += p[2]; ny += p[3]; }
  const n = P.length;
  mx /= n; my /= n; nx /= n; ny /= n;
  let sxx = 0, sxy = 0, syy = 0, sxX = 0, syX = 0, sxY = 0, syY = 0;
  for (const p of P) {
    const x = p[0] - mx, y = p[1] - my, X = p[2] - nx, Y = p[3] - ny;
    sxx += x * x; sxy += x * y; syy += y * y; sxX += x * X; syX += y * X; sxY += x * Y; syY += y * Y;
  }
  const det = sxx * syy - sxy * sxy;
  if (det < 1e-6 * (sxx + syy) * (sxx + syy) || sxx + syy < 1) return null;   // points all in a line
  const a = (sxX * syy - syX * sxy) / det, b = (syX * sxx - sxX * sxy) / det;
  const d = (sxY * syy - syY * sxy) / det, e = (syY * sxx - sxY * sxy) / det;
  return { a, b, c: nx - a * mx - b * my, d, e, f: ny - d * mx - e * my };
}
const moveBy = (M, q) => q.map(([x, y]) => [M.a * x + M.b * y + M.c, M.d * x + M.e * y + M.f]);
// After a frame: it becomes the previous frame (the buffers swap, so the next frame is drawn into the old one).
function keepFrame() {
  if (!grey) return;
  if (!mo.prev || mo.prev.length !== grey.length) mo.prev = new Float32Array(grey.length);
  const t = mo.prev; mo.prev = grey; grey = t;
  const h = mo.halfPrev; mo.halfPrev = mo.half; mo.half = h;
}
function halfNow() {
  const hw = gw >> 1, hh = gh >> 1;
  if (mo.hw !== hw || mo.hh !== hh) { mo.hw = hw; mo.hh = hh; mo.half = null; mo.halfPrev = null; }
  if (!mo.half) mo.half = new Float32Array(hw * hh);
  halve(grey, mo.half);
}

// Is the outline sure enough to show? Like CamScanner, the app shows it only while the AI agrees that the page is
// there: about where the outline is (the AI's corners can be a few per cent off), or on the same paper edges. Not
// while the AI sees no page or keeps seeing it well away from the outline. A new outline waits for the AI to say
// so a second time, or for the paper's edges along it. Once shown, it stays until the AI says otherwise twice
// running (or once, far off), so one odd answer doesn't make it blink. The outline is followed all the while, so
// it's back as soon as it's confirmed.
function confirmed() {
  const was = trk.shown;
  trk.shown = trk.cut = false;
  if (!trk.q) return false;
  const now = performance.now();
  const edges = trk.sideOk.filter((n) => n >= 3).length >= 3;
  let ok;
  if (trk.src === "cv") ok = now - trk.cvAt < 700;
  else if (trk.src !== "ai" || now - trk.aiAt > 1200 || trk.miss >= 2 || trk.far >= 2 || trk.aiD > 0.1) ok = false;
  else ok = was || (trk.miss === 0 && trk.aiD < (edges ? 0.04 : 0.025) && (trk.agrees >= 2 || edges));
  if (!ok) return false;
  // (a page that overflows the view is shown clamped to the view's edge; the flag asks the user to move back)
  const m = 0.004 * Math.max(gw, gh);
  trk.cut = !trk.q.every(([x, y]) => x > m && x < gw - m && y > m && y < gh - m);
  return (trk.shown = true);
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

/* ---------- The camera view ----------
   When the page hands over its preview canvas, this worker draws each camera frame there itself, with the
   outline found in that same frame on top. The outline then sits exactly on the page as shown, instead of
   trailing the live video by a frame or two (which made it look shaky in a hand-held phone). */
const view = { ctx: null, w: 0, h: 0, dpr: 1, steady: false, fade: 0 };
const LOOK = { bg: "#050807", line: "#8DBCEB", fill: "rgba(141, 188, 235, .16)", okLine: "#76C898", okFill: "rgba(118, 200, 152, .2)" };
// pic: the frame (a VideoFrame, or a still of it taken by the page); alpha: how strongly the outline is drawn (it
// fades in and out). Returns whether the frame was drawn.
function drawView(pic, quad, alpha = 1) {
  const c = view.ctx;
  if (!c || !view.w || !view.h) return false;
  const fw = pic.displayWidth || pic.width, fh = pic.displayHeight || pic.height;
  if (!fw || !fh) return false;
  // the whole frame, letterboxed like the video element did (object-fit: contain)
  const k = Math.min(view.w / fw, view.h / fh), dw = fw * k, dh = fh * k, ox = (view.w - dw) / 2, oy = (view.h - dh) / 2;
  if (dw < view.w - 0.5 || dh < view.h - 0.5) { c.fillStyle = LOOK.bg; c.fillRect(0, 0, view.w, view.h); }
  c.drawImage(pic, ox, oy, dw, dh);
  if (!quad || alpha <= 0) return true;
  c.globalAlpha = alpha;
  c.beginPath();
  for (let i = 0; i < 4; i++) { const X = ox + quad[i][0] * dw, Y = oy + quad[i][1] * dh; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); }
  c.closePath();
  c.fillStyle = view.steady ? LOOK.okFill : LOOK.fill;
  c.fill();
  c.lineWidth = 3 * view.dpr; c.lineJoin = "round";
  c.strokeStyle = view.steady ? LOOK.okLine : LOOK.line;
  c.stroke();
  c.globalAlpha = 1;
  return true;
}
function clearView() {
  if (!view.ctx || !view.w) return;
  view.ctx.fillStyle = LOOK.bg; view.ctx.fillRect(0, 0, view.w, view.h);
}

/* ---------- Reading frames ----------
   A VideoFrame is read either by copying its pixels (exact, and quick when the frame is in main memory) or by
   drawing it small and reading the small picture back (the phone's graphics chip does the shrinking where it
   can, so a frame held there needn't come off it whole). The check at the start finds out which ways give the
   picture shown on screen; when both do, the first frames are timed both ways, and copying is kept unless
   drawing is clearly quicker.
   Stills taken by the page are drawn. */
const rd = { copy: true, draw: false, pick: "", t: { copy: [], draw: [] } };   // (until the check: copies)
const drawer = { c: [null, null], pick: -1, t: [[], []] };   // canvases: on the graphics chip, in main memory
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

async function fromCopy(vf, wantAI) {
  if (vf.rotation || vf.flip || !FORMATS.has(vf.format)) throw new Error("This frame can't be copied as shown");
  const size = vf.allocationSize();
  if (!planes || planes.length < size) planes = new Uint8Array(size);
  const layout = await vf.copyTo(planes);
  return fromPlanes(planes, layout, vf.format, vf.visibleRect.width, vf.visibleRect.height, vf.colorSpace, wantAI);
}

function fromDrawn(pic, wantAI) {
  const fw = pic.displayWidth || pic.width, fh = pic.displayHeight || pic.height;
  if (!fw || !fh) throw new Error("Empty picture");
  sizeGrey(fw, fh);
  // (drawn at twice the grey picture's size when the frame is that big, then averaged down: a picture shrunk a
  // long way in one go has ragged edges that would make the outline flicker)
  const k = Math.max(fw, fh) >= 2 * GL ? 2 : 1, w = gw * k, h = gh * k;
  const i = drawer.pick >= 0 ? drawer.pick : drawer.t[0].length <= drawer.t[1].length ? 0 : 1;
  let ctx = drawer.c[i];
  if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx = drawer.c[i] = new OffscreenCanvas(w, h).getContext("2d", { alpha: false, willReadFrequently: i === 1 });
  }
  const t0 = performance.now();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(pic, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  if (drawer.pick < 0) {
    drawer.t[i].push(performance.now() - t0);
    if (drawer.t[0].length >= 8 && drawer.t[1].length >= 8) drawer.pick = median(drawer.t[0].slice(2)) <= median(drawer.t[1].slice(2)) ? 0 : 1;
  }
  return fromRGBA(px, w, h, wantAI, k);
}

async function readFrame(vf, wantAI) {
  // (with both ways usable: drawn first, until the drawing canvas is chosen, then each in turn, then the quicker)
  let how = rd.pick || (rd.copy && rd.draw ? (drawer.pick < 0 ? "draw" : rd.t.copy.length <= rd.t.draw.length ? "copy" : "draw") : rd.copy ? "copy" : "draw");
  const t0 = performance.now();
  let px;
  if (how === "copy") {
    try { px = await fromCopy(vf, wantAI); }
    catch (err) {
      rd.copy = false; rd.pick = "";
      if (!rd.draw) throw err;
      how = "draw";
    }
  }
  if (how === "draw") px = fromDrawn(vf, wantAI);
  if (!rd.pick) {
    if (rd.copy && rd.draw) {
      if (how === "copy" || drawer.pick >= 0) rd.t[how].push(performance.now() - t0);
      // (copies are the more exact way: drawing is kept only when it's clearly quicker)
      if (rd.t.copy.length >= 10 && rd.t.draw.length >= 10) {
        const c = median(rd.t.copy.slice(2)), d = median(rd.t.draw.slice(2));
        rd.pick = c > 10 && d < 0.67 * c ? "draw" : "copy";
      }
    } else rd.pick = how;
  }
  st.way = how === "copy" ? "copy" : drawer.pick === 1 ? "draw cpu" : "draw";
  return px;
}

/* ---------- Frames from the page ---------- */
const st = { ms: 0, hz: 0, n: 0, since: 0, pad: 0, trace: false, events: [], way: "" };

async function onFrameMsg(m) {
  const t0 = performance.now();
  const f = m.seq;
  const wantsAI = wantAI(t0);
  const vf = m.frame || null, still = m.still || null, ts = vf ? vf.timestamp : undefined;
  const close = () => {
    if (vf) { try { vf.close(); } catch (_) { /* closed */ } }
    if (still) { try { still.close(); } catch (_) { /* closed */ } }
  };
  let px = null;
  try {
    if (vf) px = await readFrame(vf, wantsAI);
    else if (still) { px = fromDrawn(still, wantsAI); st.way = drawer.pick === 1 ? "still cpu" : "still"; }
    else { px = fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, wantsAI); st.way = ""; }
  } catch (err) {
    close();
    self.postMessage({ type: "quad", seq: f, epoch: m.epoch, quad: null, error: String((err && err.message) || err), fallback: !!(vf || still) });
    return;
  }
  let res = null;
  try {
    if (px) sendAI(px, f);
    res = track(f, m.cf === undefined ? f : m.cf);
  } catch (err) {
    trk.reset();
    close();
    self.postMessage({ type: "quad", seq: f, epoch: m.epoch, quad: null, error: String((err && err.message) || err) });
    return;
  }
  const shown = res && (st.gate === false || confirmed()) ? res.quad.map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]) : null;
  // (the outline fades in and out over a few frames rather than blinking on and off)
  view.fade = shown ? Math.min(1, view.fade + 0.34) : Math.max(0, view.fade - 0.25);
  let drawn = false;
  const pic = vf || still;
  if (pic && view.ctx) { try { drawn = drawView(pic, shown || (res && res.quad), view.fade); } catch (_) { /* drawing isn't essential */ } }
  close();
  if (st.pad) { const end = t0 + st.pad; while (performance.now() < end) { /* test hook: a slower phone */ } }
  const ms = performance.now() - t0;
  st.ms = st.ms ? st.ms * 0.9 + ms * 0.1 : ms;
  st.n++;
  if (!st.since) st.since = t0;
  if (t0 - st.since >= 1000) { const hz = (st.n * 1000) / (t0 - st.since); st.hz = st.hz ? st.hz * 0.7 + hz * 0.3 : hz; st.n = 0; st.since = t0; }
  self.postMessage({
    type: "quad", seq: f, epoch: m.epoch, quad: shown, cut: !!(res && trk.cut), sides: res ? res.sides : 0, src: res ? trk.src : "", jump: !!trk.jumped, drawn,
    sig: signature(), stats: { liveMs: st.ms, liveHz: st.hz, aiMs: ai.ms, aiHz: ai.hz, way: st.way },
    trace: st.trace ? { ok: trk.sideOk.join(","), ev: st.events.splice(0), ts, wt: performance.now(), tq: res ? res.quad : null } : undefined,
  });
  trk.jumped = false;
  keepFrame();
}

// Which ways of reading VideoFrames give the same picture as the video on screen (same way up, same framing)?
// Each is compared with a copy of the same frame drawn by the page.
function corrWith(ref) {
  const a = grey, n = a.length;
  if (!ref || ref.length !== n) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += ref[i]; }
  sa /= n; sb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - sa, y = ref[i] - sb; num += x * y; da += x * x; db += y * y; }
  return da > 1 && db > 1 ? num / Math.sqrt(da * db) : (Math.abs(sa - sb) < 8 ? 1 : 0);
}
async function onCheck(m) {
  const vf = m.frame;
  const format = vf.format || "";
  let corrCopy = -1, corrDraw = -1, msCopy = 0, msDraw = 0;
  try {
    fromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h, false);
    const ref = grey.slice();
    try { const t0 = performance.now(); await fromCopy(vf, false); msCopy = performance.now() - t0; corrCopy = corrWith(ref); } catch (_) { /* can't be copied */ }
    try { const t0 = performance.now(); fromDrawn(vf, false); msDraw = performance.now() - t0; corrDraw = corrWith(ref); } catch (_) { /* can't be drawn */ }
  } catch (_) {
    /* no picture to compare with */
  } finally {
    try { vf.close(); } catch (_) { /* already closed */ }
  }
  rd.copy = corrCopy > 0.85; rd.draw = corrDraw > 0.85; rd.pick = ""; rd.t = { copy: [], draw: [] };
  if (st.forceRead) { rd.copy = rd.copy && st.forceRead === "copy"; rd.draw = rd.draw && st.forceRead === "draw"; }   // tests
  self.postMessage({ type: "check", epoch: m.epoch, ok: rd.copy || rd.draw, copy: rd.copy, draw: rd.draw, corrCopy, corrDraw, msCopy, msDraw, format });
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "frame") onFrameMsg(m);
  else if (m.type === "check") onCheck(m);
  else if (m.type === "port") { ai.port = m.port; ai.port.onmessage = onAIResult; ai.busy = false; }
  else if (m.type === "ai-off") { ai.port = null; ai.busy = false; }
  else if (m.type === "cv") onFinder(m.seq, m.quad, "cv");
  else if (m.type === "reset") { trk.reset(); trk.cfOf.clear(); ai.busy = false; ai.seq++; ai.prev = null; mo.prev = null; mo.halfPrev = null; clearView(); }
  else if (m.type === "view") { view.ctx = m.canvas.getContext("2d", { alpha: false }); view.dpr = m.dpr || 1; }
  else if (m.type === "view-size") {
    if (view.ctx) { view.ctx.canvas.width = view.w = m.w; view.ctx.canvas.height = view.h = m.h; view.dpr = m.dpr || view.dpr; clearView(); }
  }
  else if (m.type === "view-off") { clearView(); view.w = view.h = 0; }
  else if (m.type === "look") view.steady = !!m.steady;
  else if (m.type === "ease") ai.ease = !!m.on;
  else if (m.type === "debug") {
    st.pad = m.liveMs || 0; st.trace = !!m.trace; st.forceRead = m.read || "";
    if (m.pick) PICK = m.pick;
    if (m.switch) SWITCH = m.switch;
    if (m.gate !== undefined) st.gate = !!m.gate;
    if (m.agree) { AGREE_FIRM = m.agree[0]; AGREE = m.agree[1]; }
    if (m.inner) { INNER = m.inner[0]; INNER_R = m.inner[1]; }
    if (m.flat !== undefined) FLAT_IN = m.flat;
  }
};
