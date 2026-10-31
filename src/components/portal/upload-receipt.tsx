import { Badge } from "@/components/ui";
import { clientScanState } from "@/lib/scan-labels";
import { CLIENT_DOC_TYPES, TAX_DOC_TYPES } from "@/lib/document-types";
import { BK_UPLOAD_TYPES, periodText } from "@/lib/bk-uploads";
import { fmtDateTime } from "@/lib/format";
import type { ScanStatus } from "@prisma/client";

export type ReceiptDoc = {
  id: string;
  docType: string | null;
  year: number | null;
  month: number | null;
  reportPeriodType?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  createdAt: Date;
  scanStatus: ScanStatus;
  scanAttempts?: number;
  lastScanError?: string | null;
  file: { originalName: string };
};

const categoryOf = (t: string | null) =>
  !t ? "Category to be confirmed" : (BK_UPLOAD_TYPES as Record<string, string>)[t] ?? (CLIENT_DOC_TYPES as Record<string, string>)[t] ?? (TAX_DOC_TYPES as Record<string, string>)[t] ?? t;

/**
 * A client's receipt for their own upload: filename, category, period, upload
 * date and virus-check status. It never links to the file — opening,
 * downloading, printing and sharing happen only from the published list, and
 * only after the scan passes.
 */
export function UploadReceipt({ d, scannerConfigured }: { d: ReceiptDoc; scannerConfigured: boolean }) {
  const s = clientScanState(d, { configured: scannerConfigured });
  const period = periodText(d) ?? (d.year ? `Tax year ${d.year}` : "Period to be confirmed");
  return (
    <div className="flex flex-wrap items-start justify-between gap-2" data-testid="upload-receipt">
      <span className="text-sm">
        <span className="font-medium text-navy-900">{d.file.originalName}</span>
        <span className="block text-xs text-slate-600">{categoryOf(d.docType)} · {period} · Uploaded {fmtDateTime(d.createdAt)}</span>
      </span>
      <span className="max-w-xs text-right">
        <span data-testid="receipt-scan" data-scan={s.label}><Badge tone={s.tone}>Virus check: {s.label}</Badge></span>
        {s.label !== "Passed" && <span className="mt-0.5 block text-xs text-slate-600">{s.explain}</span>}
      </span>
    </div>
  );
}
