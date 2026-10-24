# Audit Scan: notes for Claude

## What this is

A phone scanner (a PWA, plain HTML/JS, no build step) for John's audit fieldwork in Malaysia. He scans documents at
clients' offices and saves each batch as one PDF to Google Drive (`Audit Inbox / <client folder>`). It's served by
GitHub Pages from `main` at https://johnwin0102-collab.github.io/audit-scan/ and installed from Chrome on his phone,
an Honor 90 (Android). `README.md` is the user-facing guide; `dev/` is the test kit (start with `dev/README.md` and
`dev/scenarios.md`).

## Working with John

- He's an accountant (audit and tax), not a software developer. Explain changes by what he'll see on the phone, in
  plain words and briefly. He tests on his phone; screen recordings from it are the best evidence of a problem.
- No Claude app or Claude login on his phone: he doesn't want it there in case the phone is stolen.
- Claude processes the scans in his Drive only when he asks.
- Privacy is part of the design: photos stay on the phone, there's no server, account or tracking, and nothing leaves
  the phone until he saves or shares a PDF. Keep it that way.
- This repository is public. Never commit his recordings, photos or anything showing his documents.

## How the app is built

| File | Role |
|---|---|
| `index.html`, `styles.css` | screens: setup, camera, review, page editor |
| `app.js` | the UI; the camera (asks for 4:3, 3264×2448, as the camera gives it; falls back to the 16:9 4K request); the live loop; automatic capture (outline steady for `HOLD_MS`, 2.5× longer when the page overflows the view); capture; batches (`db.js`, IndexedDB); PDF (`pdf.js`); sharing to Drive. `window.__auditScan` exposes state and `debugSlow()` for tests |
| `live-worker.js` | the live outline, every camera frame: reads the frame (copy or draw), shrinks it to a 640 px grey picture, snaps the outline to the paper's edges, follows the page, weighs the AI's answers, decides whether the outline is sure enough to show, and draws the camera picture with the outline itself (synced view). Its rules are written out in `dev/scenarios.md` |
| `ml-worker.js` | the AI page finder (DocCornerNet, `vendor/ml/`, 224×224 input), asked by the live worker and at capture |
| `cv-worker.js` | capture (OpenCV.js): picks the page outline (the outline shown is the crop when it sits on paper edges in the photo; otherwise the AI, its second looks at crops and a classical finder compete), crops with perspective and A4 correction (not for a page cut off by the view's edge), flattens (`flatten.js`), applies the scan modes, makes thumbnails |
| `sw.js` | offline cache. `VERSION` must equal the one in `app.js`; a new `sw.js` makes the app offer **Update now** |

## Releasing

Follow the release checklist in `dev/README.md`: replay suite against the released worker, browser checks, bump
`VERSION` in `app.js` and `sw.js`, update `README.md`, test the update path, commit as
`Audit Scan x.y.z: <what John will notice>`, push to `main`, check the Pages build. Then tell John to open the app and
tap **Update now**.

## Where things stand (1.3.3 released; branch `phone-tuning` not released, 24 October 2026)

- John's feedback up to 1.3.2: the live outline was "not calm and stable" and "still not very nice", on stacks of
  stapled A4 pages (a hand on them, phone held close). His reference is CamScanner (on his phone): no outline while the
  phone moves, a filled outline ~0.7 s after holding still, then it barely moves; clamped to the view for a page that
  overflows it; a generous crop (it took his thumb in rather than cutting the page).
- 24 Oct: tested on his real phone (Honor 90, Chrome 155, camera 2448×3264 portrait at ~27 fps; see "Testing on John's
  phone" below), seven recorded sessions. Found: his installed 1.3.3 was stuck in "video view" (outline drawn over the
  live video, trailing it) because the first seconds after the camera opens were slow; the AI is often badly off on his
  pages (7–40% of its answers are impossible shapes), so 1.3.3 shows the outline only 10–30% of the time ("page not
  found" while pointing at the page); outlines snapped to folds, printed lines and the hand holding a curled booklet,
  or got twisted, and crops cut strips off; the capture's second looks picked half pages.
- Branch `phone-tuning` (all dev-tested, not released): video view no longer sticks, quick start, frames handed over one
  ahead, faster blur; calm outline on screen; shape checks (no twisted or impossible outlines); outline shown when the
  AI's page covers the same area; pulls outward to the AI's side; crop widened where the AI sees more page; cut second
  looks handicapped. Replay suite: the outline followed is better than 1.3.3 in every condition, the outline shown about
  as good (better clean). On his recordings the outline is shown 2–3× as often.
- John's verdict on the branch (test copy): still weaker than CamScanner, which "knows what area I need". The limit is
  the AI page finder (DocCornerNet lean, 224 px): every rule around it second-guesses a weak answer. Next: a stronger
  on-device page finder (a better corner model, or page segmentation), judged offline on his recordings first.
- Per-frame cost on his phone ~30 ms (drawing the view 23%, shrinking the frame 35%, copying 10%; tracking 4%).

## Testing on John's phone

USB debugging is on and this PC is allowed ("Always allow"). Recording and replaying real sessions:
`dev/README.md`, "John's phone". The test copy is served from this PC at http://localhost:8000/ in Chrome on the phone
(its own storage, separate from the installed app); recordings stay in `dev/videos/rec_*` (gitignored). USB dropped a
couple of times when the cable moved: `adb devices` then shows "unauthorized" or "offline"; re-plugging and allowing
on the phone fixes it, and the adb forward/reverse must be set again (`phone.py connect`).
