# Audit Scan

A phone scanner for audit fieldwork. Scan documents at the client's office, and save each batch as one PDF into your Google Drive inbox (`Audit Inbox / client folder`). Claude picks the scans up from Drive when you ask it to process them.

**Open on your phone:** https://johnwin0102-collab.github.io/audit-scan/

## Install

1. Open the link above in Chrome on your Android phone.
2. Tap Chrome's **⋮** menu, then **Install app** (or **Add to Home screen**).
3. Open Audit Scan from your home screen. Allow the camera when asked.

## Scan a batch

1. Enter the client (name as per SSM), FYE and audit area, then tap **Start scanning**.
2. Hold the phone over a page. The outline turns green and the page is captured automatically once it's steady. Turn to the next page and it captures again. The shutter button works any time.
3. Tap **Done** to review. Tap a page to crop, rotate, reorder, delete or change its filter.
4. Tap **Save PDF**, then **Save to Drive**. In the share list choose **Drive**, then **Audit Inbox** and the client's folder.

The file is named for you, for example `Client name - FYE 31.03.2026 - Bank - 23.10.2026 1042.pdf`.

## What it does

- Finds the page edges live and captures automatically when the page is steady
- Straightens the page and restores its true proportions; near-A4 pages snap to exact A4
- Filters: **Enhanced** (removes shadows, keeps stamp and signature colours), **Original**, **Grey**, **B&W**
- Keeps the batch on the phone until you save it, so nothing is lost if the app closes
- Works offline once installed; saving to Drive needs a connection
- Saved batches stay listed for 14 days so you can send one again

## Privacy

Photos stay on the phone. Nothing is uploaded anywhere until you save or share a PDF yourself. There is no account, server or tracking in this app; GitHub only hosts the app's code.

## Licences

- OpenCV.js 4.10.0, Apache License 2.0 (`vendor/opencv.js`, see `vendor/README.md`)
- Atkinson Hyperlegible, Barlow Condensed and IBM Plex Mono fonts, SIL Open Font License 1.1 (`fonts/LICENSE.txt`)
