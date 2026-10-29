import "server-only";
import type { ScanStatus } from "@prisma/client";

/**
 * Malware scanning hook. Set MALWARE_SCAN_URL to an HTTP scanning service
 * (e.g. a ClamAV REST container or a cloud scanning API) that accepts the
 * raw file as the request body and answers {"clean": true|false}.
 * Without it, files are marked NOT_SCANNED and shown with a warning.
 */
export async function scanBytes(bytes: Uint8Array): Promise<ScanStatus> {
  const url = process.env.MALWARE_SCAN_URL;
  if (!url) return "NOT_SCANNED";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...(process.env.MALWARE_SCAN_TOKEN ? { Authorization: `Bearer ${process.env.MALWARE_SCAN_TOKEN}` } : {}) },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) return "PENDING";
    const json = (await res.json()) as { clean?: boolean };
    return json.clean === true ? "CLEAN" : json.clean === false ? "INFECTED" : "PENDING";
  } catch {
    return "PENDING";
  }
}

export function scanConfigured(): boolean {
  return Boolean(process.env.MALWARE_SCAN_URL);
}
