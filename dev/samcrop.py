"""Tries SlimSAM or MobileSAM ("cut out this object" models: Xenova/slimsam-77-uniform, Apache-2.0; Acly/MobileSAM, MIT;
not part of the app; the model folder says which) as a
page finder at capture: the app's AI page finder says roughly where the page is, a few points inside that outline
prompt SlimSAM, which traces the paper itself, and four corners are fitted to its mask.

usage: samcrop.py <model folder> <photos folder> <out folder>
  photos folder: JPEGs and captures.json (from phone_photos.js; John's documents: keep under dev/videos/)
Draws each photo with the crop the app took (green), the AI's outline (red), SlimSAM's mask (blue tint) and its
four corners (yellow), and writes sam.json with the corners and times."""
import json, os, sys, time
import numpy as np, cv2, onnxruntime as ort

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect as DET

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


class Sam:
    def __init__(self, folder):
        so = ort.SessionOptions()
        self.enc = ort.InferenceSession(os.path.join(folder, "vision_encoder.onnx"), so, providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(os.path.join(folder, "prompt_encoder_mask_decoder.onnx"), so, providers=["CPUExecutionProvider"])

    def embed(self, rgb):
        h, w = rgb.shape[:2]
        k = 1024 / max(h, w)
        nh, nw = round(h * k), round(w * k)
        x = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        x = (x - MEAN) / STD
        pad = np.zeros((1024, 1024, 3), np.float32)
        pad[:nh, :nw] = x
        t0 = time.perf_counter()
        emb, pos = self.enc.run(None, {"pixel_values": pad.transpose(2, 0, 1)[None]})
        return {"emb": emb, "pos": pos, "k": k, "nh": nh, "nw": nw, "h": h, "w": w, "ms": (time.perf_counter() - t0) * 1000}

    def masks(self, E, pts, labels):
        P = np.array(pts, np.float32)[None, None] * E["k"]
        L = np.array(labels, np.int64)[None, None]
        t0 = time.perf_counter()
        iou, m = self.dec.run(None, {"input_points": P, "input_labels": L, "image_embeddings": E["emb"], "image_positional_embeddings": E["pos"]})
        ms = (time.perf_counter() - t0) * 1000
        out = []
        for j in range(m.shape[2]):
            lo = m[0, 0, j]                                   # 256 x 256 logits over the padded 1024 square
            up = cv2.resize(lo, (1024, 1024), interpolation=cv2.INTER_LINEAR)[:E["nh"], :E["nw"]]
            mask = cv2.resize(up, (E["w"], E["h"]), interpolation=cv2.INTER_LINEAR) > 0
            out.append((float(iou[0, 0, j]), mask))
        return out, ms


class MobileSam:
    """MobileSAM (Acly/MobileSAM ONNX, MIT): the encoder takes the photo resized to 1024 on its long side (RGB, 0-255)
    and does its own normalising and padding; the decoder is SAM's, with points in that resized frame."""
    def __init__(self, folder):
        self.enc = ort.InferenceSession(os.path.join(folder, "mobile_sam_image_encoder.onnx"), providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(os.path.join(folder, "sam_mask_decoder_multi.onnx"), providers=["CPUExecutionProvider"])

    def embed(self, rgb):
        h, w = rgb.shape[:2]
        k = 1024 / max(h, w)
        x = cv2.resize(rgb, (round(w * k), round(h * k)), interpolation=cv2.INTER_LINEAR).astype(np.float32)
        t0 = time.perf_counter()
        (emb,) = self.enc.run(None, {"input_image": x})
        return {"emb": emb, "k": k, "h": h, "w": w, "ms": (time.perf_counter() - t0) * 1000}

    def masks(self, E, pts, labels):
        P = np.concatenate([np.array(pts, np.float32) * E["k"], [[0, 0]]])[None].astype(np.float32)
        L = np.array(list(labels) + [-1], np.float32)[None]
        t0 = time.perf_counter()
        m, iou, _ = self.dec.run(None, {"image_embeddings": E["emb"], "point_coords": P, "point_labels": L,
                                        "mask_input": np.zeros((1, 1, 256, 256), np.float32), "has_mask_input": np.zeros(1, np.float32),
                                        "orig_im_size": np.array([E["h"], E["w"]], np.float32)})
        ms = (time.perf_counter() - t0) * 1000
        return [(float(iou[0, j]), m[0, j] > 0) for j in range(m.shape[1])], ms


def quad_of(mask):
    """Four corners fitted to the mask's outline (its convex hull, so a finger biting into the page doesn't cut it)."""
    m = mask.astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cs: return None
    c = max(cs, key=cv2.contourArea)
    hull = cv2.convexHull(c)
    per = cv2.arcLength(hull, True)
    for eps in np.linspace(0.01, 0.12, 23):
        ap = cv2.approxPolyDP(hull, eps * per, True)
        if len(ap) == 4: return order(ap.reshape(4, 2).astype(np.float64))
        if len(ap) < 4: break
    # fallback: drop the hull vertex costing least area until four are left
    H = hull.reshape(-1, 2).astype(np.float64).tolist()
    while len(H) > 4:
        best, bi = None, -1
        for i in range(len(H)):
            a, b, cc = np.array(H[i - 1]), np.array(H[i]), np.array(H[(i + 1) % len(H)])
            cost = abs(np.cross(b - a, cc - a)) / 2
            if best is None or cost < best: best, bi = cost, i
        H.pop(bi)
    return order(np.array(H))


def clean(mask):
    """The mask closed over the gaps print leaves, its biggest piece only, holes filled."""
    h, w = mask.shape
    k = max(3, int(0.012 * max(h, w))) | 1
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1: return m.astype(bool)
    big = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = (lab == big).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    f = np.zeros_like(m)
    cv2.drawContours(f, cs, -1, 1, -1)
    return f.astype(bool)


def quad_by_sides(mask, A, keep=0.97):
    """Four corners from the mask's outline: each point of it goes to the side of A (the AI's outline, corners in the
    photo's px) whose line it lies nearest, each side gets a straight line fitted robustly to its points and moved out
    so that `keep` of them are inside it (a curled edge bulges: the crop takes it in), and the corners are where the
    lines meet."""
    cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs: return None
    C = max(cs, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    if len(C) > 4000: C = C[:: len(C) // 4000]
    ctr = A.mean(0)
    sides = []
    for i in range(4):
        a, b = A[i], A[(i + 1) % 4]
        d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
        n = np.array([-d[1], d[0]])
        if np.dot((a + b) / 2 - ctr, n) < 0: n = -n
        sides.append((a, d, n))
    dist = np.stack([np.abs((C - a) @ n) for a, d, n in sides], 1)
    who = dist.argmin(1)
    lines = []
    for i, (a, d, n) in enumerate(sides):
        P = C[who == i]
        if len(P) < 20: return None
        t = (P - a) @ d
        o = (P - a) @ n
        # robust line o = p + q t: the least-squares fit, then again without the points far off it
        p_, q_ = np.polyfit(t, o, 1)[::-1]
        for _ in range(3):
            r = o - (p_ + q_ * t)
            keep_ = np.abs(r - np.median(r)) < 3 * (np.median(np.abs(r - np.median(r))) + 1)
            if keep_.sum() < 10: break
            q_, p_ = np.polyfit(t[keep_], o[keep_], 1)
        r = o - (p_ + q_ * t)
        p_ += np.quantile(r, keep)          # out, so the curl is in
        # the line as a point and a direction
        lines.append((a + p_ * n, d + q_ * n))
    Q = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        M = np.array([d1, -d2]).T
        if abs(np.linalg.det(M)) < 1e-9: return None
        s_ = np.linalg.solve(M, p2 - p1)
        Q.append(p1 + s_[0] * d1)
    return np.array(Q)


def order(P):
    """Corners clockwise from the top left."""
    c = P.mean(0)
    ang = np.arctan2(P[:, 1] - c[1], P[:, 0] - c[0])
    P = P[np.argsort(ang)]
    i = np.argmin(P.sum(1))
    return np.roll(P, -i, axis=0)


def poly_mask(q, h, w):
    m = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(m, np.array(q, np.int32), 1)
    return m.astype(bool)


def main():
    model, src, out = sys.argv[1:4]
    os.makedirs(out, exist_ok=True)
    sam = MobileSam(model) if os.path.exists(os.path.join(model, "mobile_sam_image_encoder.onnx")) else Sam(model)
    caps = json.load(open(os.path.join(src, "captures.json")))
    res = []
    for c in caps:
        bgr = cv2.imread(os.path.join(src, c["file"]))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        aq, sc = DET.ml_detect(rgb)
        A = np.array([[min(1, max(0, x)) * w, min(1, max(0, y)) * h] for x, y in aq])
        E = sam.embed(rgb)
        # Hints: a 3 x 3 grid of points on the AI's page (its outline shrunk to 60% round its middle), and, unless
        # --no-neg, a point just outside the middle of each of its sides (inside the photo) saying "not the page"
        ctr = A.mean(0)
        def at(u, v):   # a point of the AI's quad, bilinearly
            return (1 - v) * ((1 - u) * A[0] + u * A[1]) + v * ((1 - u) * A[3] + u * A[2])
        pts = [at(0.5 + 0.3 * (u - 0.5) * 2, 0.5 + 0.3 * (v - 0.5) * 2) for u in (0, 0.5, 1) for v in (0, 0.5, 1)]
        labels = [1] * len(pts)
        if "--no-neg" not in sys.argv:
            for i in range(4):
                mid = (A[i] + A[(i + 1) % 4]) / 2
                p = mid + 0.12 * (mid - ctr)
                if 0 <= p[0] < w and 0 <= p[1] < h: pts.append(p); labels.append(0)
        ms, dms = sam.masks(E, pts, labels)
        Am = poly_mask(A, h, w)
        def ov(m): i = (m & Am).sum(); u = (m | Am).sum(); return i / u if u else 0
        # the mask SlimSAM is surest of among those holding most of the page points
        inside = lambda m: sum(m[min(h - 1, max(0, int(p[1]))), min(w - 1, max(0, int(p[0])))] for p, l in zip(pts, labels) if l == 1)
        cand = [(sj, mj, ov(mj), inside(mj)) for sj, mj in ms]
        best = max(c[3] for c in cand)
        s, m, o, _ = max([c for c in cand if c[3] >= best - 1], key=lambda c: c[0])
        if "--all" in sys.argv:
            for j, (sj, mj, oj, nj) in enumerate(cand):
                v = bgr.copy(); v[mj] = (0.5 * v[mj] + 0.5 * np.array([255, 120, 0])).astype(np.uint8)
                cv2.putText(v, f"mask {j} sam {sj:.2f} ov {oj:.2f} pts {nj}", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 255, 255), 4)
                cv2.imwrite(os.path.join(out, c["file"][:-4] + f"_m{j}.jpg"), cv2.resize(v, (w // 6, h // 6), interpolation=cv2.INTER_AREA))
        m = clean(m)
        q = quad_by_sides(m, A)
        if q is None or not cv2.isContourConvex(q.astype(np.float32).reshape(-1, 1, 2)): q = quad_of(m)
        app = np.array([[x * w, y * h] for x, y in c["quad"]]) if c.get("quad") and max(max(p) for p in c["quad"]) <= 1.01 else None
        vis = bgr.copy()
        tint = vis.copy(); tint[m] = (0.5 * tint[m] + 0.5 * np.array([255, 120, 0])).astype(np.uint8); vis = tint
        def draw(P, col, t):
            if P is not None: cv2.polylines(vis, [np.array(P, np.int32)], True, col, t, cv2.LINE_AA)
        draw(A, (0, 0, 255), 6); draw(app, (0, 220, 0), 6); draw(q, (0, 230, 255), 8)
        for p, l in zip(pts, labels): cv2.circle(vis, (int(p[0]), int(p[1])), 18, (0, 255, 0) if l else (0, 0, 255), -1)
        cv2.putText(vis, f"{c['file']} sam {s:.2f} ov {o:.2f} enc {E['ms']:.0f}ms dec {dms:.0f}ms", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 255, 255), 4)
        cv2.imwrite(os.path.join(out, c["file"]), cv2.resize(vis, (w // 4, h // 4), interpolation=cv2.INTER_AREA))
        res.append({"file": c["file"], "ai": (A / [w, h]).tolist(), "sam": (q / [w, h]).tolist() if q is not None else None,
                    "app": c.get("quad"), "score": s, "overlap_ai": o, "enc_ms": E["ms"], "dec_ms": dms})
        print(c["file"], f"sam {s:.2f} overlap-with-ai {o:.2f} enc {E['ms']:.0f} ms dec {dms:.0f} ms", flush=True)
    json.dump(res, open(os.path.join(out, "sam.json"), "w"), indent=0)


if __name__ == "__main__":
    main()
