// Replays a session recorded on the phone (recserve.py) through a copy of live-worker.js in Node, frame by frame, with
// the AI's answers (and the classical finder's) arriving exactly when they did on the phone. With the released worker
// it gives back what the phone showed; with a changed one, what the phone would have shown.
// usage: node replay_rec.js <worker.js> <session> [--from i --to j] [--dump out.json] [--trace a-b] [--quiet]
//   (videos/rec_<session>/: frames.jsonl, grey.bin, ai.bin; motion.json from recmotion.py for the shake numbers,
//    truth.json from rectruth.py for the error numbers)
//   --pick/--switch/--agree/--no-gate/--inner/--flat/--no-calm/--no-shaped/--no-show-shaped: worker test settings (see the debug message in live-worker.js)
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const args = process.argv.slice(2);
const workerPath = args[0], session = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dump = opt("--dump", ""), quiet = args.includes("--quiet");
const DIR = path.join(__dirname, "videos", "rec_" + session);
const FR = fs.readFileSync(path.join(DIR, "frames.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const gfd = fs.openSync(path.join(DIR, "grey.bin"), "r"), afd = fs.openSync(path.join(DIR, "ai.bin"), "r");
const readAt = (fd, off, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return new Uint8Array(b.buffer, b.byteOffset, n); };
const MOTION = fs.existsSync(path.join(DIR, "motion.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "motion.json"))) : null;
const TRUTH = fs.existsSync(path.join(DIR, "truth.json")) ? JSON.parse(fs.readFileSync(path.join(DIR, "truth.json"))) : null;

const clock = { t: 0 };
const posted = [];
const ctx = {
  self: { postMessage: (m) => posted.push(m) }, performance: { now: () => clock.t }, console,
  setTimeout, Promise, Math, JSON, Map, Set, Array, Object, Number, String, Error, isFinite, TextEncoder,
  Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Int32Array, Uint32Array,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(workerPath, "utf8"), ctx, { filename: workerPath });
// The AI's answers come as recorded, for the frame they were about; the worker's own requests go nowhere.
vm.runInContext(`self.__answer = (f, quad, score, ms) => { ai.frame = f; onAIResult({ data: { id: ai.seq, ok: true, result: { quad, score, ms } } }); };`, ctx);
ctx.self.onmessage({ data: { type: "port", port: { postMessage() {}, onmessage: null } } });
const dbg = { type: "debug", trace: true };
if (opt("--pick", "")) dbg.pick = opt("--pick", "");
if (opt("--switch", "")) dbg.switch = opt("--switch", "");
if (opt("--agree", "")) dbg.agree = opt("--agree", "").split(",").map(Number);
if (args.includes("--no-gate")) dbg.gate = false;
if (opt("--inner", "")) dbg.inner = opt("--inner", "").split(",").map(Number);
if (opt("--flat", "")) dbg.flat = +opt("--flat", "");
if (args.includes("--no-calm")) dbg.calm = false;
if (args.includes("--no-band")) dbg.band = false;
if (args.includes("--no-snap-shaped")) dbg.snapShaped = false;
if (args.includes("--no-out-pull")) dbg.outPull = false;
if (opt("--widen", "")) dbg.widen = +opt("--widen", "");
if (args.includes("--no-shaped")) dbg.shaped = false;
if (args.includes("--no-show-shaped")) dbg.showShaped = false;
if (opt("--over", "")) dbg.over = opt("--over", "").split(",").map(Number);
ctx.self.onmessage({ data: dbg });
const TR = opt("--trace", "");
const [ta, tb] = TR ? TR.split("-").map(Number) : [1e9, -1];

// corner distance in grey px between two normalised quads (corners matched as numbered)
function apart(a, b, w, h) {
  let d = 0;
  for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot((a[i][0] - b[i][0]) * w, (a[i][1] - b[i][1]) * h));
  return d;
}
// mean corner distance, best corner matching (the truth may number corners from another one)
function qerr(s, g, w, h) {
  let best = 1e9;
  for (const order of [g, [g[0], g[3], g[2], g[1]]]) {
    for (let k = 0; k < 4; k++) {
      let e = 0;
      for (let i = 0; i < 4; i++) { const o = order[(i + k) % 4]; e += Math.hypot((s[i][0] - o[0]) * w, (s[i][1] - o[1]) * h); }
      best = Math.min(best, e / 4);
    }
  }
  return best;
}
// a normalised quad moved by homography H (grey px, row-major 3x3)
function warp(q, H, w, h) {
  return q.map(([x, y]) => {
    const X = x * w, Y = y * h, z = H[6] * X + H[7] * Y + H[8];
    return [(H[0] * X + H[1] * Y + H[2]) / z / w, (H[3] * X + H[4] * Y + H[5]) / z / h];
  });
}

(async () => {
  const from = +opt("--from", 0), to = Math.min(FR.length - 1, +opt("--to", FR.length - 1));
  const rows = [];
  let same = 0, compared = 0, lost = from > 0 ? FR[from].lost : 0;
  for (let i = from; i <= to; i++) {
    const fr = FR[i];
    // frames the recording lost (the PC fell behind or USB dropped): start afresh, as the phone's worker went on without them
    if (fr.lost !== lost || (i > from && fr.w !== FR[i - 1].w)) { ctx.self.onmessage({ data: { type: "reset" } }); lost = fr.lost; }
    for (const e of fr.ev || []) {
      if (e.t !== undefined) clock.t = e.t;
      if (e.ans !== undefined) ctx.self.__answer(e.ans, e.q, e.s, e.ms);
      else if (e.cv !== undefined) ctx.self.onmessage({ data: { type: "cv", seq: e.cv, quad: e.q } });
      else if (e.reset) ctx.self.onmessage({ data: { type: "reset" } });
      else if (e.ease !== undefined) ctx.self.onmessage({ data: { type: "ease", on: !!e.ease } });
    }
    // (when the worker followed the frame: tt, recorded since; before that, about when it was done with it)
    clock.t = fr.tt !== undefined ? fr.tt : fr.t0 + fr.ms;
    const grey = readAt(gfd, fr.goff, fr.g), aiPic = fr.a ? readAt(afd, fr.aoff, fr.a) : null;
    posted.length = 0; ctx.self.__calm = null;
    ctx.self.onmessage({ data: { type: "frame", seq: fr.f, cf: fr.cf, epoch: 0, grey, w: fr.w, h: fr.h, ai: aiPic, way: fr.way } });
    for (let k = 0; k < 5 && !posted.length; k++) await new Promise((r) => setImmediate(r));
    const m = posted.find((p) => p.type === "quad") || {};
    const q = m.quad || null, tq = m.trace ? m.trace.tq : null;
    // (does it do what the phone did? only meaningful for the worker the phone ran)
    compared++;
    if ((!q && !fr.q) || (q && fr.q && apart(q, fr.q, fr.w, fr.h) < 0.5)) same++;
    if (i >= ta && i <= tb) {
      console.log(`[${i}] f${fr.f} cf${fr.cf} shown ${q ? "yes" : "no"} (phone ${fr.q ? "yes" : "no"}${q && fr.q ? ", " + apart(q, fr.q, fr.w, fr.h).toFixed(1) + "px apart" : ""}) sides ${m.sides} ok ${m.trace && m.trace.ok} src ${m.src} ` +
        (m.trace && m.trace.ev && m.trace.ev.length ? JSON.stringify(m.trace.ev.filter((e) => e.ans === undefined)) : ""));
    }
    rows.push({ calm: ctx.self.__calm, why: ctx.self.__why, i, f: fr.f, cf: fr.cf, w: fr.w, h: fr.h, q, tq, sides: m.sides || 0, src: m.src || "", cut: !!m.cut, jump: !!m.jump, ok: m.trace ? m.trace.ok : "" });
  }
  // Numbers. shown: share of frames with an outline shown; blinks: times it went away and came back within 1 s;
  // shake: how far the outline's corners in view move against the scene from one frame to the next while shown (px of the grey picture,
  // mean and 90th percentile; the scene's motion from recmotion.py); jumps: frames where it moves > 1% of the diagonal
  // against the scene; err: mean corner error against truth.json, where there is truth (px).
  const S = { frames: rows.length, shown: rows.filter((r) => r.q).length / Math.max(1, rows.length) };
  let blinks = 0, offAt = -1;
  for (let k = 1; k < rows.length; k++) {
    if (rows[k - 1].q && !rows[k].q) offAt = rows[k].i;
    if (!rows[k - 1].q && rows[k].q && offAt >= 0 && FR[rows[k].i].t0 - FR[offAt].t0 < 1000) blinks++;
  }
  S.blinks = blinks;
  if (MOTION) {
    const sh = [];
    let jumps = 0;
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k], H = MOTION[b.i];
      if (!a.q || !b.q || !H || b.i !== a.i + 1 || a.w !== b.w) continue;
      // (corners pinned to the view's edge, for a page bigger than the view, don't count: they slide along it)
      const A = warp(a.q, H, a.w, a.h), m = 0.004;
      const inside = (p) => p[0] > m && p[0] < 1 - m && p[1] > m && p[1] < 1 - m;
      let d = 0;
      for (let c = 0; c < 4; c++) if (inside(a.q[c]) && inside(b.q[c])) d = Math.max(d, Math.hypot((A[c][0] - b.q[c][0]) * b.w, (A[c][1] - b.q[c][1]) * b.h));
      sh.push(d);
      if (d > 0.01 * Math.hypot(b.w, b.h)) jumps++;
    }
    sh.sort((x, y) => x - y);
    S.shake = sh.length ? sh.reduce((x, y) => x + y, 0) / sh.length : null;
    S.shake90 = sh.length ? sh[Math.floor(sh.length * 0.9)] : null;
    S.jumps = jumps;
  }
  if (TRUTH) {
    // truth: { i: quad or null (no page) }, for the frames labelled
    const E = [];
    let missed = 0, wrong = 0, nPage = 0, nNone = 0;
    for (const r of rows) {
      if (!(r.i in TRUTH)) continue;
      const g = TRUTH[r.i];
      if (g) { nPage++; if (!r.q) missed++; else E.push(qerr(r.q, g, r.w, r.h)); }
      else { nNone++; if (r.q) wrong++; }
    }
    E.sort((x, y) => x - y);
    S.err = E.length ? E.reduce((x, y) => x + y, 0) / E.length : null;
    S.err90 = E.length ? E[Math.floor(E.length * 0.9)] : null;
    S.off5 = E.length ? E.filter((e) => e > 5).length / E.length : null;
    S.missed = nPage ? missed / nPage : null;
    S.falseShown = nNone ? wrong / nNone : null;
  }
  S.samePhone = same / Math.max(1, compared);
  const f = (x, d = 2) => (x === null || x === undefined ? "-" : x.toFixed(d));
  console.log(`${session} frames ${S.frames} shown ${f(S.shown * 100, 0)}% blinks ${S.blinks} shake ${f(S.shake)}px p90 ${f(S.shake90)}px jumps ${S.jumps ?? "-"}` +
    (TRUTH ? ` err ${f(S.err)}px p90 ${f(S.err90)}px >5px ${f(S.off5 * 100, 0)}% missed ${f(S.missed * 100, 0)}% false ${f(S.falseShown * 100, 0)}%` : "") +
    ` same-as-phone ${f(S.samePhone * 100, 1)}%`);
  if (dump) fs.writeFileSync(dump, JSON.stringify(rows));
})();
