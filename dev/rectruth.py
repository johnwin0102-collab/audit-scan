"""True page corners for recorded sessions (recserve.py), marked by eye on key frames and carried to the frames around
them with the page's motion (recmotion.py), so replay_rec.js can score the outline on real pages.

usage: rectruth.py sheet <session> <i,j,..> <out.png>     key frames with a grid every 40 px (to mark corners on)
       rectruth.py set <session> <i> <x0,y0,x1,y1,x2,y2,x3,y3 | none>   a key frame's true corners (grey px, corners
                                                         clockwise from the top left; outside the picture where the page
                                                         goes beyond the view), or none: no page
       rectruth.py zoom <session> <i> <out.png>          the key frame's corners close up, with the marked outline
       rectruth.py build <session> [reach]               truth.json: key frames and the frames within reach (default 8)
                                                         of them, the corners moved with the page, clamped to the view
Marks are kept in videos/rec_<session>/keys.json. The pictures show John's real documents: dev/runs/ and dev/videos/
only (ignored by git)."""
import json, os, sys
import numpy as np, cv2

DEV = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, DEV)
import recview as RV


def keys_path(s): return os.path.join(DEV, "videos", "rec_" + s, "keys.json")


def load_keys(s):
    p = keys_path(s)
    return json.load(open(p)) if os.path.exists(p) else {}


def grid_img(g, k, step=40):
    img = cv2.cvtColor(cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC), cv2.COLOR_GRAY2BGR)
    h, w = g.shape
    for x in range(0, w + 1, step):
        cv2.line(img, (int(x * k), 0), (int(x * k), int(h * k)), (0, 170, 255) if x % 200 else (0, 90, 255), 1)
        cv2.putText(img, str(x), (int(x * k) + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 120, 255), 1)
    for y in range(0, h + 1, step):
        cv2.line(img, (0, int(y * k)), (int(w * k), int(y * k)), (0, 170, 255) if y % 200 else (0, 90, 255), 1)
        cv2.putText(img, str(y), (2, int(y * k) - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 120, 255), 1)
    return img


def draw(img, q, k, col, w=1):
    if q is None: return
    P = np.array([[x * k, y * k] for x, y in q], np.int32)
    cv2.polylines(img, [P], True, col, w, cv2.LINE_AA)


def main():
    a = sys.argv[1:]
    cmd, s = a[0], a[1]
    d, frames = RV.load(s)
    keys = load_keys(s)
    if cmd == "sheet":
        idx = [int(x) for x in a[2].split(",")]
        tiles = []
        for i in idx:
            fr = frames[i]
            g = RV.grey_of(d, fr)
            img = grid_img(g, 1.25)
            if str(i) in keys and keys[str(i)]: draw(img, keys[str(i)], 1.25, (255, 0, 255), 2)
            cv2.putText(img, f"#{i}", (40, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 0, 255), 2)
            tiles.append(img)
        cv2.imwrite(a[3], np.hstack(tiles))
    elif cmd == "set":
        i = a[2]
        keys[i] = None if a[3] == "none" else [[float(v) for v in a[3].split(",")[j:j + 2]] for j in range(0, 8, 2)]
        json.dump(keys, open(keys_path(s), "w"))
        print(s, i, keys[i])
    elif cmd == "zoom":
        i = a[2]
        fr = frames[int(i)]
        g = RV.grey_of(d, fr)
        q = keys[i]
        h, w = g.shape
        k, r = 4, 36
        pad = cv2.copyMakeBorder(g, r, r, r, r, cv2.BORDER_CONSTANT, value=0)
        tiles = []
        for j, (x, y) in enumerate(q):
            cx, cy = int(round(min(w, max(0, x)))), int(round(min(h, max(0, y))))
            c = cv2.cvtColor(cv2.resize(pad[cy:cy + 2 * r, cx:cx + 2 * r], None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC), cv2.COLOR_GRAY2BGR)
            # the marked sides near this corner
            for t in (q[j - 1], q[(j + 1) % 4]):
                p0 = ((x - cx + r) * k, (y - cy + r) * k)
                p1 = (p0[0] + (t[0] - x) * k, p0[1] + (t[1] - y) * k)
                cv2.line(c, (int(p0[0]), int(p0[1])), (int(p1[0]), int(p1[1])), (255, 0, 255), 1, cv2.LINE_AA)
            for v in range(-r, r + 1, 8):
                cv2.putText(c, str(cx + v), (int((v + r) * k) + 1, 10), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (0, 160, 255), 1)
                cv2.line(c, (int((v + r) * k), 0), (int((v + r) * k), 4), (0, 160, 255), 1)
                cv2.putText(c, str(cy + v), (1, int((v + r) * k) + 3), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (0, 160, 255), 1)
            cv2.putText(c, f"corner {j}", (60, 2 * r * k - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1)
            tiles.append(c)
        cv2.imwrite(a[3], np.hstack(tiles))
    elif cmd == "build":
        reach = int(a[2]) if len(a) > 2 else 8
        M = json.load(open(os.path.join(d, "motion.json")))
        truth = {}
        for i, q in keys.items():
            i = int(i)
            fr = frames[i]
            W, H = fr["w"], fr["h"]
            truth[i] = None if q is None else [[min(1, max(0, x / W)), min(1, max(0, y / H))] for x, y in q]
            if q is None:
                for j in range(max(0, i - reach), min(len(frames), i + reach + 1)): truth.setdefault(j, None)
                continue
            for step in (1, -1):
                P = np.array(q, np.float64)
                j = i
                for _ in range(reach):
                    # forward: frame j -> j+1 is M[j+1]; backward: j -> j-1 is M[j] inverted
                    nj = j + step
                    if not (0 <= nj < len(frames)) or frames[nj]["w"] != W: break
                    Hm = M[nj] if step == 1 else M[j]
                    if Hm is None: break
                    Hm = np.array(Hm).reshape(3, 3)
                    if step == -1: Hm = np.linalg.inv(Hm)
                    X = np.c_[P, np.ones(4)] @ Hm.T
                    P = X[:, :2] / X[:, 2:]
                    j += step
                    if j not in truth: truth[j] = [[min(1, max(0, x / W)), min(1, max(0, y / H))] for x, y in P]
        json.dump({str(k): v for k, v in sorted(truth.items())}, open(os.path.join(d, "truth.json"), "w"))
        print(s, len(keys), "key frames,", len(truth), "frames with truth")


if __name__ == "__main__":
    main()
