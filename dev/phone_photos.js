// Evaluated in the app's page on the phone (phone.py evalf): the open batch's captured photos, full size, as JPEG data
// URLs with the crop each got, for testing crops on the PC (save them under dev/videos/ only: they show John's
// documents). window.__photosFrom / __photosN pick which (default: the last 12).
(async () => {
  const b = window.__auditScan.S.batch;
  if (!b) return { error: "no open batch" };
  const pages = (await DB.pagesOf(b.id)).filter((p) => p.frame).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
  const from = window.__photosFrom || Math.max(0, pages.length - (window.__photosN || 12));
  const out = [];
  for (const p of pages.slice(from, from + (window.__photosN || 12))) {
    const url = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(p.frame); });
    out.push({ id: p.id, at: p.createdAt, pick: p.pick, quad: p.quad, w: p.frameW, h: p.frameH, jpg: url });
  }
  return out;
})()
