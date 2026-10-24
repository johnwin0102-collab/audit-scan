"""Replays every test video through one or more copies of live-worker.js (replay.js), several at a time, and prints
one table: each video and AI condition a row, each worker copy a block of columns.

usage: replay_suite.py NAME=worker.js [NAME=worker.js ...] [--videos a,b,c] [--configs clean,drop,fuzz] [--shown] [-j N]
                       [-- extra replay.js options]
  NAME=path   a copy of live-worker.js, e.g. release=runs/release.js dev=../live-worker.js
              (get the released one with: git show HEAD:live-worker.js > dev/runs/release.js)
  --shown     also score the outline as shown (after the "sure enough to show" rule): adds a NAME+ block
  --configs   clean: the real AI's answers, 2 frames late; drop: 3 frames late and a quarter of the frames dropped
              (a busy phone); fuzz: a less exact AI (2.5% steady offset, 1% scatter, 5% wild answers)

Columns: still / move = mean corner error (% of the diagonal) while the phone is held still / moving; >3 = share of
moving frames more than 3% off; fail = share of moving frames more than 2% off; jit = frame-to-frame shake against
the page while still (px); jp = jumps; rs = restarts; fnd = share of moving frames with an outline; gone = share of
frames with the page gone where an outline was still drawn.
"""
import os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

DEV = os.path.dirname(os.path.abspath(__file__))
CONFIGS = {
    "clean": ["--ai-delay", "2"],
    "drop": ["--ai-delay", "3", "--drop", "0.25", "--seed", "3"],
    "fuzz": ["--ai-delay", "3", "--ai-bias", "2.5", "--ai-noise", "1", "--ai-outlier", "0.05"],
}
args = sys.argv[1:]
extra = []
if "--" in args:
    i = args.index("--"); extra = args[i + 1:]; args = args[:i]
workers, videos, configs, shown, jobs = [], None, list(CONFIGS), False, os.cpu_count() or 2
i = 0
while i < len(args):
    a = args[i]
    if a == "--videos": videos = args[i + 1].split(","); i += 2
    elif a == "--configs": configs = args[i + 1].split(","); i += 2
    elif a == "--shown": shown = True; i += 1
    elif a == "-j": jobs = int(args[i + 1]); i += 2
    elif "=" in a: n, p = a.split("=", 1); workers.append((n, os.path.abspath(p))); i += 1
    else: sys.exit("don't know " + a)
if not workers: sys.exit(__doc__)
if videos is None:
    vd = os.path.join(DEV, "videos")
    videos = sorted(f[3:-5] for f in os.listdir(vd) if f.startswith("ai_") and f.endswith(".json"))

runs = []
for v in videos:
    for c in configs:
        for n, p in workers:
            runs.append((n, p, v, c, False))
            if shown: runs.append((n + "+", p, v, c, True))


def one(r):
    n, p, v, c, sh = r
    cmd = ["node", os.path.join(DEV, "replay.js"), p, v, "--quiet"] + CONFIGS[c] + (["--shown"] if sh else []) + extra
    out = subprocess.run(cmd, capture_output=True, text=True).stdout.strip().splitlines()
    return r, (out[-1] if out else "")


res = {}
with ThreadPoolExecutor(jobs) as ex:
    for (n, p, v, c, sh), line in ex.map(one, runs):
        g = lambda pat: (re.search(pat, line) or [None, "-"])[1]
        res[(v, c, n)] = dict(still=g(r"still ([\d.]+)%"), move=g(r"move ([\d.]+)%"), gt3=g(r">3% (\d+)%"),
                               fnd=g(r">3% \d+% \(found (\d+)%"), fail=g(r"fails ([\d.]+)%"), jit=g(r"jitter ([\d.]+)px"),
                               jp=g(r"jumps (\d+)"), rs=g(r"restarts (\d+)"), gone=g(r"gone-shown (\S+)"))
names = []
for n, _ in workers:
    names.append(n)
    if shown: names.append(n + "+")
cell = lambda d: f"{d['still']:>5} {d['move']:>5} {d['gt3']:>3} {d['fail']:>5} {d['jit']:>5} {d['jp']:>3} {d['rs']:>2} {d['fnd']:>3} {d['gone']:>4}"
print(f"{'video':10} {'cfg':5} " + " | ".join(f"{n:^43}" for n in names))
print(" " * 17 + " | ".join(f"{'still':>5} {'move':>5} {'>3':>3} {'fail':>5} {'jit':>5} {'jp':>3} {'rs':>2} {'fnd':>3} {'gone':>4}" for _ in names))
for v in videos:
    for c in configs:
        print(f"{v:10} {c:5} " + " | ".join(cell(res[(v, c, n)]) for n in names))
# one line per copy: mean share of moving frames more than 2% off, per condition
print()
for n in names:
    parts = []
    for c in configs:
        xs = [float(res[(v, c, n)]["fail"]) for v in videos if res[(v, c, n)]["fail"] != "-"]
        parts.append(f"{c} {sum(xs) / max(1, len(xs)):.1f}%")
    print(f"{n:10} frames >2% off while moving, mean over videos: " + ", ".join(parts))
