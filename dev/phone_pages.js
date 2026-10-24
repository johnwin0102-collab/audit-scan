// Evaluated in the app's page on the phone (phone.py evalf): the open batch's last few captured pages as small JPEGs,
// each with its crop outline (green) drawn on the photo, for checking captures. window.__pagesN sets how many (6).
(async () => {
  const a = window.__auditScan, b = a.S.batch;
  if (!b) return { error: "no open batch" };
  const pages = (await DB.pagesOf(b.id)).filter((p) => p.frame).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  const out = [];
  for (const p of pages.slice(-(window.__pagesN || 6))) {
    const bm = await createImageBitmap(p.frame);
    const W = 480, H = Math.round((bm.height * W) / bm.width);
    const c = new OffscreenCanvas(W, H), g = c.getContext("2d");
    g.drawImage(bm, 0, 0, W, H);
    const q = p.quad;
    if (q) {
      // (the crop's corners: normalised, or in the photo's pixels)
      const k = q.every(([x, y]) => x <= 1.01 && y <= 1.01) ? [W, H] : [W / bm.width, H / bm.height];
      g.strokeStyle = "#0f0"; g.lineWidth = 2; g.beginPath();
      q.forEach(([x, y], i) => (i ? g.lineTo(x * k[0], y * k[1]) : g.moveTo(x * k[0], y * k[1])));
      g.closePath(); g.stroke();
    }
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    const url = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    out.push({ id: p.id, at: p.createdAt, auto: p.auto, pick: p.pick, quad: q, w: bm.width, h: bm.height, jpg: url });
  }
  return out;
})()
