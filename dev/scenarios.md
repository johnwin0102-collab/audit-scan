# Audit Scan: every scanning situation, what should happen, and how it's tested

Aim: the capture is the page as it shows in front of you — the outline on screen is where the crop will be, and the crop
is that outline. CamScanner is the reference: 3:4 view, outline only when sure, outline clamped to the view for a
page that overflows it, crop = outline.

Legend: LIVE = live outline on the camera screen; CAP = crop on capture; Test = the test video (see make_videos.py)
or test that covers it.

| # | Situation | LIVE | CAP | Test |
|---|---|---|---|---|
| 1 | Page on a contrasting desk, fully in view | tight outline within ~0.1% | tight, A4 | wood, dim, light, realcam |
| 2 | White page on a white/light desk (no edges) | follows AI, glides, shake < 3 px | AI refined | white |
| 3 | Page on a stack of pages (sheets peek 0.5–3%) | on the TOP page, never the sheets below | top page | stack (large offsets), **stack2** (small offsets, like John's) |
| 4 | Printed boxes / tables / black blocks on the page | never on a printed line | never | guide doc in stack2, under |
| 5 | Page overflows the view (held close; top/bottom cut) | shown, clamped to the view edge; hint "Move back…"; auto-capture waits | crop the visible part; NOT stretched to A4 | **close** (new), partial |
| 6 | Page small / far away | outline; auto waits for steadiness | fine | wood start (page small at first) |
| 7 | Hand-held page, fingers on it, curled | outline around the page | flattened | hand, curl |
| 8 | Booklet / open file: two pages, next page lifted | the page the AI picks (facing page) | that page | **spread** (new) |
| 9 | Patterned background (floral bed) | AI anchors; edges only near the AI's outline | same | stack2 (bedsheet), clutter |
| 10 | Shadow of phone/hand across the page | not fooled | no-shadow filter | dim, hand |
| 11 | Low light / noise | thresholds hold | fine | dim |
| 12 | Moving between pages | follows; on a new page re-seats within ~0.4 s; hidden while the AI sees none | n/a | all "move" phases |
| 13 | Slow phone (dropped frames, slow AI) | no false outlines; recovers | n/a | drop/stall/step runs |
| 14 | Nothing in view (bed only) | no outline, "Point the camera at a page" | n/a | gone phases, partial |
| 15 | Page more than half out of view | no outline | n/a | partial |
| 16 | Receipt / card / cheque | outline; shape kept | shape kept | (shape logic unchanged) |
| 17 | Dark or coloured page | edge polarity both ways | fine | (not covered yet) |
| 18 | AI a little off (1–3%) every answer (its usual error) | outline stays on the edges; shown | edges win | fuzz runs (bias 2.5%, noise 1%) |
| 19 | AI wildly off now and then (5% of answers) | ignored | ignored | fuzz runs (outliers) |
| 20 | AI insists the page is elsewhere (3 answers, consistent) | outline goes there even without edges there, then re-snaps (R=22) | - | stack2 (box vs page), clutter |
| 21 | Page turned while the outline is shown | old outline hidden after 2 misses / far answers; new one after 2 agreeing answers | - | stack, wood (page swaps) |
| 22 | Capture while the outline is shown | crop = the outline shown (refined ≤1.5% at full res) | WYSIWYG | **capture e2e** (new) |
| 23 | Capture with no outline (manual shutter, nothing sure) | - | AI + classical as before | import test |
| 24 | 16:9-only camera | 4:3 request falls back to 4K 16:9 | - | shot test (fake camera is 9:16) |

## Rules the live outline follows (1.3.3)

- Edges: a brightness step that holds at two scales (narrow 2 px, wide 8 px beyond a 3 px gap), with blank paper on
  its inside (standard deviation over the wide inner window ≤ 10 grey levels: text columns and printed boxes fail
  this), and the brighter side inside unless the other polarity fits 4+ more points (black blocks fail this).
- Pick: each side takes the clear edge nearest where it was (weight v / (1 + (d/σ)²), σ = R/2.5, R = 12 px normally,
  22 after a jump, growing with motion), ×2.5 for an edge a little inside (sheets peeking out beyond the page). A side
  that has sat on its edge for 5+ frames keeps sharply to it (σ = 3) unless the outline is moving fast.
- AI agreement: answer within 1.2% (2.5% with 4 edges) of the outline → agrees. Further → proposal: next frame snaps
  the AI's outline (R = 22) and switches if (a) the outline has < 2 edges and the AI's has ≥ 2; (b) the AI has said
  twice running (consistent within 1.5%) that the page is > 3.5% away and there are ≥ 3 edges along its outline;
  (c) three times running > 3.5% away, edges or not; (d) the AI's outline sits clearly better on edges (score + 0.4)
  or around the current one — except when it's only a sliver bigger (< 15% more area) and the current one sits on
  3+ edges (see Around). After a switch R = 22 for 2–3 frames.
- Around: an outline that sits on 3+ edges isn't given up for one only a sliver bigger (< 15% more area) — that's the
  sheets under the page — unless one of its sides lies on a printed line (a dark line with the same paper either
  side: `onPrintedLine`), in which case the page around it wins.
- Pulls (`notePulls`): when the AI twice running puts one side inside where it sits (at least 4 px at both ends and
  8 px at one, at most 40 px, consistent within half the offset + 6 px), that side is tried on the edge where the AI
  puts it (R = 10) and moves there if there's a clear edge. A side on no edge is pulled outward the same way. This
  takes the outline off a sheet peeking out from under the page without touching the other sides.
- Shown: AI agreed lately (< 1.2 s), not 2 misses, not 2 far answers; a new outline waits for a second agreeing answer
  or ≥ 3 edges. A page that overflows the view is shown clamped (cut flag → hint "Move back…", auto-capture after a
  2.5× longer hold). Distances between AI and outline are measured with both clamped to the view.
- Calm (1.3.4, `calmView`): the outline drawn is the followed outline, except when that goes somewhere the page didn't
  (judged against the print inside the drawn outline, `pageMotion`, sampled on a 6 x 6 grid in the part of the page in
  view): then the drawn outline stays with the page until the followed one is back with it or has stayed at its new
  place for 2 frames (at most 15), and glides there at most 6 px a frame (at least 20% of the way). A change of 6%+ of
  the diagonal towards the AI's last page-shaped answer is the page being found: glided to quickly, not held. A followed
  outline with fewer than 2 sides on edges (a guess from the AI's answers) is drifted to slowly (15% a frame; 50% with 2
  sides) unless more than 3 x 1.2% of the diagonal away.
- Shapes (1.3.4, `shapedPx`): an outline of our own with a corner under 60° or over 120°, or opposite sides more than
  25° off parallel: a snap like that is refused, a followed outline like that for 8 frames running is dropped (found
  afresh from the next AI answer; one stayed twisted for seconds while John turned a page in his hand), and one is
  never shown. The AI's answers get 50–130° and 30° (corners beyond the view pinned to its edge bend them); an answer
  outside that says nothing to the show rule.
- Shown (1.3.4): as before, or, when the AI's page and the outline cover about the same part of the view (the parts in
  view overlap 85%+, `overlapInView`), even with corners further apart; "well away" also needs the overlap under 75%.
  On John's recordings the outline is shown 2-3x as often as in 1.3.3.
- Crop (1.3.4, `widened`, message field `crop`): with the phone about still, a corner of the AI's last page-shaped answer
  more than 3% of the diagonal outside the outline shown is taken for the crop (not for the outline on screen: there it
  switched with each answer and the outline jumped). Outward pulls (`OUT_PULL`, the AI twice running putting a side 4%+
  further out) are written but off: they made the outline jumpier on John's recordings. At capture, a second look at a
  crop with part of the first outline cut away (`cut_*`) competes with a 0.4 handicap (it picked half pages).
- Not taken up (1.3.4): ignoring the AI's odd-shaped answers altogether (`SHAPED`, hid good outlines too); the dark
  band rule (`bandBeyond`, `BAND`: an edge with a dark stretch and paper beyond it, for fingers and printed bands; on
  only where the AI puts a side further out, and then it changed nothing measurable).
- Capture: the outline shown is the crop (refined on edges in the photo) when it really sits on 3+ edges there;
  otherwise AI, second looks and the classical finder compete. A cut-off page is cropped as it is (no perspective
  correction, no A4 snap, no flattening).

## Known limits (1.3.4)

- John's real pages (stapled booklets, curled at the binding, held in the hand, sheets underneath): the AI page finder
  is often several per cent off and 7-40% of its answers are impossible shapes; the outline is still hidden 30-60% of
  the time there and crops can still miss a strip. CamScanner does clearly better. SlimSAM at capture fixed crops of
  pages on the desk but not of hand-held ones and takes ~8 s a page on his phone (experiment: `dev/sam-worker.js`).

## Known limits (1.3.3)

- A page on a bigger sheet that peeks out 1–1.5 cm on two sides (test "under"): the AI itself takes the bigger sheet
  (its error 2.5%), so the outline sits on it too (2.85% off). Nothing points inward, so no pull.
- A stack whose sheets peek out by several cm with large random offsets, page overflowing the view (test "stack"):
  ~1.4% off.
- A page held so close it fills the view with no desk around it: the AI gives up or puts the page at the view's
  edges, so the outline stays hidden; the crop then comes from the photo alone (AI + classical), about 7.5% off on "close" at 1.6 s and 2.6 s.
- Moving phases while a page comes back into view can be 1–2% off for a few frames before the sides settle.
- In the browser test (live_eval.py) a run of frames can show errors equal to one frame's motion: the harness has
  matched the outline to the wrong frame number. Check the outline against the neighbouring frames (it matched the
  next frame exactly in every case seen) before believing a regression there.
- Unused leftover in live-worker.js track(): `const within` (an inward-switch rule that was tried and dropped).

## Results when 1.3.4 was released (same replay suite, outline as shown; fail = moving frames > 2% off)

Mean over videos: 1.3.3 clean 7.9 / drop 8.5 / fuzz 5.5%, 1.3.4 9.1 / 8.2 / 8.0% (outline followed: 1.3.3 9.3 / 9.6 /
8.3%, 1.3.4 9.3 / 8.0 / 6.6%). 1.3.4 shows the outline more (the overlap rule) and in the stack scenes more of the extra
frames sit on the sheet under the page while the phone moves; still, both are within ~0.2-0.3%. That was taken for
John's real pages, where 1.3.3 hid the outline most of the time (on his recordings 1.3.4 shows it 2-3x as often and is
about as calm or calmer per frame; `replay_rec.js` against `rec_s3`..`rec_s7`). Single runs of one video can swing a
few points either way on small changes (the outline locks on a frame earlier or later): compare means.

| Video | 1.3.3 shown fail (clean / drop / fuzz) | 1.3.4 | 1.3.3 shown share | 1.3.4 |
|---|---|---|---|---|
| stack2 | 5 / 0 / 12% | 11 / 6 / 22% | 87 / 91 / 87% | 100 / 100 / 100% |
| stack2_34 | 0 / 2 / 0% | 0 / 6 / 0% | 97 / 94 / 96% | 97 / 94 / 96% |
| close | 12 / 16 / 13% | 12 / 11 / 12% | 100 / 100 / 100% | 100 / 100 / 100% |
| spread | 0 / 2 / 0% | 0 / 7 / 0% | 97 / 93 / 97% | 97 / 95 / 97% |
| clutter | 1 / 5 / 1% | 5 / 0 / 9% | 100 / 100 / 99% | 100 / 100 / 100% |
| dim | 9 / 0 / 8% | 11 / 4 / 20% | 100 / 97 / 100% | 100 / 100 / 100% |
| curl | 0 / 0 / 0% | 1 / 5 / 0% | 100 / 100 / 100% | 100 / 100 / 100% |
| white | 0 / 10 / 13% | 0 / 0 / 14% | 97 / 100 / 71% | 100 / 100 / 100% |
| realcam | 0 / 3 / 9% | 2 / 0 / 11% | 94 / 100 / 93% | 98 / 91 / 93% |
| under | 91 / 81 / 16% | 91 / 78 / 16% | 93 / 96 / 100% | 100 / 96 / 100% |

## Results when 1.3.3 was released (replay suite, outline as shown; fail = moving frames > 2% off)

| Video | 1.3.1 | 1.3.2 | 1.3.3 |
|---|---|---|---|
| stack2 (clean / drop / fuzz) | 89 / 91 / 85% | 8 / 3 / 35% | 0 / 3 / 0% |
| stack2_34 | 92 / 97 / 94% | 37 / 55 / 50% | 0 / 2 / 3% |
| close | 51 / 50 / 60% | 3 / 5 / 3% | 4 / 5 / 12% |
| spread | 51 / 48 / 58% | 0 / 11 / 0% | 0 / 2 / 0% |
| wood, clutter, light, curl, hand, dim, white | 0–6% | 0% | 0–2% |
| realcam | 2 / 3 / 5% | 0 / 0 / 1% | 3 / 0 / 1% |
| under (known limit) | ~90% | ~82% | ~74–81% |

Mean corner error on stack2_34 while still: 1.3.1 2.4%, 1.3.2 1.8%, 1.3.3 0.2%. (These numbers come from videos made
with an earlier version of genvid.py; make_videos.py's set is close but not identical, so compare versions within one
run of replay_suite.py, never against this table.)

