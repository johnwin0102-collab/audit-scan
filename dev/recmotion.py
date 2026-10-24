"""How the page moved from each recorded frame to the next (recserve.py sessions): recmotion.py <session>
Writes videos/rec_<session>/motion.json: for frame i, the homography (row-major 3 x 3, grey px) taking frame i-1 to
frame i, or null. Points of print inside the page (the outline the phone followed, shrunk a little; the whole picture
when there is none) are tracked with optical flow and a homography fitted to them, so it follows the page itself even
when it's held in a hand and moves against the desk. replay_rec.js uses it to measure how the outline shakes against
the page."""
import json, os, sys
import numpy as np, cv2

DEV = os.path.dirname(os.path.abspath(__file__))


def main(session):
    d = os.path.join(DEV, "videos", "rec_" + session)
    frames = [json.loads(l) for l in open(os.path.join(d, "frames.jsonl"), encoding="utf8")]
    g = open(os.path.join(d, "grey.bin"), "rb")
    out, prev, prev_fr = [], None, None
    for i, fr in enumerate(frames):
        g.seek(fr["goff"])
        cur = np.frombuffer(g.read(fr["g"]), np.uint8).reshape(fr["h"], fr["w"])
        H = None
        if prev is not None and prev.shape == cur.shape:
            mask = np.zeros_like(prev)
            q = prev_fr.get("tq")
            if q:
                P = np.array([[x * fr["w"], y * fr["h"]] for x, y in q], np.float32)
                c = P.mean(0)
                cv2.fillConvexPoly(mask, ((P - c) * 0.9 + c).astype(np.int32), 255)
            else:
                mask[:] = 255
            pts = cv2.goodFeaturesToTrack(prev, 400, 0.01, 8, mask=mask, blockSize=5)
            if pts is not None and len(pts) >= 12:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, pts, None, winSize=(21, 21), maxLevel=3)
                ok = st.ravel() == 1
                if ok.sum() >= 12:
                    h, inl = cv2.findHomography(pts[ok], nxt[ok], cv2.RANSAC, 1.0)
                    if h is not None and inl.sum() >= max(10, 0.5 * ok.sum()):
                        H = (h / h[2, 2]).ravel().tolist()
        out.append(H)
        prev, prev_fr = cur, fr
    json.dump(out, open(os.path.join(d, "motion.json"), "w"))
    print(session, len(out), "frames,", sum(h is not None for h in out), "with motion")


if __name__ == "__main__":
    for s in sys.argv[1:]:
        main(s)
