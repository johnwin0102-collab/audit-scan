"""The AI page finder's answer for every frame of a test video (as the app would get it), for replays."""
import json, sys
import numpy as np, cv2
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect as DET
from y4m import frames, VIDEOS
for name in sys.argv[1:]:
    out = []
    for f, yuv, W, H in frames(name):
        rgb = cv2.cvtColor(yuv, cv2.COLOR_YUV2RGB_I420)
        q, sc = DET.ml_detect(rgb)
        q = [[min(1, max(0, x)), min(1, max(0, y))] for x, y in q]
        out.append({"q": q, "score": sc})
    json.dump(out, open(os.path.join(VIDEOS, f"ai_{name}.json"), "w"))
    print(name, len(out))
