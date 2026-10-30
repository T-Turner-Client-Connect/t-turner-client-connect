import { Badge } from "@/components/ui";
import { scanState, type ScanHealth } from "@/lib/scan-labels";

/** Malware-scan status beside an upload: Pending, Scanning, Passed or Failed, with the reason. */
export function ScanStatus({ doc, health, compact }: { doc: Parameters<typeof scanState>[0]; health: ScanHealth; compact?: boolean }) {
  const s = scanState(doc, health);
  return (
    <span className="inline-flex flex-col" data-testid="scan-status" data-scan={s.label}>
      <span><Badge tone={s.tone}>Scan: {s.label}</Badge></span>
      {!compact && s.label !== "Passed" && <span className="mt-0.5 max-w-md text-xs text-slate-600">{s.explain}</span>}
    </span>
  );
}
