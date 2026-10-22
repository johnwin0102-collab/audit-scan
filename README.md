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
4. Tap **Done** to review. Tap **×** on a page to delete it, or tap the page to crop, rotate, retake, reorder or change its mode. **Use this mode on all pages** applies one mode to the whole batch.
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

An on-phone AI model (DocCornerNet, about 2 MB) finds the four page corners in every camera frame, even on cluttered desks and light tables. When a page edge is clearly visible, the app then snaps each side onto it for a tight crop. If the AI sees no page, a classic edge finder has a go. The crop also restores the page's true proportions, and near-A4 pages snap to exact A4.

## Privacy

Photos stay on the phone, and the AI model runs on the phone too. Nothing is uploaded anywhere until you save or share a PDF yourself. There is no account, server or tracking in this app; GitHub only hosts the app's code. Saved batches stay on the phone until you delete them.

## Licences

- OpenCV.js 4.10.0, Apache License 2.0 (`vendor/opencv.js`, see `vendor/README.md`)
- DocCornerNet page-corner model (MIT, mapo80/DocCornerNet-CoordClass) and the minimal ONNX Runtime Web build from scanic / scanic-ml (MIT, marquaye/scanic; ONNX Runtime is MIT) in `vendor/ml/`
- Atkinson Hyperlegible, Barlow Condensed and IBM Plex Mono fonts, SIL Open Font License 1.1 (`fonts/LICENSE.txt`)
