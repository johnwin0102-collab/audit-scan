"""Makes the standard set of test videos (and the AI's answer for every frame of each), skipping any already made.
usage: make_videos.py [name ...]      (no names: the whole set; each video is about 1.2 GB, the set about 18 GB)"""
import os, subprocess, sys

DEV = os.path.dirname(os.path.abspath(__file__))
VIDEOS = os.path.join(DEV, "videos")
# name: (scene, seed, 3:4 camera). The 9:16 ones are what the app saw up to 1.3.1; the 3:4 ones what it sees now.
SET = {
    "wood": ("wood", 1, False),          # page on a wooden desk: approach, pan, roll, tilt, shake
    "clutter": ("clutter", 2, False),    # papers under and beside the page, dark objects
    "light": ("light", 3, False),        # page on a light table
    "under": ("under", 4, False),        # a bigger sheet just under the page, peeking out 1-1.5 cm
    "curl": ("curl", 5, False),          # page not lying flat (bowed edges)
    "hand": ("hand", 6, False),          # a finger on the page, the phone's shadow
    "partial": ("partial", 7, False),    # page slides partly out of view, leaves, comes back
    "dim": ("dim", 8, False),            # dim light, noisy
    "white": ("white", 10, False),       # white page on a white desk (no edges)
    "realcam": ("realcam", 31, False),   # held still over a page beside another sheet and a pen, like a real phone
    "stack": ("stack", 21, False),       # loose stack, sheets peeking out by centimetres, page overflowing the view
    "stack2": ("stack2", 11, False),     # a stapled document's pages peeking out a few mm (like John's stacks)
    "stack2_34": ("stack2", 11, True),   # the same, through a 4:3 camera
    "close": ("close", 12, True),        # held close: the page overflows the view, then fits
    "spread": ("spread", 13, True),      # an open booklet: the facing page touching the page
}

names = sys.argv[1:] or list(SET)
for name in names:
    scene, seed, wide = SET[name]
    if not os.path.exists(os.path.join(VIDEOS, name + ".json")):
        subprocess.run([sys.executable, os.path.join(DEV, "genvid.py"), name, scene, str(seed), "12.5"] + (["34"] if wide else []), check=True)
    if not os.path.exists(os.path.join(VIDEOS, "ai_" + name + ".json")):
        subprocess.run([sys.executable, os.path.join(DEV, "ai_precompute.py"), name], check=True)
print("videos ready in", VIDEOS)
