/* Experiment (test copy only, not part of the app): after a capture, SlimSAM (a "cut out this object" model,
   Xenova/slimsam-77-uniform, Apache-2.0) traces the page in the photo, prompted with points inside the AI's outline
   and just outside it, and four corners are fitted to its trace. On John's curled, hand-held booklets it took the whole
   page where the app's crop cut strips off (dev/samcrop.py). The model and the full ONNX Runtime Web are in
   dev/videos/ (ignored by git); see dev/README.md. Messages: { id, bitmap, hint (normalised corners), dir, threads }
   -> { id, quad (normalised corners) | null, ms, error }. */
import * as ort from "./videos/ortweb/ort.wasm.min.mjs";

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let enc = null, dec = null, loaded = "";

async function load(dir, threads) {
  if (loaded === dir) return;
  ort.env.wasm.wasmPaths = new URL("./videos/ortweb/", import.meta.url).href;
  ort.env.wasm.numThreads = threads;
  const base = new URL(`./videos/${dir}/`, import.meta.url).href, o = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  enc = await ort.InferenceSession.create(base + "vision_encoder.onnx", o);
  dec = await ort.InferenceSession.create(base + "prompt_encoder_mask_decoder.onnx", o);
  loaded = dir;
}

// A point of quad A (corners [x, y]) at (u, v), bilinearly.
const at = (A, u, v) => [0, 1].map((c) => (1 - v) * ((1 - u) * A[0][c] + u * A[1][c]) + v * ((1 - u) * A[3][c] + u * A[2][c]));

async function segment(bitmap, hint) {
  const W = bitmap.width, H = bitmap.height, k = 1024 / Math.max(W, H), nw = Math.round(W * k), nh = Math.round(H * k);
  const g = new OffscreenCanvas(nw, nh).getContext("2d");
  g.drawImage(bitmap, 0, 0, nw, nh);
  bitmap.close();
  const px = g.getImageData(0, 0, nw, nh).data, N = 1024 * 1024;
  const x = new Float32Array(3 * N);
  for (let y = 0; y < nh; y++) {
    for (let xx = 0; xx < nw; xx++) {
      const i = (y * nw + xx) * 4, o = y * 1024 + xx;
      for (let c = 0; c < 3; c++) x[c * N + o] = (px[i + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  const E = await enc.run({ pixel_values: new ort.Tensor("float32", x, [1, 3, 1024, 1024]) });
  // hints, in the 1024 frame: a 3 x 3 grid on the AI's page (its outline shrunk to 60%), and a point just outside the
  // middle of each of its sides saying "not the page"
  const A = hint.map(([u, v]) => [u * nw, v * nh]);
  const cx = (A[0][0] + A[1][0] + A[2][0] + A[3][0]) / 4, cy = (A[0][1] + A[1][1] + A[2][1] + A[3][1]) / 4;
  const pts = [], labels = [];
  for (const u of [0.2, 0.5, 0.8]) for (const v of [0.2, 0.5, 0.8]) { pts.push(at(A, u, v)); labels.push(1); }
  for (let i = 0; i < 4; i++) {
    const mx = (A[i][0] + A[(i + 1) % 4][0]) / 2, my = (A[i][1] + A[(i + 1) % 4][1]) / 2;
    const p = [mx + 0.12 * (mx - cx), my + 0.12 * (my - cy)];
    if (p[0] >= 0 && p[0] < nw && p[1] >= 0 && p[1] < nh) { pts.push(p); labels.push(0); }
  }
  const R = await dec.run({
    input_points: new ort.Tensor("float32", Float32Array.from(pts.flat()), [1, 1, pts.length, 2]),
    input_labels: new ort.Tensor("int64", BigInt64Array.from(labels.map(BigInt)), [1, 1, pts.length]),
    image_embeddings: E.image_embeddings, image_positional_embeddings: E.image_positional_embeddings,
  });
  const iou = R.iou_scores.data, M = R.pred_masks.data;   // [1,1,3], [1,1,3,256,256]
  // the mask holding most of the page points, then the one SlimSAM is surest of
  let best = -1, bj = 0;
  const holds = [0, 1, 2].map((j) => pts.filter((p, i) => labels[i] === 1 && M[j * 65536 + Math.min(255, (p[1] / 4) | 0) * 256 + Math.min(255, (p[0] / 4) | 0)] > 0).length);
  const most = Math.max(...holds);
  for (let j = 0; j < 3; j++) if (holds[j] >= most - 1 && iou[j] > best) { best = iou[j]; bj = j; }
  // the chosen mask at twice its size over the picture (logits sampled bilinearly), then thresholded
  const MW = Math.round(nw / 2), MH = Math.round(nh / 2), m = new Uint8Array(MW * MH), off = bj * 65536;
  for (let y = 0; y < MH; y++) {
    const sy = Math.max(0, Math.min(255, (y + 0.5) / 2 - 0.5)), y0 = sy | 0, y1 = Math.min(255, y0 + 1), fy = sy - y0;
    for (let xx = 0; xx < MW; xx++) {
      const sx = Math.max(0, Math.min(255, (xx + 0.5) / 2 - 0.5)), x0 = sx | 0, x1 = Math.min(255, x0 + 1), fx = sx - x0;
      const v = (M[off + y0 * 256 + x0] * (1 - fx) + M[off + y0 * 256 + x1] * fx) * (1 - fy) + (M[off + y1 * 256 + x0] * (1 - fx) + M[off + y1 * 256 + x1] * fx) * fy;
      m[y * MW + xx] = v > 0 ? 1 : 0;
    }
  }
  const clean = tidy(m, MW, MH);
  const q = quadBySides(clean, MW, MH, A.map(([u, v]) => [u / 2, v / 2]));
  return q ? q.map(([u, v]) => [Math.min(1, Math.max(0, u / MW)), Math.min(1, Math.max(0, v / MH))]) : null;
}

// The mask closed over the gaps print leaves (dilated, then eroded), its biggest piece only, holes filled.
function tidy(m, W, H) {
  const r = Math.max(2, Math.round(0.006 * Math.max(W, H)));
  let a = m;
  const step = (src, grow) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = src[i];
        const n = [x > 0 ? src[i - 1] : src[i], x < W - 1 ? src[i + 1] : src[i], y > 0 ? src[i - W] : src[i], y < H - 1 ? src[i + W] : src[i]];
        if (grow) v = v | n[0] | n[1] | n[2] | n[3]; else v = v & n[0] & n[1] & n[2] & n[3];
        out[i] = v;
      }
    }
    return out;
  };
  for (let k = 0; k < r; k++) a = step(a, true);
  for (let k = 0; k < r; k++) a = step(a, false);
  // biggest 4-connected piece
  const lab = new Int32Array(W * H), stack = new Int32Array(W * H);
  let n = 0, bigL = 0, bigN = 0;
  for (let i = 0; i < W * H; i++) {
    if (!a[i] || lab[i]) continue;
    n++; let sp = 0, cnt = 0; stack[sp++] = i; lab[i] = n;
    while (sp) {
      const j = stack[--sp]; cnt++;
      const x = j % W;
      for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j >= W ? j - W : -1, j < W * (H - 1) ? j + W : -1]) {
        if (k >= 0 && a[k] && !lab[k]) { lab[k] = n; stack[sp++] = k; }
      }
    }
    if (cnt > bigN) { bigN = cnt; bigL = n; }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = lab[i] === bigL ? 1 : 0;
  // holes: background not reached from the border
  const seen = new Uint8Array(W * H);
  let sp = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const i = y * W + x; if (!out[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const i = y * W + x; if (!out[i] && !seen[i]) { seen[i] = 1; stack[sp++] = i; } }
  while (sp) {
    const j = stack[--sp], x = j % W;
    for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, j >= W ? j - W : -1, j < W * (H - 1) ? j + W : -1]) {
      if (k >= 0 && !out[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
    }
  }
  for (let i = 0; i < W * H; i++) if (!out[i] && !seen[i]) out[i] = 1;
  return out;
}

// Four corners from the mask's outline: each outline point goes to the side of A (the AI's outline, mask px) whose line
// it lies nearest; each side gets a straight line fitted robustly to its points, moved out so that 97% of them are inside
// it (a curled edge bulges: the crop takes it in); the corners are where the lines meet. Null if that isn't a page shape.
function quadBySides(m, W, H, A) {
  const P = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W]) P.push([x + 0.5, y + 0.5]);
    }
  }
  if (P.length < 40) return null;
  const cx = (A[0][0] + A[1][0] + A[2][0] + A[3][0]) / 4, cy = (A[0][1] + A[1][1] + A[2][1] + A[3][1]) / 4;
  const sides = [0, 1, 2, 3].map((i) => {
    const a = A[i], b = A[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9, d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let n = [-d[1], d[0]];
    if (((a[0] + b[0]) / 2 - cx) * n[0] + ((a[1] + b[1]) / 2 - cy) * n[1] < 0) n = [-n[0], -n[1]];
    return { a, d, n, t: [], o: [] };
  });
  for (const p of P) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = sides[i], dd = Math.abs((p[0] - s.a[0]) * s.n[0] + (p[1] - s.a[1]) * s.n[1]);
      if (dd < bd) { bd = dd; bi = i; }
    }
    const s = sides[bi];
    s.t.push((p[0] - s.a[0]) * s.d[0] + (p[1] - s.a[1]) * s.d[1]);
    s.o.push((p[0] - s.a[0]) * s.n[0] + (p[1] - s.a[1]) * s.n[1]);
  }
  const med = (v) => { const s = v.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const lines = [];
  for (const s of sides) {
    if (s.t.length < 10) return null;
    let use = s.t.map((_, i) => i), p = 0, q = 0;
    for (let it = 0; it < 4; it++) {
      // least squares o = p + q t over the points in use
      let n = 0, st = 0, so = 0, stt = 0, sto = 0;
      for (const i of use) { n++; st += s.t[i]; so += s.o[i]; stt += s.t[i] * s.t[i]; sto += s.t[i] * s.o[i]; }
      const den = n * stt - st * st;
      q = Math.abs(den) > 1e-9 ? (n * sto - st * so) / den : 0; p = (so - q * st) / n;
      const r = s.t.map((t, i) => s.o[i] - (p + q * t)), mr = med(r), mad = med(r.map((v) => Math.abs(v - mr))) + 1;
      const next = s.t.map((_, i) => i).filter((i) => Math.abs(r[i] - mr) < 3 * mad);
      if (next.length < 10 || next.length === use.length) break;
      use = next;
    }
    const r = s.t.map((t, i) => s.o[i] - (p + q * t)).sort((x, y) => x - y);
    p += r[Math.min(r.length - 1, Math.floor(0.97 * r.length))];
    lines.push({ p0: [s.a[0] + p * s.n[0], s.a[1] + p * s.n[1]], d: [s.d[0] + q * s.n[0], s.d[1] + q * s.n[1]] });
  }
  const Q = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4], l2 = lines[i];
    const den = l1.d[0] * -l2.d[1] - l1.d[1] * -l2.d[0];
    if (Math.abs(den) < 1e-9) return null;
    const rx = l2.p0[0] - l1.p0[0], ry = l2.p0[1] - l1.p0[1];
    const s = (rx * -l2.d[1] - ry * -l2.d[0]) / den;
    Q.push([l1.p0[0] + s * l1.d[0], l1.p0[1] + s * l1.d[1]]);
  }
  // a page shape: convex, corners between 50 and 130 degrees
  let sg = 0;
  for (let i = 0; i < 4; i++) {
    const a = Q[(i + 3) % 4], b = Q[i], c = Q[(i + 1) % 4];
    const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const cr = ux * vy - uy * vx, s = Math.sign(cr);
    if (!s || (sg && s !== sg)) return null;
    sg = s;
    const deg = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9)))) * 180) / Math.PI;
    if (deg < 50 || deg > 130) return null;
  }
  return Q;
}

self.onmessage = async (e) => {
  const { id, bitmap, hint, dir = "slimsam", threads = 4 } = e.data || {};
  const t0 = performance.now();
  try {
    await load(dir, threads);
    const t1 = performance.now();
    const quad = await segment(bitmap, hint);
    self.postMessage({ id, quad, ms: performance.now() - t1, loadMs: t1 - t0 });
  } catch (err) {
    try { bitmap.close(); } catch (_) { /* closed */ }
    self.postMessage({ id, quad: null, error: String((err && err.message) || err) });
  }
};
