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

## John's phone: recording real scanning, replaying it

With the phone on USB (USB debugging on, this PC allowed; platform-tools from `winget install Google.PlatformTools`):

```
python dev/recserve.py . 8000          # serves this folder to the phone, saves recordings (keep it running)
python dev/phone.py connect 8000       # adb forward (DevTools) + adb reverse (the phone's localhost:8000 is this PC)
python dev/phone.py open               # opens http://localhost:8000/ in Chrome on the phone: a test copy, its own
                                       # storage, no service worker, every reload gets the files on disk now
python dev/phone.py rec s1             # once the camera is open: the live worker sends every frame to the PC
python dev/phone.py stop
```

`phone.py status`, `phone.py eval "<js>"`, `phone.py evalf dev/phone_watch.js` (how the camera screen runs, every 250
ms: frame path, view in step or video, speed) and `phone.py shot out.png` look at the phone; `phone_profile.py 6`
profiles the live worker there. A recording (`videos/rec_<name>/`, ignored by git: it shows John's documents) holds
each frame's grey picture (as the worker saw it, after the blur), the AI's picture when it was asked, the AI's
answers, the classical finder's, and what the worker made of each frame. The recording switch only works when the
app is served from this PC (`localhost`); the app installed from the web never sends anything.

```
python dev/recmotion.py s1                                   # the page's motion frame to frame (for the shake numbers)
node dev/replay_rec.js live-worker.js s1 --dump dev/runs/a.json   # what this worker would have shown on the phone
python dev/recview.py s1 dev/runs/a.png 100-400:20 --run dev/runs/a.json   # frames, outlines drawn on them
```

`replay_rec.js` feeds the recorded frames and answers to the worker exactly as they came on the phone; with the worker
the phone ran, it gives back what the phone showed (to sub-pixel rounding of the recorded grey). It prints the share
of frames with an outline shown, blinks, shake (how far the outline moves against the page from frame to frame while
shown, px of the 640 px picture) and jumps (> 1% of the diagonal in one frame). There is no truth on real pages (marking
the top page's corners by eye on John's stapled stacks wasn't reliable: the sheets overlap by millimetres), so look at
the frames where two workers differ with `recview.py` before believing a change. `rectruth.py` can hold corners marked
by eye where they are clear.

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
