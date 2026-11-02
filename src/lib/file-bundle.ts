import { crc32 } from "node:zlib";
import { PDFDocument } from "pdf-lib";

/**
 * Minimal ZIP writer (stored entries, no compression — PDFs and images are
 * already compressed). Enough for "Download All" without another dependency.
 */
export function zipFiles(entries: { name: string; bytes: Uint8Array }[]) {
  const enc = new TextEncoder();
  const used = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    // Unique, safe names inside the archive.
    let name = e.name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150) || "document";
    for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
    used.add(name.toLowerCase());
    const nameBytes = enc.encode(name);
    const crc = crc32(e.bytes) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, e.bytes.length, true);
    local.setUint32(22, e.bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, e.bytes);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.bytes.length, true);
    cd.setUint32(24, e.bytes.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + e.bytes.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

/** One printable PDF from PDFs and images, in order. Anything else is skipped and reported. */
export async function combinePrintable(entries: { name: string; mime: string; bytes: Uint8Array }[]) {
  const out = await PDFDocument.create();
  const skipped: string[] = [];
  for (const e of entries) {
    try {
      if (e.mime === "application/pdf") {
        const src = await PDFDocument.load(e.bytes, { ignoreEncryption: true });
        for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
      } else if (e.mime === "image/png" || e.mime === "image/jpeg") {
        const img = e.mime === "image/png" ? await out.embedPng(e.bytes) : await out.embedJpg(e.bytes);
        // Fit to US Letter with half-inch margins.
        const W = 612, H = 792, M = 36;
        const scale = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height, 1);
        const page = out.addPage([W, H]);
        page.drawImage(img, { x: (W - img.width * scale) / 2, y: (H - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
      } else skipped.push(e.name);
    } catch {
      skipped.push(e.name);
    }
  }
  return { bytes: out.getPageCount() ? await out.save() : null, skipped };
}
