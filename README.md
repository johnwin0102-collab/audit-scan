# Audit Scan

A phone scanner for audit fieldwork. Scan documents at the client's office, and save each batch as one PDF into your Google Drive inbox (`Audit Inbox / client folder`). Claude picks the scans up from Drive when you ask it to process them.

**Open on your phone:** https://johnwin0102-collab.github.io/audit-scan/

## Install

1. Open the link above in Chrome on your Android phone.
2. Tap Chrome's **⋮** menu, then **Install app** (or **Add to Home screen**).
3. Open Audit Scan from your home screen. Allow the camera when asked.

When a new version is published, the app shows **Update now** at the top of the batch screen.

## Scan a batch

1. Enter the client (name as per SSM), FYE and audit area, then tap **Start scanning**.
2. Pick a scan mode on the strip above the shutter (Auto suits most documents).
3. Hold the phone over a page. The outline turns green and the page is captured automatically once it's steady. Turn to the next page and it captures again. The shutter button works any time. Tap **Undo** right after a capture to drop that page.
4. Tap **Done** to review. Tap **×** on a page to delete it, or tap the page to crop, flatten, rotate, retake, reorder or change its mode. **Use this mode on all pages** applies one mode to the whole batch. In **Crop**, **Detect** puts the corners on the best outline it finds; tap it again to step through other outlines.
5. Tap **Save PDF**, then **Save to Drive**. In the share list choose **Drive**, then **Audit Inbox** and the client's folder.

The file is named for you, for example `Client name - FYE 31.03.2026 - Bank - 23.10.2026 1042.pdf`.

## Scan modes

| Mode | Use it for |
|---|---|
| Auto | Picks Magic colour for pages with colour (stamps, logos), Grey for plain text |
| Original | The photo as taken, cropped and straightened |
| Lighten | A brighter, natural-looking copy of a dim photo |
| Magic colour | White paper, crisp text, vivid stamps and signatures |
| No shadow | Evens out shadows and uneven light, keeps natural colours |
| Grey | Clean greyscale with a white background |
| B&W | Pure black and white, smallest files |
| B&W 2 | Softer black and white that keeps faint marks and smooth edges |

## How page finding works

The live outline is found in two ways at once, both on the phone:

- **Edge snapping, every camera frame.** Each frame is shrunk to a 640 px greyscale picture, and each side of the outline is searched for the paper's edge nearby: a brightness step that holds at two scales, so a printed rule or a table column inside the page doesn't count, and that is the outermost such step, since the page's own edge lies outside everything printed on it. Each side is fitted with a straight line, or a gentle curve if the page isn't lying flat, and the corners are where the sides meet. This keeps the outline on the paper's edge while the phone moves, about 30 times a second, and it runs in its own worker so the camera preview stays smooth.
- **The AI page finder, several times a second.** An on-phone AI model (DocCornerNet, about 2 MB) finds the page in the first place, even on cluttered desks and light tables, and checks that the outline hasn't slid onto something else; if it has, the outline starts again from the AI's answer. When there are no edges to hold on to (white paper on a white desk), the outline simply follows the AI.

Between frames the outline is placed ahead by its recent motion and lightly smoothed, so it neither trails the page nor shakes. In tests with a moving phone, the outline stays within about 0.2% of the page's true corners when the phone is still and about 0.5% while it moves (version 1.2 trailed by about 2%).

When you capture, the AI also takes second looks at crops around its first outline. That separates a page from other papers it lies on or next to. The app keeps whichever outline best runs along real paper edges and has A4 proportions, then snaps each side onto the edge for a tight crop. If the AI sees no page, a classic edge finder has a go. The crop also restores the page's true proportions, and any page within about 20% of A4's shape comes out exactly A4 (receipts, cheques and cards keep their own shape).

The footer of the batch screen shows how the outline and the AI run on your phone (for example "Outline: 30 updates a second, 8 ms each (frame). AI: 3 cores, 30 ms a look, 8 a second.") and how long each page takes to process.

## Flattening

A page that isn't lying flat (curled at a corner, lifted at the top, bowed, held in the hand) still looks bent after cropping. Audit Scan flattens it automatically: it finds what must be straight on a flat page (text lines, table rules, column lines and the paper edges), works out a smooth correction that straightens them all, and re-samples the photo through it, refining over up to three passes. Pages that are already flat are left exactly as cropped.

In the page editor, **Flatten** is on by default; tap it to turn flattening off for that page (for example a page with deliberately curved artwork), and again to turn it back on. Flattening straightens lines and fills the frame with the page; it can't fully undo the squeeze where a page curls steeply away from the camera, so for best results hold the phone square over the page.

## Privacy

Photos stay on the phone, and the AI model and the flattening run on the phone too. Nothing is uploaded anywhere until you save or share a PDF yourself. There is no account, server or tracking in this app; GitHub only hosts the app's code. Saved batches stay on the phone until you delete them.

## Licences

- OpenCV.js 4.10.0, Apache License 2.0 (`vendor/opencv.js`, see `vendor/README.md`)
- DocCornerNet page-corner model (MIT, mapo80/DocCornerNet-CoordClass) and the minimal ONNX Runtime Web build from scanic / scanic-ml (MIT, marquaye/scanic; ONNX Runtime is MIT) in `vendor/ml/`
- Atkinson Hyperlegible, Barlow Condensed and IBM Plex Mono fonts, SIL Open Font License 1.1 (`fonts/LICENSE.txt`)
