// Evaluated in the app's page on the phone (phone.py eval -f): samples the camera screen's state every 250 ms for
// a while and returns the samples, to see when and why the app leaves the drawn ("in step") view or the VideoFrame
// path. usage: phone.py evalf dev/phone_watch.js  (the page must be on the camera screen; window.__watchSecs sets how long)
(async () => {
  const a = window.__auditScan, out = [], t0 = performance.now();
  const secs = window.__watchSecs || 20;
  while (performance.now() - t0 < secs * 1000) {
    const c = a.cam, t = a.tracker, s = a.stats;
    out.push({
      t: Math.round(performance.now() - t0), path: t.path, synced: c.synced, viewing: c.viewing, noSync: t.noSync, syncFails: t.syncFails,
      stalls: t.stalls, vfFails: t.vfFails, slow: c.rate && c.rate.slow, inFlight: c.inFlight, liveHz: +(s.liveHz || 0).toFixed(1),
      liveMs: +(s.liveMs || 0).toFixed(1), camHz: +(s.camHz || 0).toFixed(1), way: s.way, frame: a.live.frame, seq: t.seq,
    });
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
})()
