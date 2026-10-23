/* Audit Scan page finder: a small on-phone AI model (DocCornerNet, 224 x 224 input) that predicts
   the four page corners and how likely it is that a page is in view. Runs in its own worker so the
   camera preview stays smooth while pages are being processed. The page asks it about captures; the
   live outline worker asks it about camera frames through a MessagePort of its own. */
import * as ort from "./vendor/ml/ort.min.js";

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// Several CPU cores need cross-origin isolation, which the app's service worker switches on.
// Without it (first visit, before the service worker is running) the finder uses one core.
// Three at most: the camera, the screen, the live outline and the image engine need cores too.
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;

let session = null;
let minMs = 0;     // test hook: make each look take at least this long (a slower phone)
let fuzz = null;   // test hook: make the answers less exact, like the AI on harder real pages
function fuzzed(quad) {
  const F = fuzz;
  const rnd = () => { F.seed = (F.seed * 48271) % 2147483647; return F.seed / 2147483647; };
  const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  if (!F.bias) F.bias = [0, 1, 2, 3].map(() => { const a = rnd() * 2 * Math.PI; return [Math.cos(a) * F.b / 100, Math.sin(a) * F.b / 100]; });
  const wild = rnd() < F.o;
  return quad.map(([x, y], i) => {
    let nx = x + F.bias[i][0] + (gauss() * F.n) / 100, ny = y + F.bias[i][1] + (gauss() * F.n) / 100;
    if (wild) { nx += (rnd() - 0.5) * 0.12; ny += (rnd() - 0.5) * 0.12; }
    return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  });
}

const ready = (async () => {
  ort.env.wasm.wasmPaths = new URL("./vendor/ml/", self.location.href).href;
  ort.env.wasm.numThreads = THREADS;
  ort.env.wasm.proxy = false;
  const res = await fetch("./vendor/ml/doccornernet_lean.ort");
  if (!res.ok) throw new Error("The page finder model didn't download (HTTP " + res.status + ")");
  const bytes = new Uint8Array(await res.arrayBuffer());
  session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
})();

const input = new Float32Array(SIZE * SIZE * 3);
const SCALE = [0, 1, 2].map((c) => 1 / (255 * STD[c]));
const SHIFT = [0, 1, 2].map((c) => MEAN[c] / STD[c]);

async function detect(buffer) {
  const px = new Uint8ClampedArray(buffer);
  if (px.length !== SIZE * SIZE * 4) throw new Error("Expected a 224 x 224 frame");
  const t0 = performance.now();
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    input[j] = px[i] * SCALE[0] - SHIFT[0];
    input[j + 1] = px[i + 1] * SCALE[1] - SHIFT[1];
    input[j + 2] = px[i + 2] * SCALE[2] - SHIFT[2];
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, SIZE, SIZE, 3]) };
  const out = await session.run(feeds);
  let coords = null, logit = null;
  for (const k of Object.keys(out)) {
    const d = out[k].data;
    if (d.length === 8) coords = d;
    else if (d.length === 1) logit = d[0];
  }
  if (minMs) { const wait = minMs - (performance.now() - t0); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
  const ms = performance.now() - t0;
  if (!coords) return { quad: null, score: 0, ms };
  let quad = [0, 1, 2, 3].map((i) => [Math.min(1, Math.max(0, coords[2 * i])), Math.min(1, Math.max(0, coords[2 * i + 1]))]);
  if (fuzz) quad = fuzzed(quad);
  const score = logit === null ? 1 : 1 / (1 + Math.exp(-logit));
  return { quad, score, ms };
}

// One request at a time: the live outline, a capture's checks and the editor can overlap.
let queue = Promise.resolve();
function handle(msg, reply) {
  queue = queue.then(async () => {
    try {
      await ready;
      let result;
      if (msg.type === "init") result = { ok: true, threads: THREADS, isolated: !!self.crossOriginIsolated, cores: navigator.hardwareConcurrency || 0 };
      else if (msg.type === "detect") result = await detect(msg.buffer);
      else throw new Error("Unknown request: " + msg.type);
      reply({ id: msg.id, ok: true, result });
    } catch (err) {
      reply({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  });
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "port") {
    const port = msg.port;
    port.onmessage = (e) => handle(e.data || {}, (r) => port.postMessage(r));
    return;
  }
  if (msg.type === "debug") {
    minMs = msg.minMs || 0;
    fuzz = msg.fuzz ? { b: msg.fuzz.bias || 0, n: msg.fuzz.noise || 0, o: msg.fuzz.outlier || 0, seed: 12345 } : null;
    return;
  }
  handle(msg, (r) => self.postMessage(r));
};
