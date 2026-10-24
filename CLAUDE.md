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

## Where things stand (1.3.3, 24 October 2026)

- John's feedback up to 1.3.2: the live outline was "not calm and stable" and "still not very nice", on stacks of
  stapled A4 pages on a patterned bedsheet, phone held close. 1.3.3 hasn't been tried by him yet at the time of
  writing: ask him what the footer says for the camera (expected "Camera: 3264×2448") and for a screen recording.
- 1.3.3: 4:3 camera; the outline shows only when the AI agrees with it, and fades in and out; on a stack it keeps to
  the top page; a page that overflows the view is outlined up to the view's edge with "Move back to fit the whole
  page"; the crop is the outline shown. Known limits and the numbers at release: `dev/scenarios.md`.

## Next: test on John's real phone

Everything so far was tuned on synthetic videos and two screen recordings, and the gap between those and his real
pages is the main reason results have disappointed him. With Claude Code on his Windows PC and the phone on USB:

1. Phone: Settings → About phone → tap Build number seven times; then in Developer options turn on USB debugging,
   plug the phone in and allow the PC when asked. He can turn USB debugging off afterwards.
2. PC: Android platform-tools (`winget install Google.PlatformTools`); `adb devices` should list the phone.
3. `adb forward tcp:9222 localabstract:chrome_devtools_remote`, then http://localhost:9222/json lists the pages open
   in Chrome on the phone (the installed app included), and Playwright's `chromium.connect_over_cdp("http://localhost:9222")`
   can drive them. `adb shell screenrecord` or scrcpy shows what he sees.
4. On the camera screen, `window.__auditScan.debugSlow(0, 0, true)` turns on the live worker's per-frame trace in
   `window.__auditScan.tracker.trace` (outline shown `q`, outline followed `tq`, frames each side has sat on an edge
   `ok`, the AI's answers and other events `ev`, the frame's timestamp `ts`).
5. Worth building first: a debug switch that has the live worker also post its 640 px grey frame (and the AI's
   224 px input) with each traced frame, so a session of John scanning his own stacks can be saved to `dev/videos/`
   (ignored by git) and replayed with `replay.js`: real-scene tests to check every change against.
