# Audit Scan test kit

Tools for testing the live outline and the capture crop on synthetic phone-camera videos with the true page corners
known for every frame. Nothing here is part of the app; the app never loads it. `scenarios.md` lists every scanning
situation, what the app should do in it, the rules the outline follows, the known limits and the results at the last
release.

Never put recordings or photos of John's real documents in this folder or anywhere in the repository (it's public).
Keep them in `dev/videos/` (ignored by git) or outside the repository.

## Setup

- Python 3.10+ with `pip install numpy opencv-python pillow onnxruntime playwright`, then `python -m playwright install chromium`
- Node.js 18+ (for `replay.js`)
- Disk: each test video is about 1.2 GB (1.6 GB for the 3:4 ones); the whole set about 18 GB.

```
python dev/make_videos.py              # the standard set (or name some: python dev/make_videos.py stack2_34 close)
```

This writes `dev/videos/<name>.y4m` (the camera video), `<name>.json` (true page corners, phase still/move, share of
the page in view, per frame) and `ai_<name>.json` (the app's AI page finder run on every frame, so replays don't need
it). The videos carry a frame-number barcode in the bottom-right corner.

## The replay suite (fast, exact, run it on every change)

`replay.js` runs a copy of `live-worker.js` in Node on a test video frame by frame, with the AI's answers arriving a
few frames late, and scores the outline against the truth. It's deterministic, so two copies of the worker can be
compared exactly. `replay_suite.py` runs every video in three conditions (clean AI; a busy phone dropping frames; a
less exact AI) for any number of copies and prints one table:

```
git show HEAD:live-worker.js > dev/runs/release.js          # the released copy, before changing anything
python dev/replay_suite.py release=dev/runs/release.js dev=live-worker.js --shown
```

`--shown` also scores the outline as the user sees it (the "sure enough to show" rule hides doubtful ones). Read the
column key at the top of `replay_suite.py`. A change is good when it doesn't make any row worse; look at the stack,
close and spread rows (the scenes like John's) and the fuzz condition (the AI as inexact as on real pages) first.

Looking closer: `node dev/replay.js live-worker.js stack2_34 --dump dev/runs/x.json` then
`python dev/drawrun.py stack2_34 dev/runs/x.png 15 dev/runs/x.json` draws the outline (blue; more runs in orange and
green) and the AI's answer (red) on every 15th frame. `--trace a-b` prints the tracker's decisions for frames a..b.

## The app in a browser

These start the app from a folder (`dev/serve.py` or `python -m http.server`) in Chromium with a test video as the
camera, at phone size.

| Tool | What it does |
|---|---|
| `suite.py <app folder> <tag> [videos]` | the live outline as drawn on screen, frame by frame against the truth (via `live_eval.py`); also frame rate, AI speed, errors |
| `capture_e2e.py <app folder> <port> <video> <t1,t2,..>` | taps the shutter at those seconds and scores each crop against the truth for the frame captured |
| `autocap.py <app folder> <port> <video> [secs]` | leaves Auto on and counts the pages captured, with the hints shown |
| `shot.py <app folder> <port> <video> <out prefix>` | screenshots of the camera screen (`--no-sync`: the video-view fallback; `--path canvas`: the slow-phone path) |
| `upgrade.py <old app folder> <new app folder>` | installs the old version, makes a batch, serves the new one at the same address and taps Update now |

For `upgrade.py`, check out the last release beside the repo: `git worktree add ../audit-scan-release <tag or commit>`.

## Release checklist

1. Replay suite: no row worse than the release (outline followed and as shown).
2. Browser suite on wood, stack2_34, close and spread: no errors, about 30 outline updates a second.
3. `capture_e2e.py` on stack2_34 and close; `autocap.py` on stack2_34; `shot.py` with and without `--no-sync`.
4. Bump `VERSION` in both `app.js` and `sw.js` (the same string), update the user-facing `README.md`.
5. `upgrade.py` from the last release to this one.
6. Commit, push to `main`, and check the Pages build:
   `gh api "repos/johnwin0102-collab/audit-scan/actions/runs?per_page=1" --jq '.workflow_runs[0] | "\(.head_sha[0:7]) \(.status) \(.conclusion)"'`
