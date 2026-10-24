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
3. Hold the phone over a page. The outline appears once the app is sure of the page, turns green, and the page is captured automatically once it's steady. Turn to the next page and it captures again. The shutter button works any time, and the crop is the outline you see. Tap **Undo** right after a capture to drop that page.
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

- **Edge snapping, every camera frame.** Each frame is shrunk to a 640 px greyscale picture, and each side of the outline is searched for the paper's edge nearby: a brightness step that holds at two scales (so a printed rule doesn't count), with blank paper on its inside (so the edge of a text column or a printed box doesn't count either) and, as a rule, the brighter side inside (paper is brighter than what's around it; a black block's edge is the other way round). Of the steps within reach, a side takes the clear one nearest where it was, leaning to one a little inside: on a stack, the sheets underneath peek out beyond the page, and the page's own edge is the inner one (up to version 1.3.1 the outermost step was taken, which on a stack was often a sheet below). Each side is fitted with a straight line, or a gentle curve if the page isn't lying flat, and the corners are where the sides meet. This keeps the outline on the paper's edge while the phone moves, about 30 times a second, and it runs in its own worker so the camera preview stays smooth.
- **Which edges are the page's.** When the AI keeps putting one side of the outline a little inside where it sits, that side is tried on the edge where the AI puts it and moves there if there's a clear edge: this takes the outline off a sheet peeking out from under the page without disturbing the other sides. An outline that sits on paper edges isn't given up for one only a sliver bigger all round (that's the sheets under the page), but it is for the page around a side that lies on a printed line. On a test stack like the ones John scans (a stapled document's pages peeking out a few millimetres to a centimetre under the page, with boxes and black blocks on it, the phone held close), the outline was about 0.2% off the top page's corners in version 1.3.3, against about 2% in 1.3.1 and 1.3.2, with far fewer jumps.
- **The AI page finder, several times a second.** An on-phone AI model (DocCornerNet, about 2 MB) finds the page in the first place, even on cluttered desks and light tables, and checks that the outline hasn't slid onto something else. When the AI sees the page somewhere else, the next frame tries the AI's outline against the paper's edges and keeps whichever sits on them better, so an AI answer that's a little off doesn't tug the outline to and fro. When the AI says twice running that the page is well away from the outline (further than it is usually off) and there are paper edges along its outline, the outline goes there: on a stack of sheets, or a page with boxes printed on it, the AI tells which edges are the page's.
- **The print on the page, when there are no edges.** On a white desk or a stack of white paper, where the paper's edge barely shows, small patches of print inside the outline are found again in each new frame, and the outline moves exactly as they moved. It then glides gently towards the AI's outline instead of jumping to each answer (the AI's answers scatter a little from look to look). In tests without any paper edges, this cut the outline's frame-to-frame shake from about 7–15 px to about 2–3 px.

**The outline is drawn together with the camera picture.** The same worker draws each camera frame on screen with the outline found in that very frame, so the outline stays glued to the page as you see it, even while your hand shakes. (Up to version 1.3 the outline was drawn over the live video and trailed it by a frame or two, which made it look jittery in a hand-held phone.) In tests with a shaky hand-held video, the outline now moves against the page by well under 1 px from one frame to the next (about 9 px in version 1.3), and on a flat page it stays within about 0.1% of the page's true corners. If a phone can't draw the camera picture quickly enough, the app shows the camera video as before, with the outline over it.

**The outline is shown only when the app is sure of it**, as in CamScanner. It appears while the AI agrees that the page is there: about where the outline is (the AI's corners can be a few per cent off), or on the same paper edges. A new outline waits for the AI's second look, or for the paper's edges along it. It is hidden while the AI sees no page or keeps seeing it well away from the outline. Once shown, it stays until the AI says otherwise twice running, and it fades in and out instead of blinking. Meanwhile the outline is still followed, so it's back as soon as it's confirmed, and the automatic capture waits for it. A page that overflows the view is outlined up to the view's edge, with the hint **Move back to fit the whole page**; it's still captured automatically after a longer hold, and the shutter works any time.

**The crop is the outline you see.** When you capture while the outline is shown, that outline is the crop, refined onto the paper's edges in the full-size photo; another outline replaces it only when it's the same page sitting clearly better on the edges. Without an outline on screen (the shutter tapped as the phone moved, say), the AI's outline, its second looks at crops and the classical edge finder compete as before. A page that overflows the view is cropped as it is, not stretched to A4. In tests with a less exact AI and with dropped frames, the outline shown was more than 2% off the page in at most 0.1% of frames, against 2–3% in version 1.3.1; with the whole page in view, it was shown in nearly every frame while the phone was held still and in about 95% while it moved.

**The camera runs in 4:3**, the shape of its sensor (CamScanner uses it too). The view then takes in a third more of the desk across than the 16:9 picture used before, so there's room around an A4 page, and the picture has about as many pixels as 4K. A phone that can't give a sharp 4:3 picture at full speed keeps to 16:9.

When you capture, the AI also takes second looks at crops around its first outline. That separates a page from other papers it lies on or next to. The app keeps whichever outline best runs along real paper edges and has A4 proportions, then snaps each side onto the edge for a tight crop. If the AI sees no page, a classic edge finder has a go. The crop also restores the page's true proportions, and any page within about 20% of A4's shape comes out exactly A4 (receipts, cheques and cards keep their own shape).

The footer of the batch screen shows how the camera, the outline and the AI run on your phone (for example "Camera: 3264×2448, 30 frames a second. Outline: 30 updates a second, 9 ms each (copy, view in step). AI: 3 cores, 30 ms a look, 8 a second.") and how long each page takes to process. "View in step" means the camera picture and the outline are drawn together; "video view" means this phone shows the camera video with the outline over it.

## Flattening

A page that isn't lying flat (curled at a corner, lifted at the top, bowed, held in the hand) still looks bent after cropping. Audit Scan flattens it automatically: it finds what must be straight on a flat page (text lines, table rules, column lines and the paper edges), works out a smooth correction that straightens them all, and re-samples the photo through it, refining over up to three passes. Pages that are already flat are left exactly as cropped.

In the page editor, **Flatten** is on by default; tap it to turn flattening off for that page (for example a page with deliberately curved artwork), and again to turn it back on. Flattening straightens lines and fills the frame with the page; it can't fully undo the squeeze where a page curls steeply away from the camera, so for best results hold the phone square over the page.

## Privacy

Photos stay on the phone, and the AI model and the flattening run on the phone too. Nothing is uploaded anywhere until you save or share a PDF yourself. There is no account, server or tracking in this app; GitHub only hosts the app's code. Saved batches stay on the phone until you delete them.

## Licences

- OpenCV.js 4.10.0, Apache License 2.0 (`vendor/opencv.js`, see `vendor/README.md`)
- DocCornerNet page-corner model (MIT, mapo80/DocCornerNet-CoordClass) and the minimal ONNX Runtime Web build from scanic / scanic-ml (MIT, marquaye/scanic; ONNX Runtime is MIT) in `vendor/ml/`
- Atkinson Hyperlegible, Barlow Condensed and IBM Plex Mono fonts, SIL Open Font License 1.1 (`fonts/LICENSE.txt`)
