// Plain-language malware-scan states shown to staff (and, for their own uploads, clients).
export const SCAN_LABELS = {
  CLEAN: { tone: "green", text: "Scanned clean", client: "Received" },
  PENDING: { tone: "amber", text: "Quarantined — scan pending", client: "Being checked for viruses" },
  NOT_SCANNED: { tone: "amber", text: "Quarantined — scanner not set up", client: "Being checked for viruses" },
  INFECTED: { tone: "red", text: "Infected — file destroyed", client: "Couldn't be accepted — please upload a different copy" },
} as const;

export type ScanHealth = { configured: boolean; recheckRunning: boolean; lastRecheckAt: Date | null };
type ScanDoc = { scanStatus: keyof typeof SCAN_LABELS; scanAttempts?: number; lastScanAt?: Date | null; lastScanError?: string | null };

/**
 * Pending / Scanning / Passed / Failed for one upload, with the reason it's
 * still quarantined. Nothing here releases a file: only a clean scan does.
 */
export function scanState(d: ScanDoc, h: ScanHealth) {
  if (d.scanStatus === "CLEAN") return { label: "Passed", tone: "green" as const, explain: "Scanned clean." };
  if (d.scanStatus === "INFECTED") return { label: "Failed", tone: "red" as const, explain: "A virus was found. The file was destroyed — ask for a new copy." };
  if (!h.configured) {
    return { label: "Unavailable", tone: "red" as const, explain: "Quarantined: malware scanning isn't set up on this site yet, so this file can't be checked. It stays locked (no downloads, never shown to the client) until a scanner is connected and it passes." };
  }
  const tries = d.scanAttempts ?? 0;
  const last = d.lastScanAt ? ` Last try ${d.lastScanAt.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${d.lastScanError ? `: ${d.lastScanError}` : "."}` : "";
  const schedule = h.recheckRunning ? " Re-checked automatically every 10 minutes." : " Automatic re-checks aren't verified (no recent scheduled run) — use “Scan quarantined files now” on the Documents page.";
  if (tries === 0) return { label: "Pending scan", tone: "amber" as const, explain: `Quarantined: waiting for its first scan.${schedule}` };
  return { label: "Scanning", tone: "amber" as const, explain: `Quarantined: the scan hasn't finished (${tries} attempt${tries === 1 ? "" : "s"}).${last}${schedule}` };
}

/**
 * What a client sees for their own upload: a receipt, never the file, until it
 * passes. Pending scan · Scanning · Passed · Failed/unavailable.
 */
export function clientScanState(d: ScanDoc, h: Pick<ScanHealth, "configured">) {
  if (d.scanStatus === "CLEAN") return { label: "Passed", tone: "green" as const, explain: "Checked and safe." };
  if (d.scanStatus === "INFECTED") return { label: "Failed", tone: "red" as const, explain: "This file couldn't be accepted. Please upload a different copy." };
  if (!h.configured) return { label: "Unavailable", tone: "red" as const, explain: "Received and held securely. The virus check isn't available right now; our office has been notified and it will be checked before anyone can open it." };
  if (d.lastScanError) return { label: "Unavailable", tone: "amber" as const, explain: "Received and held securely. The virus check couldn't finish yet and will be retried automatically." };
  if (!d.scanAttempts) return { label: "Pending scan", tone: "amber" as const, explain: "Received. It's waiting to be checked for viruses." };
  return { label: "Scanning", tone: "amber" as const, explain: "Received. The virus check is in progress." };
}
