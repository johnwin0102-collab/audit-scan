"""Reading the test videos (videos/<name>.y4m, I420) frame by frame."""
import os
import numpy as np

VIDEOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")


def frames(name):
    """Yields (frame number, I420 frame as an (H*3/2) x W uint8 array, W, H)."""
    path = os.path.join(VIDEOS, name + ".y4m")
    with open(path, "rb") as fh:
        meta = fh.readline().decode()
    W = int(meta.split(" W")[1].split()[0]); H = int(meta.split(" H")[1].split()[0])
    mm = np.memmap(path, np.uint8, "r")
    off = len(meta)
    fs = W * H * 3 // 2
    i = 0
    while off + 6 + fs <= len(mm):
        yield i, np.asarray(mm[off + 6: off + 6 + fs]).reshape(H * 3 // 2, W), W, H
        off += 6 + fs
        i += 1
