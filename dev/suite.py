"""Run the live-outline test on every video for one app copy; print one table.
usage: suite.py <repo> <tag> [videos...] [--rate R] [--ml-ms M] [--tune JSON]"""
import json, os, subprocess, sys
DEV = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(DEV, "runs"), exist_ok=True)
args = sys.argv[1:]
repo, tag = args[0], args[1]
rest = args[2:]
opts = []
vids = []
i = 0
port = 8870
while i < len(rest):
    if rest[i] == "--port": port = int(rest[i + 1]); i += 2
    elif rest[i].startswith("--") and (i + 1 >= len(rest) or rest[i + 1].startswith("--")): opts.append(rest[i]); i += 1   # a flag
    elif rest[i].startswith("--"): opts += [rest[i], rest[i + 1]]; i += 2
    else: vids.append(rest[i]); i += 1
vids = vids or ["wood", "clutter", "light", "under", "curl", "hand", "partial", "dim", "realcam", "white"]
if "--rate" not in opts: opts += ["--rate", "2"]
if "--ml-ms" not in opts: opts += ["--ml-ms", "35"]
if "--live-ms" not in opts: opts += ["--live-ms", "16"]
rows = []
for k, v in enumerate(vids):
    # read the video once first, so the fake camera never waits for the disk
    with open(os.path.join(DEV, "videos", v + ".y4m"), "rb") as fh:
        while fh.read(1 << 24): pass
    out = subprocess.run([sys.executable, os.path.join(DEV, "live_eval.py"), repo, str(port + k), v, "--tag", tag, "--save", os.path.join(DEV, "runs", f"{tag.replace(' ', '_')}_{v}.json")] + opts, capture_output=True, text=True, timeout=900).stdout
    js = [l for l in out.splitlines() if l.startswith("JSON ")]
    if not js:
        print(v, "FAILED\n", out[-2000:]); continue
    d = json.loads(js[-1][5:])
    L = d["loops"].get("1") or d["loops"].get("0") or {}
    st, mv = L.get("still", {}), L.get("move", {})
    f = lambda x, n=2: "-" if x is None else f"{x:.{n}f}"
    pc = lambda x: "-" if x is None else f"{x * 100:.0f}%"
    print(f"{v:8s} {tag:10s} still {f(st.get('mean'))}%  move {f(mv.get('mean'))}% p90 {f(mv.get('p90'))}% >3% {pc(mv.get('gt3'))}  jitter {f(L.get('jitter'))}px jumps {L.get('jumps')}  gone-shown {pc(L.get('gone_shown'))}  first {L.get('first')}/{L.get('first_in')}  ups {d['stats'].get('liveHz') or d['stats'].get('lookHz') or 0:.0f} ai {d['stats'].get('mlMs', 0):.0f}ms  err {len(d['errors'])}", flush=True)
