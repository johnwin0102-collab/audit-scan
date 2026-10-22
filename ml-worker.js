/* Audit Scan page finder: a small on-phone AI model (DocCornerNet, 224 x 224 input) that predicts
   the four page corners and how likely it is that a page is in view. Runs in its own worker so the
   camera preview stays smooth while pages are being processed. */
import * as ort from "./vendor/ml/ort.min.js";

const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let session = null;

const ready = (async () => {
  ort.env.wasm.wasmPaths = new URL("./vendor/ml/", self.location.href).href;
  ort.env.wasm.numThreads = 1;      // GitHub Pages can't enable the headers multi-threading needs
  ort.env.wasm.proxy = false;
  const res = await fetch("./vendor/ml/doccornernet_lean.ort");
  if (!res.ok) throw new Error("The page finder model didn't download (HTTP " + res.status + ")");
  const bytes = new Uint8Array(await res.arrayBuffer());
  session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
})();

const input = new Float32Array(SIZE * SIZE * 3);

async function detect(buffer) {
  const px = new Uint8ClampedArray(buffer);
  if (px.length !== SIZE * SIZE * 4) throw new Error("Expected a 224 x 224 frame");
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    input[j] = (px[i] / 255 - MEAN[0]) / STD[0];
    input[j + 1] = (px[i + 1] / 255 - MEAN[1]) / STD[1];
    input[j + 2] = (px[i + 2] / 255 - MEAN[2]) / STD[2];
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, SIZE, SIZE, 3]) };
  const out = await session.run(feeds);
  let coords = null, logit = null;
  for (const k of Object.keys(out)) {
    const d = out[k].data;
    if (d.length === 8) coords = d;
    else if (d.length === 1) logit = d[0];
  }
  if (!coords) return { quad: null, score: 0 };
  const quad = [0, 1, 2, 3].map((i) => [Math.min(1, Math.max(0, coords[2 * i])), Math.min(1, Math.max(0, coords[2 * i + 1]))]);
  const score = logit === null ? 1 : 1 / (1 + Math.exp(-logit));
  return { quad, score };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    await ready;
    let result;
    if (msg.type === "init") result = { ok: true };
    else if (msg.type === "detect") result = await detect(msg.buffer);
    else throw new Error("Unknown request: " + msg.type);
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
