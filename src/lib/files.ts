// Upload validation by file signature, not by the name or browser-supplied type.

// Netlify Functions accept request bodies up to about 6 MB, so uploads that
// pass through the app are capped just under that. Larger videos need direct
// uploads to external storage (planned with direct social publishing).
export const MAX_UPLOAD_BYTES = Math.floor(5.5 * 1024 * 1024);
export const MAX_UPLOAD_LABEL = "5 MB";
// Most US carriers reliably deliver MMS images up to about 600 KB–1 MB.
export const MMS_SAFE_BYTES = 600 * 1024;

export type SniffedType =
  | { mime: "image/png"; ext: "png" }
  | { mime: "image/jpeg"; ext: "jpg" }
  | { mime: "application/pdf"; ext: "pdf" }
  | { mime: "video/mp4"; ext: "mp4" }
  | { mime: "video/quicktime"; ext: "mov" };

/** Video is only accepted into the marketing media library, never client documents. */
export function sniffType(bytes: Uint8Array, opts: { allowVideo?: boolean } = {}): SniffedType | null {
  if (opts.allowVideo && bytes.length > 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    return brand === "qt  " ? { mime: "video/quicktime", ext: "mov" } : { mime: "video/mp4", ext: "mp4" };
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  return null;
}

export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = view.getUint16(i + 2);
      // SOF0–SOF15, excluding DHT/JPG/DAC markers.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
