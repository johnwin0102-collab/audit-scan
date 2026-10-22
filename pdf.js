/* Audit Scan PDF writer: one JPEG per page, each page sized to its image
   (portrait A4 scans come out as 595 x 842 pt). */
"use strict";

const PDF = (() => {
  const enc = new TextEncoder();
  const LONG_SIDE = 841.89;   // A4 height in points

  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

  // PDF text string in UTF-16BE, so client names in any script survive.
  function text(s) {
    let h = "FEFF";
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp > 0xffff) {
        const v = cp - 0x10000;
        h += hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
      } else {
        h += hex4(cp);
      }
    }
    return "<" + h + ">";
  }

  function date(d) {
    const p = (n) => String(n).padStart(2, "0");
    const tz = -d.getTimezoneOffset();
    const a = Math.abs(tz);
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${tz >= 0 ? "+" : "-"}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
  }

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  // pages: [{ bytes: Uint8Array (JPEG), w, h }]
  function build(pages, meta = {}) {
    if (!pages.length) throw new Error("No pages to save");
    const chunks = [];
    const offsets = [];
    let size = 0;
    const push = (x) => {
      const b = typeof x === "string" ? enc.encode(x) : x;
      chunks.push(b);
      size += b.length;
    };
    const begin = (n) => { offsets[n] = size; push(`${n} 0 obj\n`); };

    push(Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)); // %PDF-1.4 + binary marker

    const pageObj = (i) => 4 + i * 3;
    const n = pages.length;

    begin(1); push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    begin(2);
    push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>\nendobj\n`);
    begin(3);
    const now = date(meta.date || new Date());
    push(`<< /Title ${text(meta.title || "Scan")} /Producer ${text("Audit Scan")} /Creator ${text("Audit Scan")} /CreationDate (${now}) /ModDate (${now}) >>\nendobj\n`);

    pages.forEach((pg, i) => {
      const long = Math.max(pg.w, pg.h);
      const W = (pg.w / long) * LONG_SIDE;
      const H = (pg.h / long) * LONG_SIDE;
      const po = pageObj(i), io = po + 1, co = po + 2;
      begin(po);
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(W)} ${fmt(H)}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);
      begin(io);
      push(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`);
      push(pg.bytes);
      push("\nendstream\nendobj\n");
      const content = `q ${fmt(W)} 0 0 ${fmt(H)} 0 0 cm /Im0 Do Q`;
      begin(co);
      push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream\nendobj\n`);
    });

    const total = 3 + n * 3;
    const xref = size;
    let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let k = 1; k <= total; k++) table += `${String(offsets[k]).padStart(10, "0")} 00000 n \n`;
    push(table);
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  return { build };
})();
