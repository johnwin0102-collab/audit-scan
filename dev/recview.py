"""Pictures of a recorded session (see recserve.py): recview.py <session> <out.png> <frames> [--scale k] [--cols n]
                                                       [--run run.json ...]
  frames: "100,120,140" or "100-400:20" (every 20th frame from 100 to 400)
Each frame's grey picture with the outline shown on the phone (green; dashed where it was followed but not shown), the
AI's last answer (red), and the outlines of replayed runs (orange, cyan, magenta; replay.js --rec ... --dump run.json),
tiled into one picture. The pictures show John's real documents: keep them in dev/videos/ or dev/runs/ (ignored by git)."""
import json, os, sys
import numpy as np, cv2

DEV = os.path.dirname(os.path.abspath(__file__))


def load(session):
    d = os.path.join(DEV, "videos", "rec_" + session)
    frames = [json.loads(l) for l in open(os.path.join(d, "frames.jsonl"), encoding="utf8")]
    return d, frames


def grey_of(d, fr):
    with open(os.path.join(d, "grey.bin"), "rb") as g:
        g.seek(fr["goff"])
        return np.frombuffer(g.read(fr["g"]), np.uint8).reshape(fr["h"], fr["w"])


def parse_frames(s, n):
    if "-" in s:
        a, rest = s.split("-")
        b, step = (rest.split(":") + ["1"])[:2]
        return list(range(int(a), min(n - 1, int(b)) + 1, int(step)))
    return [int(x) for x in s.split(",")]


def poly(img, q, col, k, dashed=False):
    if not q: return
    h, w = img.shape[:2]
    P = [(x * w, y * h) for x, y in q]
    for i in range(4):
        a, b = np.array(P[i]), np.array(P[(i + 1) % 4])
        if dashed:
            n = max(2, int(np.linalg.norm(b - a) / (6 * k)))
            for j in range(0, n, 2):
                p0, p1 = a + (b - a) * j / n, a + (b - a) * min(n, j + 1) / n
                cv2.line(img, tuple(int(v) for v in p0), tuple(int(v) for v in p1), col, max(1, k // 2), cv2.LINE_AA)
        else:
            cv2.line(img, tuple(int(v) for v in a), tuple(int(v) for v in b), col, max(1, k // 2), cv2.LINE_AA)


def main():
    a = sys.argv[1:]
    k = int(a[a.index("--scale") + 1]) if "--scale" in a else 1
    cols = int(a[a.index("--cols") + 1]) if "--cols" in a else 6
    runs = []
    while "--run" in a:
        i = a.index("--run"); runs.append({r["i"]: r for r in json.load(open(a[i + 1]))}); del a[i:i + 2]
    session, out, which = a[0], a[1], a[2]
    d, frames = load(session)
    idx = parse_frames(which, len(frames))
    last_ai = {}
    ans = None
    for i, fr in enumerate(frames):
        for e in fr.get("ev") or []:
            if "ans" in e: ans = e
        last_ai[i] = ans
    tiles = []
    for i in idx:
        fr = frames[i]
        g = grey_of(d, fr)
        img = cv2.cvtColor(cv2.resize(g, (g.shape[1] * k, g.shape[0] * k), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
        A = last_ai[i]
        if A and A.get("s", 0) >= 0.5: poly(img, A["q"], (60, 60, 230), k)
        for r, col in zip(runs, [(0, 160, 255), (230, 220, 0), (230, 0, 230)]):
            if i in r and r[i].get("q"): poly(img, r[i]["q"], col, k)
        if fr.get("q"): poly(img, fr["q"], (80, 220, 80), k)
        elif fr.get("tq"): poly(img, fr["tq"], (80, 220, 80), k, dashed=True)
        cv2.putText(img, f"{i} cf{fr['cf']} {fr.get('ok', '')} {fr.get('src', '')}{' CUT' if fr.get('cut') else ''}", (4, 16 * max(1, k // 2) + 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45 * max(1, k // 2), (0, 255, 255), 1, cv2.LINE_AA)
        tiles.append(img)
    h, w = tiles[0].shape[:2]
    rows = []
    for r in range(0, len(tiles), cols):
        row = tiles[r:r + cols]
        row += [np.zeros_like(tiles[0])] * (cols - len(row))
        rows.append(np.hstack(row))
    cv2.imwrite(out, np.vstack(rows))
    print(out, len(tiles), "frames")


if __name__ == "__main__":
    main()
