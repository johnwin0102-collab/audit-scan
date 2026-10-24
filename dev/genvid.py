"""Synthetic phone-camera videos of a page on a desk, with the true page corners for every frame.

The phone is a pinhole camera 25-45 cm above the desk that approaches, holds still, pans, rotates,
tilts and shakes, with hand tremor throughout, motion blur, lighting and sensor noise.
Writes videos/<name>.y4m (I420, 30 fps, 1080 x 1920 portrait, or 1440 x 1920 with "34") and videos/<name>.json:
  {"fps": 30, "w": 1080, "h": 1920, "frames": [{"q": [[x,y] x4 normalised TL TR BR BL], "phase": "still|move"}...]}
A frame-number barcode sits in the bottom-right corner (16 squares of 12 px) for checking alignment.

usage: genvid.py <name> <scene> <seed> [seconds] [34]
  scenes: wood clutter light dark under curl hand partial dim white realcam stack stack2 close spread
  (make_videos.py makes the standard set)
"""
import json, math, os, sys
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import docs

W, H, FPS = 1080, 1920, 30
F = 0.72 * H                      # focal length in px (about a 26 mm phone lens)
PXCM = 40                         # world texture resolution, px per cm
WW, WH = 100, 120                 # desk area in cm
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos")
os.makedirs(HERE, exist_ok=True)


def rot(ax, a):
    c, s = math.cos(a), math.sin(a)
    if ax == "x": return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if ax == "y": return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def homography(cam):
    """World desk plane (X, Y in cm, Z = 0, Z into the desk) -> image px. cam: x, y, h (cm), tilt, pitch, roll (deg)."""
    R = rot("z", math.radians(cam["roll"])) @ rot("x", math.radians(cam["tilt"])) @ rot("y", math.radians(cam["pitch"]))
    C = np.array([cam["x"], cam["y"], -cam["h"]])
    K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], -R @ C])
    return Hm / Hm[2, 2]


def wood(rng, w, h):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    grain = np.sin(xx / 23.0 + 3 * np.sin(yy / 310.0) + 1.5 * np.sin(xx / 97.0)) * 0.5 + 0.5
    v = 105 + 26 * grain + rng.normal(0, 4, (h, w))
    v = cv2.GaussianBlur(v.astype(np.float32), (0, 0), 1.2)
    return np.dstack([v * 0.58, v * 0.78, v]).clip(0, 255)


def light_table(rng, w, h):
    v = 196 + rng.normal(0, 3, (h, w)).astype(np.float32)
    v = cv2.GaussianBlur(v, (0, 0), 2.0)
    return np.dstack([v * 0.97, v * 0.98, v]).clip(0, 255)


def white_table(rng, w, h):
    v = 232 + rng.normal(0, 3, (h, w)).astype(np.float32)
    v = cv2.GaussianBlur(v, (0, 0), 2.0)
    return np.dstack([v * 0.98, v * 0.99, v]).clip(0, 255)


def bedsheet(rng, w, h):
    """A cream bedsheet with olive and yellow leaves and soft wrinkles (like the bed John scans on)."""
    base = np.zeros((h, w, 3), np.float32)
    base[:] = (200, 221, 228)
    leaves = np.zeros((h, w, 3), np.uint8)
    for _ in range(int(w * h / 9000)):
        cx, cy = int(rng.uniform(0, w)), int(rng.uniform(0, h))
        a, b = int(rng.uniform(18, 60)), int(rng.uniform(8, 22))
        col = (95, 160, 150) if rng.random() < 0.6 else (120, 196, 205)
        cv2.ellipse(leaves, (cx, cy), (a, b), float(rng.uniform(0, 180)), 0, 360, col, -1)
    m = (leaves.sum(2) > 0)[..., None]
    img = np.where(m, leaves.astype(np.float32), base)
    img = cv2.GaussianBlur(img, (0, 0), 1.5)
    wr = cv2.GaussianBlur(rng.normal(0, 1, (h // 16, w // 16)).astype(np.float32), (0, 0), 2.0)
    wr = cv2.resize(wr, (w, h), interpolation=cv2.INTER_CUBIC)
    img *= (1 + 0.06 * wr / (np.abs(wr).max() + 1e-6))[..., None]
    return (img + rng.normal(0, 3, img.shape)).clip(0, 255)


def dark_desk(rng, w, h):
    v = 48 + rng.normal(0, 5, (h, w)).astype(np.float32)
    v = cv2.GaussianBlur(v, (0, 0), 1.0)
    return np.dstack([v * 1.05, v, v * 0.95]).clip(0, 255)


def contact_shadow(world, corners_cm, dark=0.28, sigma=4):
    """The thin shadow a sheet casts on whatever it lies on, all round its edge (diffuse room light), about
    sigma/PXCM cm wide, so a sheet's edge shows against the sheet under it as it does on a real stack."""
    sh = np.zeros(world.shape[:2], np.float32)
    cv2.fillConvexPoly(sh, np.int32(np.float32(corners_cm) * PXCM), 1.0)
    return world * (1 - dark * cv2.GaussianBlur(sh, (0, 0), sigma)[..., None])


def place(world, img, corners_cm, shade=1.0):
    h, w = img.shape[:2]
    dst = np.float32(corners_cm) * PXCM
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), dst)
    warped = cv2.warpPerspective(img.astype(np.float32) * shade, M, (world.shape[1], world.shape[0]), flags=cv2.INTER_AREA)
    mask = cv2.warpPerspective(np.full((h, w), 1.0, np.float32), M, (world.shape[1], world.shape[0]))[..., None]
    return world * (1 - mask) + warped * mask


def place_curved(world, img, cx, cy, ang, sag, shade=1.0, w=21.0, h=29.7):
    """The page with its top and bottom edges bowed outwards by `sag` cm at the middle (a page that
    isn't lying flat); its sides and corners stay put."""
    a = math.radians(ang)
    pc = page_corners(cx, cy, ang, w, h)
    xs = [p[0] for p in pc]; ys = [p[1] for p in pc]
    x0, x1 = int((min(xs) - sag - 1) * PXCM), int((max(xs) + sag + 1) * PXCM)
    y0, y1 = int((min(ys) - sag - 1) * PXCM), int((max(ys) + sag + 1) * PXCM)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    X = xx / PXCM - cx; Y = yy / PXCM - cy
    # world -> page-local (u along the page width, v down the page), origin at the top-left corner
    u = X * math.cos(a) + Y * math.sin(a) + w / 2
    Yl = -X * math.sin(a) + Y * math.cos(a) + h / 2
    q = sag * (1 - (2 * u / w - 1) ** 2)
    v = (Yl + q) / (1 + 2 * q / h)
    ih, iw = img.shape[:2]
    mx = (u / w * iw).astype(np.float32); my = (v / h * ih).astype(np.float32)
    inside = (u >= 0) & (u <= w) & (v >= 0) & (v <= h)
    patch = cv2.remap(img.astype(np.float32) * shade, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    m = cv2.GaussianBlur(inside.astype(np.float32), (3, 3), 0)[..., None]
    region = world[y0:y1, x0:x1]
    world[y0:y1, x0:x1] = region * (1 - m) + patch * m
    return world, inside, (x0, y0)


def page_corners(cx, cy, ang, w=21.0, h=29.7):
    a = math.radians(ang)
    pts = []
    for x, y in [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]:
        pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    return pts


def build_world(scene, rng, seed):
    w, h = WW * PXCM, WH * PXCM
    world = {"wood": wood, "clutter": wood, "light": light_table, "dark": dark_desk, "under": wood, "curl": wood,
             "hand": wood, "partial": wood, "dim": light_table, "white": white_table, "realcam": wood, "stack": bedsheet,
             "stack2": bedsheet, "close": bedsheet, "spread": bedsheet}[scene](rng, w, h)
    cx, cy = WW / 2, WH / 2
    ang = rng.uniform(-6, 6)
    if scene == "clutter":
        # papers under and beside the page, a dark object near the top edge
        for i, (dx, dy, da) in enumerate([(0, -33, 9), (-26, 6, -14), (24, 20, 21)]):
            other = docs.make(["invoice", "statement", "workpaper", "letter"][(seed + i + 1) % 4], seed + 50 + i)
            world = place(world, other, page_corners(cx + dx + rng.uniform(-3, 3), cy + dy + rng.uniform(-3, 3), ang + da), shade=rng.uniform(0.86, 0.96))
    if scene == "under":
        # a bigger sheet just under the page, sticking out 1-1.5 cm on two sides
        other = docs.make("statement", seed + 77)
        world = place(world, other, page_corners(cx - 1.2, cy - 1.0, ang + 2.5, 22.0, 31.0), shade=0.93)
    if scene == "stack":
        # a loose stack of printed sheets under the page, each sticking out a little on some side
        for i in range(6):
            other = docs.make(["guide", "statement", "guide", "letter", "guide", "workpaper"][i], seed + 200 + i)
            dx, dy, da = rng.uniform(-2.6, 2.6), rng.uniform(-2.2, 2.2), rng.uniform(-5, 5)
            opc = page_corners(cx + dx, cy + dy, ang + da)
            sh = np.zeros(world.shape[:2], np.float32)
            cv2.fillConvexPoly(sh, np.int32(np.float32(opc) * PXCM + np.float32([6, 9])), 1.0)
            world = world * (1 - 0.25 * cv2.GaussianBlur(sh, (0, 0), 8)[..., None])
            world = place(world, other, opc, shade=rng.uniform(0.9, 0.97))
    if scene in ("stack2", "close"):
        # a stapled document's pages under the page, nearly aligned (each peeks out a few mm to a centimetre or so),
        # the same kind of page as the top one, like the stacks John scans
        for i in range(6):
            other = docs.make("guide", seed + 300 + i)
            dx, dy, da = rng.uniform(-1.2, 1.2), rng.uniform(-1.0, 1.0), rng.uniform(-2, 2)
            opc = page_corners(cx + dx, cy + dy, ang + da)
            world = contact_shadow(world, opc)
            world = place(world, other, opc, shade=rng.uniform(0.9, 0.97))
    if scene == "spread":
        # an open booklet: the facing page to the left of the page, touching it, both on the stack below
        for i in range(3):
            other = docs.make("guide", seed + 400 + i)
            opc = page_corners(cx + rng.uniform(-0.8, 0.8), cy + rng.uniform(-0.8, 0.8), ang + rng.uniform(-1.5, 1.5))
            world = contact_shadow(world, opc)
            world = place(world, other, opc, shade=rng.uniform(0.9, 0.96))
        left = docs.make("guide", seed + 410)
        a = math.radians(ang)
        world = place(world, left, page_corners(cx - 21.0 * math.cos(a), cy - 21.0 * math.sin(a), ang), shade=0.93)
    page = docs.make("guide" if scene in ("stack", "stack2", "close", "spread") else ["letter", "invoice", "statement", "workpaper"][seed % 4], seed)
    pc = page_corners(cx, cy, ang)
    # soft shadow under the page
    sh = np.zeros(world.shape[:2], np.float32)
    cv2.fillConvexPoly(sh, np.int32(np.float32(pc) * PXCM + np.float32([12, 18])), 1.0)
    sh = cv2.GaussianBlur(sh, (0, 0), 14)
    world = world * (1 - (0.2 if scene == "under" else 0.12 if scene in ("stack2", "close", "spread") else 0.35) * sh[..., None])
    if scene in ("stack2", "close", "spread"): world = contact_shadow(world, pc)
    if scene == "realcam":
        # another sheet beside the page and a pen; the page itself not quite flat
        other = docs.make("statement", seed + 91)
        world = place(world, other, page_corners(cx + 23.5, cy + 4, ang - 8), shade=0.9)
        cv2.line(world, (int((cx - 16) * PXCM), int((cy + 12) * PXCM)), (int((cx - 13) * PXCM), int((cy - 2) * PXCM)), (40, 30, 160), int(0.8 * PXCM))
        world, _, _ = place_curved(world, page, cx, cy, ang, 0.2, shade=0.97)
    elif scene == "curl":
        world, _, _ = place_curved(world, page, cx, cy, ang, 0.7, shade=0.97)
    else:
        world = place(world, page, pc, shade=0.97)
    if scene == "hand":
        # a finger holding the page down across its left edge
        p0 = np.float32(pc[3]) + (np.float32(pc[0]) - np.float32(pc[3])) * 0.3
        d = np.float32([math.cos(math.radians(ang)), math.sin(math.radians(ang))])
        a0 = (p0 - d * 6.0) * PXCM; a1 = (p0 + d * 2.2) * PXCM
        cv2.line(world, tuple(int(v) for v in a0), tuple(int(v) for v in a1), (120, 150, 205), int(1.7 * PXCM))
        cv2.circle(world, tuple(int(v) for v in a1), int(0.85 * PXCM), (120, 150, 205), -1)
    if scene == "clutter":
        top = (np.float32(pc[0]) + np.float32(pc[1])) / 2
        cv2.ellipse(world, (int(top[0] * PXCM + 160), int(top[1] * PXCM - 260)), (300, 150), 15, 0, 360, (35, 40, 48), -1)
        cv2.circle(world, (int(pc[2][0] * PXCM + 330), int(pc[2][1] * PXCM + 80)), 190, (30, 30, 35), -1)
    # desk lamp: broad light gradient fixed to the desk
    yy, xx = np.mgrid[0:world.shape[0], 0:world.shape[1]].astype(np.float32)
    lamp = 0.78 + 0.3 * np.exp(-(((xx - w * 0.3) / (w * 0.6)) ** 2 + ((yy - h * 0.25) / (h * 0.7)) ** 2))
    world = world * lamp[..., None]
    return world.clip(0, 255).astype(np.uint8), pc


def smooth(t, a, b):
    if t <= a: return 0.0
    if t >= b: return 1.0
    u = (t - a) / (b - a)
    return u * u * (3 - 2 * u)


def path_hold(t, tr):
    """Someone holding the phone over the page, waiting for it to capture: come in, hold, nudge, hold."""
    cam = {"x": WW / 2, "y": WH / 2, "h": 34.0, "tilt": 0.0, "pitch": 0.0, "roll": 0.0}
    k = smooth(t, 0.0, 1.2)
    cam["x"] += 8 * (1 - k); cam["y"] += 10 * (1 - k); cam["h"] += 8 * (1 - k); cam["roll"] += 8 * (1 - k)
    n = smooth(t, 5.0, 5.6)                        # a small nudge
    cam["x"] += 1.5 * n; cam["y"] -= 1.0 * n; cam["roll"] += 3 * n
    d = smooth(t, 9.0, 10.5)                       # slow drift
    cam["x"] -= 1.0 * d; cam["h"] += 1.5 * d
    cam["x"] += tr["x"](t); cam["y"] += tr["y"](t); cam["roll"] += tr["r"](t); cam["tilt"] += tr["t"](t); cam["pitch"] += tr["p"](t)
    return cam


def path_close(t, tr):
    """Close over a page on a stack, the way John holds the phone: the page fills most of the view."""
    cam = {"x": WW / 2, "y": WH / 2, "h": 28.0, "tilt": 0.0, "pitch": 0.0, "roll": 0.0}
    k = smooth(t, 0.0, 1.0)
    cam["x"] += 6 * (1 - k); cam["y"] += 8 * (1 - k); cam["h"] += 12 * (1 - k); cam["roll"] += 6 * (1 - k)
    a = smooth(t, 4.0, 5.5)                        # slide along: the page's right side leaves the view
    cam["x"] += 4.0 * a; cam["roll"] -= 3 * a
    b = smooth(t, 7.5, 8.5)                        # come closer: the page's sides pass the view's edges
    cam["h"] -= 3.5 * b; cam["x"] -= 3.0 * b
    c = smooth(t, 10.0, 11.0)                      # back off
    cam["h"] += 6.5 * c; cam["x"] -= 1.0 * c; cam["roll"] += 4 * c
    cam["x"] += tr["x"](t); cam["y"] += tr["y"](t); cam["roll"] += tr["r"](t); cam["tilt"] += tr["t"](t); cam["pitch"] += tr["p"](t)
    return cam


def path_near(t, tr):
    """Held close over a page on a stapled stack, the way John does: the page overflows the view top and bottom
    at first, the phone backs off until it just fits, holds, slides to the next page's place, comes close again."""
    cam = {"x": WW / 2, "y": WH / 2, "h": 20.0, "tilt": 0.0, "pitch": 0.0, "roll": 0.0}
    k = smooth(t, 0.0, 0.8)
    cam["x"] += 3 * (1 - k); cam["y"] += 4 * (1 - k); cam["roll"] += 4 * (1 - k)
    a = smooth(t, 3.0, 4.2)                        # back off until the whole page fits
    cam["h"] += 7.5 * a
    b = smooth(t, 6.5, 7.3) - smooth(t, 8.3, 9.1)  # a sideways sway (looking at the page)
    cam["x"] += 2.5 * b; cam["roll"] -= 2 * b
    c = smooth(t, 10.0, 11.0)                      # come close again
    cam["h"] -= 6.0 * c; cam["y"] += 2.0 * c
    cam["x"] += tr["x"](t); cam["y"] += tr["y"](t); cam["roll"] += tr["r"](t); cam["tilt"] += tr["t"](t); cam["pitch"] += tr["p"](t)
    return cam


def path_partial(t, tr):
    """Page slides partly out of view, leaves it completely, then comes back."""
    cam = {"x": WW / 2, "y": WH / 2, "h": 33.0, "tilt": 0.0, "pitch": 0.0, "roll": 0.0}
    k = smooth(t, 0.0, 1.0)
    cam["x"] += 10 * (1 - k); cam["h"] += 8 * (1 - k)
    a = smooth(t, 2.5, 3.5) - smooth(t, 4.5, 5.5)       # right side leaves the frame
    cam["x"] += 9 * a
    b = smooth(t, 6.5, 7.5) - smooth(t, 9.0, 10.0)      # page leaves the frame completely (desk only)
    cam["x"] += 30 * b; cam["y"] += 8 * b
    cam["x"] += tr["x"](t); cam["y"] += tr["y"](t); cam["roll"] += tr["r"](t); cam["tilt"] += tr["t"](t)
    return cam


def visible(q):
    """Share of the page's area inside the frame."""
    poly = np.float32(q)
    full = abs(cv2.contourArea(poly))
    if full <= 0: return 0.0
    inter, _ = cv2.intersectConvexConvex(poly, np.float32([[0, 0], [W, 0], [W, H], [0, H]]))
    return float(inter / full)


def path(t, rng_tremor):
    """Camera pose at time t (s). Phases: approach, still, pan, still, rotate, still, tilt+zoom, still, shake, still."""
    cam = {"x": WW / 2, "y": WH / 2, "h": 33.0, "tilt": 0.0, "pitch": 0.0, "roll": 0.0}
    k = smooth(t, 0.0, 1.4)                    # approach from lower right, higher up
    cam["x"] += 14 * (1 - k); cam["y"] += 18 * (1 - k); cam["h"] += 14 * (1 - k); cam["roll"] += 12 * (1 - k)
    p = smooth(t, 2.6, 3.4) - smooth(t, 3.6, 4.4)   # pan left and back
    cam["x"] += -6.0 * p; cam["y"] += 2.0 * p
    r = smooth(t, 5.2, 6.0) - smooth(t, 6.2, 6.9)   # roll the phone
    cam["roll"] += 14 * r
    z = smooth(t, 7.8, 8.6)                         # tilt and come closer
    cam["tilt"] += 16 * z - 8 * smooth(t, 8.8, 9.4); cam["h"] -= 5 * z; cam["y"] += 3 * z
    if 10.4 <= t <= 11.4:                           # shake
        u = (t - 10.4)
        cam["x"] += 1.6 * math.sin(u * 2 * math.pi * 3.1); cam["y"] += 1.2 * math.sin(u * 2 * math.pi * 2.3 + 1)
        cam["roll"] += 2.5 * math.sin(u * 2 * math.pi * 2.7)
    # hand tremor (always)
    tr = rng_tremor
    cam["x"] += tr["x"](t); cam["y"] += tr["y"](t); cam["roll"] += tr["r"](t); cam["tilt"] += tr["t"](t)
    return cam


def tremor(rng, strong=False):
    def make(amp, lo=1.5, hi=7):
        fs = rng.uniform(lo, hi, 5); ph = rng.uniform(0, 2 * math.pi, 5); am = rng.uniform(0.3, 1, 5)
        am = am / am.sum() * amp
        return lambda t: float(sum(a * math.sin(2 * math.pi * f * t + p) for a, f, p in zip(am, fs, ph)))
    if strong:   # a real hand: slow sway plus faster shake
        return {"x": make(0.18, 0.5, 9), "y": make(0.18, 0.5, 9), "r": make(0.35, 0.5, 9), "t": make(0.3, 0.5, 9), "p": make(0.3, 0.5, 9)}
    return {"x": make(0.08), "y": make(0.08), "r": make(0.15), "t": make(0.15), "p": lambda t: 0.0}


def phase_of(t, scene=""):
    spans = ([(0, 1.1), (2.45, 5.6), (6.45, 10.1)] if scene == "partial" else
             [(0, 1.3), (4.95, 5.7), (8.95, 10.6)] if scene == "realcam" else
             [(0, 1.2), (3.9, 5.7), (7.4, 8.7), (9.9, 11.2)] if scene in ("stack", "stack2", "spread") else
             [(0, 1.0), (2.9, 4.4), (6.4, 7.5), (8.2, 9.3), (9.9, 11.2)] if scene == "close" else
             [(0, 1.5), (2.55, 4.5), (5.15, 7.0), (7.75, 9.5), (10.35, 11.5)])
    for a, b in spans:
        if a <= t <= b: return "move"
    return "still"


def barcode(img, n):
    for i in range(16):
        v = 255 if (n >> i) & 1 else 0
        x0 = W - 16 * 12 + i * 12
        img[H - 14:H - 2, x0:x0 + 12] = v


def main():
    global W
    name, scene, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
    secs = float(sys.argv[4]) if len(sys.argv) > 4 else 12.5
    if len(sys.argv) > 5 and sys.argv[5] == "34": W = 1440    # a 4:3 camera (3:4 upright): the same height, wider
    rng = np.random.default_rng(seed)
    world, pc = build_world(scene, rng, seed)
    S = np.diag([1.0 / PXCM, 1.0 / PXCM, 1.0])       # world texture px -> cm
    tr = tremor(rng, strong=(scene in ("realcam", "stack", "stack2", "close", "spread")))
    n = int(round(secs * FPS))
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vign = (1 - 0.22 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2)[..., None]
    out = open(os.path.join(HERE, name + ".y4m"), "wb")
    out.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n".encode())
    frames = []
    prev = None
    for i in range(n):
        t = i / FPS
        Hm = homography((path_partial if scene == "partial" else path_hold if scene == "realcam" else path_close if scene in ("stack", "stack2", "spread") else path_near if scene == "close" else path)(t, tr))
        img = cv2.warpPerspective(world, Hm @ S, (W, H), flags=cv2.INTER_LINEAR, borderValue=(90, 90, 90))
        q = cv2.perspectiveTransform(np.float32(pc)[None], Hm)[0]
        # motion blur along the image motion of the page centre (shutter open ~half the frame time)
        c = q.mean(0)
        if prev is not None:
            v = c - prev
            L = float(np.hypot(*v)) * 0.5
            if L > 1.5:
                r = int(math.ceil(L))
                k = np.zeros((2 * r + 1, 2 * r + 1), np.float32)
                d = v / (np.hypot(*v) + 1e-9)
                for s in np.linspace(-L / 2, L / 2, max(3, int(L) * 2)):
                    k[int(round(r + s * d[1])), int(round(r + s * d[0]))] = 1
                img = cv2.filter2D(img, -1, k / k.sum())
        prev = c
        f = img.astype(np.float32) * vign
        if scene == "hand":
            # the phone's shadow over the bottom of the view
            f *= (1 - 0.32 / (1 + np.exp(-(yy - H * 0.78) / 40.0)))[..., None]
        if scene == "dim":
            f *= 0.55
        if scene in ("realcam", "stack", "stack2", "close", "spread"):
            # like a phone camera: the hand's soft shadow, exposure that breathes, focus that wanders,
            # sharpening, and noise that grows with brightness
            sx, sy = W * (0.15 + 0.05 * math.sin(t * 0.7)), H * (0.92 + 0.03 * math.sin(t * 0.5))
            f *= (1 - 0.28 * np.exp(-(((xx - sx) / (W * 0.35)) ** 2 + ((yy - sy) / (H * 0.18)) ** 2)))[..., None]
            f *= 1 + 0.03 * math.sin(2 * math.pi * 1.3 * t) + 0.015 * math.sin(2 * math.pi * 0.37 * t + 1)
            f = cv2.GaussianBlur(f, (0, 0), 0.8 + 0.3 * math.sin(t * 1.1) ** 2)
            f = f + 0.7 * (f - cv2.GaussianBlur(f, (0, 0), 1.4))
            f += rng.normal(0, 1, f.shape).astype(np.float32) * np.sqrt(4 + 0.1 * f.clip(0, 255))
        else:
            f = cv2.GaussianBlur(f, (0, 0), 0.7)
            f += rng.normal(0, 6.0 if scene == "dim" else 2.5, f.shape).astype(np.float32)
        f = f.clip(0, 255).astype(np.uint8)
        barcode(f, i)
        yuv = cv2.cvtColor(f, cv2.COLOR_BGR2YUV_I420)
        out.write(b"FRAME\n"); out.write(yuv.tobytes())
        frames.append({"q": [[float(x) / W, float(y) / H] for x, y in q], "phase": phase_of(t, scene), "vis": visible(q)})
        if i == int(1.8 * FPS) or i == int(8.9 * FPS):
            cv2.imwrite(os.path.join(HERE, f"{name}_f{i:03d}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 85])
    out.close()
    json.dump({"fps": FPS, "w": W, "h": H, "frames": frames}, open(os.path.join(HERE, name + ".json"), "w"))
    print(name, n, "frames")


if __name__ == "__main__":
    main()
