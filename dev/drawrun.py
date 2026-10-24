"""Draw replay outlines (and the AI's answers) on frames of a test video: drawrun.py <video> <out.png> <step> <run.json>...
Run files come from replay.js --dump. Colours: red = AI answer, then blue, orange, green for the run files in order.
Optional --frames a-b limits the frames drawn; --width W sets the tile width (default 260)."""
import json, sys, numpy as np, cv2
from PIL import Image, ImageDraw
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from y4m import frames, VIDEOS
args = sys.argv[1:]
fr = None; tw = 260
if "--frames" in args: i = args.index("--frames"); fr = [int(x) for x in args[i + 1].split("-")]; del args[i:i + 2]
if "--width" in args: i = args.index("--width"); tw = int(args[i + 1]); del args[i:i + 2]
video, out, step = args[0], args[1], int(args[2])
runs = [json.load(open(p)) for p in args[3:]]
A = json.load(open(os.path.join(VIDEOS, "ai_" + video + ".json")))
cols = [(0, 90, 255), (255, 140, 0), (0, 170, 0)]
tiles = []
for i, yuv, W, H in frames(video):
    if i % step or (fr and not (fr[0] <= i <= fr[1])): continue
    rgb = cv2.cvtColor(yuv, cv2.COLOR_YUV2RGB_I420)
    s = tw / W
    im = Image.fromarray(rgb).resize((int(W * s), int(H * s)))
    d = ImageDraw.Draw(im)
    a = A[i]
    if a["score"] >= 0.5:
        pts = [(x * W * s, y * H * s) for x, y in a["q"]]; d.line(pts + [pts[0]], fill=(255, 0, 0), width=1)
    for c, R in zip(cols, runs):
        r = R[i] if i < len(R) else None
        if r and r.get("q"):
            pts = [(x * W * s, y * H * s) for x, y in r["q"]]; d.line(pts + [pts[0]], fill=c, width=2)
    d.rectangle((0, 0, 30, 12), fill=(0, 0, 0)); d.text((2, 0), str(i), fill=(255, 255, 0))
    tiles.append(im)
n = 8; Wt, Ht = tiles[0].size
rows = (len(tiles) + n - 1) // n
sh = Image.new("RGB", (n * Wt, rows * Ht), "white")
for k, t in enumerate(tiles): sh.paste(t, ((k % n) * Wt, (k // n) * Ht))
sh.save(out); print(out, sh.size)
