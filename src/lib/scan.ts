import "server-only";
import type { ScanStatus } from "@prisma/client";

/**
 * Malware scanning. Files stay quarantined (no download, not shown to
 * clients) until a configured scanner returns CLEAN.
 *
 * MALWARE_SCAN_PROVIDER:
 *  - "clamav-rest": your own ClamAV REST service (files stay in your control).
 *      MALWARE_SCAN_URL = full scan endpoint, MALWARE_SCAN_FIELD = multipart
 *      field name (default "FILES"), optional MALWARE_SCAN_TOKEN (Bearer).
 *  - "cloudmersive": Cloudmersive Virus Scan API. CLOUDMERSIVE_API_KEY
 *      (MALWARE_SCAN_URL optional, defaults to the scan-file endpoint).
 *  - "generic": raw bytes POSTed to MALWARE_SCAN_URL, answer {"clean": true|false}.
 * Use the Admin self-test (EICAR test string) to prove the setup works.
 */
export type ScanProvider = "clamav-rest" | "cloudmersive" | "generic";

export function scanProvider(): ScanProvider | null {
  const p = process.env.MALWARE_SCAN_PROVIDER;
  if (p === "cloudmersive") return process.env.CLOUDMERSIVE_API_KEY ? "cloudmersive" : null;
  if (!process.env.MALWARE_SCAN_URL) return null;
  return p === "clamav-rest" ? "clamav-rest" : "generic";
}

export function scanConfigured(): boolean {
  return scanProvider() !== null;
}

/** Reads the common answer shapes of ClamAV REST wrappers and scan APIs. */
export function interpretScanResponse(json: unknown): ScanStatus {
  const seen: ScanStatus[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (key === "is_infected" || key === "infected") seen.push(val === true ? "INFECTED" : val === false ? "CLEAN" : "PENDING");
      else if (key === "clean" || key === "cleanresult") seen.push(val === true ? "CLEAN" : val === false ? "INFECTED" : "PENDING");
      else if (key === "status" && typeof val === "string") seen.push(/^(ok|clean)$/i.test(val) ? "CLEAN" : /found|infected/i.test(val) ? "INFECTED" : "PENDING");
      else if (typeof val === "object") walk(val);
    }
  };
  walk(json);
  if (seen.includes("INFECTED")) return "INFECTED";
  if (seen.length && seen.every((s) => s === "CLEAN")) return "CLEAN";
  return "PENDING";
}

export type ScanResult = { status: ScanStatus; detail: string | null };

/** Scans bytes and says why a scan didn't finish (for the status shown beside each upload). */
export async function scanBytesDetailed(bytes: Uint8Array, filename = "upload.bin"): Promise<ScanResult> {
  const provider = scanProvider();
  if (!provider) return { status: "NOT_SCANNED", detail: "No malware scanner is set up on this site." };
  try {
    let res: Response;
    // A scanner that never answers mustn't hold an upload open; the file is retried later.
    const signal = AbortSignal.timeout(25_000);
    if (provider === "generic") {
      res = await fetch(process.env.MALWARE_SCAN_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...(process.env.MALWARE_SCAN_TOKEN ? { Authorization: `Bearer ${process.env.MALWARE_SCAN_TOKEN}` } : {}) },
        body: bytes as unknown as BodyInit,
        signal,
      });
    } else {
      const form = new FormData();
      const field = provider === "cloudmersive" ? "inputFile" : process.env.MALWARE_SCAN_FIELD || "FILES";
      form.append(field, new Blob([bytes as unknown as BlobPart]), filename);
      const url = provider === "cloudmersive" ? process.env.MALWARE_SCAN_URL || "https://api.cloudmersive.com/virus/scan/file" : process.env.MALWARE_SCAN_URL!;
      const headers: Record<string, string> =
        provider === "cloudmersive" ? { Apikey: process.env.CLOUDMERSIVE_API_KEY! } : process.env.MALWARE_SCAN_TOKEN ? { Authorization: `Bearer ${process.env.MALWARE_SCAN_TOKEN}` } : {};
      res = await fetch(url, { method: "POST", headers, body: form, signal });
    }
    const json = await res.json().catch(() => null);
    // Some ClamAV wrappers answer a found virus with a 4xx/406 but a readable body.
    const status = interpretScanResponse(json);
    if (status === "INFECTED") return { status, detail: null };
    if (!res.ok) return { status: "PENDING", detail: res.status === 401 || res.status === 403 ? `The scanner refused the request (HTTP ${res.status}) — check the scanner key/token.` : `The scanner answered with an error (HTTP ${res.status}).` };
    if (status === "PENDING") return { status, detail: "The scanner's answer wasn't a clear clean/infected result." };
    return { status, detail: null };
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { status: "PENDING", detail: timeout ? "The scanner didn't answer within 25 seconds." : "The scanner couldn't be reached (network or address problem)." };
  }
}

export async function scanBytes(bytes: Uint8Array, filename = "upload.bin"): Promise<ScanStatus> {
  return (await scanBytesDetailed(bytes, filename)).status;
}

// The industry-standard harmless antivirus test string (EICAR). Every scanner must flag it.
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export async function scannerSelfTest() {
  const provider = scanProvider();
  if (!provider) return { provider: "none", eicar: "NOT_SCANNED" as ScanStatus, clean: "NOT_SCANNED" as ScanStatus, ok: false };
  const eicar = await scanBytes(new TextEncoder().encode(EICAR), "eicar-test.txt");
  const clean = await scanBytes(new TextEncoder().encode("%PDF-1.4\n% TTurner Client Connect scanner self-test\n"), "clean-test.pdf");
  return { provider, eicar, clean, ok: eicar === "INFECTED" && clean === "CLEAN" };
}
