// Replays a test video through live-worker.js in Node, frame by frame, with the AI's precomputed answers
// arriving D frames after each request. Deterministic, so tracker changes can be compared exactly.
// usage: node replay.js <worker.js> <video> [--ai-delay D] [--dump out.json] [--from F --to F] [--shown] [--quiet]
//   (videos/<video>.y4m, videos/<video>.json and videos/ai_<video>.json: see make_videos.py)
//   --ai-bias B --ai-noise N --ai-outlier O: a less exact AI; --drop P --seed S, --step K, --stalls f+n: a slower phone
//   --shown: score the outline shown (after the "sure enough to show" rule) instead of the one followed
//   --margin M: count frames as page-in-view only when every corner is M inside; --trace a-b: tracker internals
//   --pick/--switch/--agree/--no-gate/--inner/--flat: worker test settings (see the debug message in live-worker.js)
//   PULLS=1 in the environment prints when a side is pulled onto the edge the AI points at
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const args = process.argv.slice(2);
const workerPath = args[0], video = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const D = +opt("--ai-delay", 2), dump = opt("--dump", ""), quiet = args.includes("--quiet");
const STEP = +opt("--step", 1);          // process every STEP-th frame (a slower phone drops frames)
let seed = +opt("--seed", 1);
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const DROP = +opt("--drop", 0);          // chance of skipping any one frame
const STALLS = (opt("--stalls", "") || "").split(",").filter(Boolean).map((x) => x.split("+").map(Number));   // "f+n,...": skip n frames from f
// A real AI is less exact than on these test videos: a steady offset of each corner for the scene (bias,
// % of the frame), frame-to-frame scatter (noise) and now and then a wild answer (outlier chance).
const AIB = +opt("--ai-bias", 0), AIN = +opt("--ai-noise", 0), AIO = +opt("--ai-outlier", 0);
let nseed = 12345;
const nrnd = () => { nseed = (nseed * 48271) % 2147483647; return nseed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (u === 0) u = nrnd(); v = nrnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const BIAS = [0, 1, 2, 3].map(() => { const a = nrnd() * 2 * Math.PI; return [Math.cos(a) * AIB / 100, Math.sin(a) * AIB / 100]; });
function noisy(q) {
  const out = nrnd() < AIO;
  return q.map(([x, y], i) => {
    let nx = x + BIAS[i][0] + gauss() * AIN / 100, ny = y + BIAS[i][1] + gauss() * AIN / 100;
    if (out) { nx += (nrnd() - 0.5) * 0.12; ny += (nrnd() - 0.5) * 0.12; }
    return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  });
}
const HERE = path.join(__dirname, "videos");
const GT = JSON.parse(fs.readFileSync(path.join(HERE, video + ".json"))).frames;
const AIR = JSON.parse(fs.readFileSync(path.join(HERE, "ai_" + video + ".json")));
const fd = fs.openSync(path.join(HERE, video + ".y4m"), "r");
const head = Buffer.alloc(200); fs.readSync(fd, head, 0, 200, 0);
const hl = head.indexOf(10) + 1, hs = head.slice(0, hl).toString();
const W = +/ W(\d+)/.exec(hs)[1], H = +/ H(\d+)/.exec(hs)[1];
const FS = (W * H * 3) / 2;
const frameBuf = Buffer.alloc(FS);
function readFrame(i) { fs.readSync(fd, frameBuf, 0, FS, hl + i * (FS + 6) + 6); return frameBuf; }

const clock = { t: 0 };
const posted = [];
const ctx = {
  self: { postMessage: (m) => posted.push(m) }, performance: { now: () => clock.t }, console,
  setTimeout, Promise, Math, JSON, Map, Set, Array, Object, Number, String, Error, isFinite,
  Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Int32Array,
};
vm.createContext(ctx);
// --no-edges: no paper edges anywhere (white paper on a white desk), so the outline can only follow the AI
let src = fs.readFileSync(workerPath, "utf8");
if (args.includes("--no-edges")) src = src.replace(/T_STEP = \d+/, "T_STEP = 1e9");
vm.runInContext(src, ctx, { filename: workerPath });
const TR = opt("--trace", "");             // "a-b": print tracker internals for frames a..b
const [ta, tb] = TR ? TR.split("-").map(Number) : [1e9, -1];
if (TR) {
  vm.runInContext(`
    const __of = onFinder;
    onFinder = function (f, quad, src) {
      const before = trk.q ? trk.q.map((p) => p.slice()) : null;
      __of(f, quad, src);
      self.__trace && self.__trace(f, quad, src, before, trk.q, trk.sideOk.slice());
    };
    const __fs = typeof fuseSides === "function" ? fuseSides : null;
    if (__fs) fuseSides = function (Aq, ref) { const b = trk.q && trk.q.map((p) => p.slice()); __fs(Aq, ref); self.__fuse && self.__fuse(b, trk.q, Aq, ref); };
  `, ctx);
}
const requests = [];
let cur = 0;
const port = { postMessage: (m) => requests.push({ id: m.id, frame: cur, due: cur + D }), onmessage: null };
ctx.self.onmessage({ data: { type: "port", port } });
// trace on, so each answer also carries the outline followed (shown or not); --shown scores the outline shown
const SHOWN = args.includes("--shown");
// --margin M: count a frame as having the page in view only when every corner is at least M (share of the frame) inside
const MARGIN = +opt("--margin", -0.002);
const dbg = { type: "debug", trace: true };
if (opt("--pick", "")) dbg.pick = opt("--pick", "");
if (opt("--switch", "")) dbg.switch = opt("--switch", "");
if (opt("--agree", "")) dbg.agree = opt("--agree", "").split(",").map(Number);
if (args.includes("--no-gate")) dbg.gate = false;
if (opt("--inner", "")) dbg.inner = opt("--inner", "").split(",").map(Number);
if (opt("--flat", "")) dbg.flat = +opt("--flat", "");
ctx.self.onmessage({ data: dbg });

function fakeFrame(i) {
  const buf = readFrame(i);
  return {
    format: "I420", rotation: 0, flip: false, visibleRect: { x: 0, y: 0, width: W, height: H }, colorSpace: {},
    allocationSize: () => FS,
    copyTo: async (dst) => { dst.set(buf.subarray(0, FS)); return [{ offset: 0, stride: W }, { offset: W * H, stride: W / 2 }, { offset: W * H + (W * H) / 4, stride: W / 2 }]; },
    close() {},
  };
}
function qerr(s, g) {
  let best = 1e9;
  const G = g.map(([x, y]) => [x * W, y * H]), S = s.map(([x, y]) => [x * W, y * H]);
  for (const order of [G, [G[0], G[3], G[2], G[1]]]) {
    for (let k = 0; k < 4; k++) {
      let e = 0;
      for (let i = 0; i < 4; i++) { const o = order[(i + k) % 4]; e += Math.hypot(S[i][0] - o[0], S[i][1] - o[1]); }
      best = Math.min(best, e / 4);
    }
  }
  return (best / Math.hypot(W, H)) * 100;
}

(async () => {
  const from = +opt("--from", 0), to = +opt("--to", GT.length - 1);
  const rows = [];
  for (let i = from; i <= to; i++) {
    cur = i;
    clock.t = i * (1000 / 30);
    // AI answers that are due now
    for (const r of requests.filter((q) => q.due <= i && !q.done)) {
      r.done = true;
      const a = AIR[r.frame];
      port.onmessage({ data: { id: r.id, ok: true, result: { quad: noisy(a.q), score: a.score, ms: 35 } } });
    }
    ctx.self.__trace = i >= ta && i <= tb ? (f, quad, src, b, a, ok) => console.log(`  [${i}] ${src} answer for frame ${f}: ${quad ? "page" : "none"}; outline ${b ? "moved " + Math.max(...a.map((p, k) => Math.hypot(p[0] - b[k][0], p[1] - b[k][1]))).toFixed(1) + "px" : "set"}; sides on edges ${ok}`) : null;
    ctx.self.__fuse = i >= ta && i <= tb ? (b, a, Aq, ref) => { if (b && a && Math.max(...a.map((p, k) => Math.hypot(p[0] - b[k][0], p[1] - b[k][1]))) > 1) console.log(`  [${i}] fused sides: moved ${Math.max(...a.map((p, k) => Math.hypot(p[0] - b[k][0], p[1] - b[k][1]))).toFixed(1)}px`); } : null;
    posted.length = 0;
    if ((i - from) % STEP !== 0 || (DROP && rnd() < DROP) || STALLS.some(([a, n]) => i >= a && i < a + n)) { rows.push(rows.length ? { ...rows[rows.length - 1], done: false, f: i, phase: GT[i].phase, err: rows[rows.length - 1].q ? qerr(rows[rows.length - 1].q, GT[i].q) : null, inview: GT[i].q.every(([x, y]) => x >= MARGIN && x <= 1 - MARGIN && y >= MARGIN && y <= 1 - MARGIN), vis: GT[i].vis === undefined ? 1 : GT[i].vis } : { f: i, phase: GT[i].phase, inview: false, vis: 0, q: null, err: null }); continue; }
    ctx.self.onmessage({ data: { type: "frame", seq: i, cf: i, epoch: 0, frame: fakeFrame(i) } });
    for (let k = 0; k < 5 && !posted.length; k++) await new Promise((r) => setImmediate(r));
    let m = posted.find((p) => p.type === "quad");
    if (m && m.trace && m.trace.ev && m.trace.ev.some((e) => e.pull !== undefined) && process.env.PULLS) console.log(`pull @${i}`, JSON.stringify(m.trace.ev.filter((e) => e.pull !== undefined)));
    if (m && !SHOWN && m.trace && "tq" in m.trace) m = { ...m, quad: m.trace.tq };
    if (i >= ta && i <= tb) console.log(`[${i}] sides ${m && m.sides} ok ${vm.runInContext("trk.sideOk.join(',')", ctx)} err ${m && m.quad ? qerr(m.quad, GT[i].q).toFixed(2) : "-"}`);
    const g = GT[i], inview = g.q.every(([x, y]) => x >= MARGIN && x <= 1 - MARGIN && y >= MARGIN && y <= 1 - MARGIN);
    rows.push({ f: i, phase: g.phase, inview, vis: g.vis === undefined ? (inview ? 1 : 0.5) : g.vis, q: m && m.quad, err: m && m.quad ? qerr(m.quad, g.q) : null, sides: m ? m.sides : 0, src: m ? m.src : "", done: true, jump: !!(m && m.jump) });
  }
  const sum = {};
  for (const ph of ["still", "move"]) {
    const R = rows.filter((r) => r.inview && r.phase === ph);
    const E = R.filter((r) => r.err !== null).map((r) => r.err).sort((a, b) => a - b);
    sum[ph] = { found: E.length / Math.max(1, R.length), mean: E.reduce((a, b) => a + b, 0) / Math.max(1, E.length), p90: E[Math.floor(E.length * 0.9)] || 0, gt3: E.filter((e) => e > 3).length / Math.max(1, E.length) };
  }
  const P = rows.filter((r) => r.done && r.inview && r.phase === "move" && r.err !== null);
  sum.proc = P.reduce((a, r) => a + r.err, 0) / Math.max(1, P.length);
  sum.fail = P.filter((r) => r.err > 2).length / Math.max(1, P.length);
  // Stability: how much the outline moves against the page from one camera frame to the next (px at the
  // video's size), and how often it jumps (> 1% of the diagonal against the page in one frame) or restarts.
  const rel = (r) => { const G = GT[r.f].q; return r.q.map(([x, y], i) => [(x - G[i][0]) * W, (y - G[i][1]) * H]); };
  const J = [], diag = Math.hypot(W, H);
  let jumps = 0, restarts = 0, nStill = 0;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    if (b.jump && b.inview) restarts++;
    if (!a.q || !b.q || !a.inview || !b.inview || a.err === null || b.err === null || a.err > 3 || b.err > 3) continue;
    const ra = rel(a), rb = rel(b);
    // corners may be numbered differently from the truth; match by nearest
    const d = Math.max(...rb.map((p, i) => Math.hypot(p[0] - ra[i][0], p[1] - ra[i][1])));
    if (d > 0.01 * diag) jumps++;
    if (b.phase === "still" && a.phase === "still") { J.push(rb.reduce((s, p, i) => s + Math.hypot(p[0] - ra[i][0], p[1] - ra[i][1]), 0) / 4); nStill++; }
  }
  sum.jitter = J.length ? Math.sqrt(J.reduce((s, x) => s + x * x, 0) / J.length) : 0;
  sum.jumps = jumps; sum.restarts = restarts;
  const gone = rows.filter((r) => r.vis < 0.3);
  sum.goneShown = gone.length ? gone.filter((r) => r.q).length / gone.length : null;
  const f2 = (x) => (x === null || x === undefined ? "-" : x.toFixed(2));
  if (!quiet) {
    // per half-second windows
    const win = {};
    for (const r of rows) if (r.inview && r.err !== null) (win[Math.floor(r.f / 15)] = win[Math.floor(r.f / 15)] || []).push(r.err);
    console.log(Object.entries(win).map(([w, e]) => `${(w * 0.5).toFixed(1)}s:${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(2)}`).join(" "));
  }
  console.log(`${video.padEnd(8)} still ${f2(sum.still.mean)}% (found ${(sum.still.found * 100).toFixed(0)}%)  move ${f2(sum.move.mean)}% p90 ${f2(sum.move.p90)}% >3% ${(sum.move.gt3 * 100).toFixed(0)}% (found ${(sum.move.found * 100).toFixed(0)}%)  tracked-move ${f2(sum.proc)}% fails ${(sum.fail * 100).toFixed(1)}%  jitter ${f2(sum.jitter)}px jumps ${sum.jumps} restarts ${sum.restarts}  gone-shown ${sum.goneShown === null ? "-" : (sum.goneShown * 100).toFixed(0) + "%"}`);
  if (dump) fs.writeFileSync(dump, JSON.stringify(rows));
})();
