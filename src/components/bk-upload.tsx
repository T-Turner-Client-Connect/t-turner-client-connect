import { Badge, Field } from "@/components/ui";
import { asOfText, BK_UPLOAD_TYPES, MONTH_NAMES, missingInfo, periodText } from "@/lib/bk-uploads";
import { fmtDateTime } from "@/lib/format";

/**
 * The fields every bookkeeping upload asks for, in this order: the business
 * it saves to, what it is, the reporting period, and an "as of" date when
 * one applies. Upload date and uploader are recorded automatically.
 */
export function BkUploadFields({ business, typeName = "docType", types = Object.keys(BK_UPLOAD_TYPES) as (keyof typeof BK_UPLOAD_TYPES)[], year, month, labelPrefix = "" }: {
  business: string;
  typeName?: string;
  types?: (keyof typeof BK_UPLOAD_TYPES)[];
  year: number;
  month: number | null;
  labelPrefix?: string;
}) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 7 }, (_, i) => thisYear + 1 - i);
  return (
    <div className="grid w-full gap-2 sm:grid-cols-2" data-testid="bk-upload-fields">
      <p className="rounded-lg bg-ivory-50 px-3 py-2 text-sm sm:col-span-2" data-testid="bk-upload-business">Saving to: <strong>{business}</strong></p>
      <Field label={`${labelPrefix}What are you uploading?`} className="sm:col-span-2">
        <select className="input" name={typeName} required defaultValue="" data-testid="bk-upload-type">
          <option value="" disabled>Choose…</option>
          {types.map((k) => <option key={k} value={k}>{BK_UPLOAD_TYPES[k]}</option>)}
        </select>
      </Field>
      <fieldset className="rounded-xl border border-ivory-200 p-2 sm:col-span-2">
        <legend className="px-1 text-sm font-semibold">Reporting period (what the document covers)</legend>
        <div className="grid gap-2 sm:grid-cols-4">
          <Field label="Covers">
            <select className="input" name="periodKind" defaultValue="MONTH" data-testid="bk-period-kind">
              <option value="MONTH">A month</option>
              <option value="QUARTER">A quarter</option>
              <option value="RANGE">A date range</option>
            </select>
          </Field>
          <Field label="Year (month or quarter)"><select className="input" name="periodYear" defaultValue={year}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
          <Field label="Month"><select className="input" name="periodMonth" defaultValue={month ?? ""}><option value="">—</option>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
          <Field label="Quarter"><select className="input" name="periodQuarter" defaultValue=""><option value="">—</option>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</select></Field>
          <Field label="From (date range)"><input className="input" type="date" name="periodStart" /></Field>
          <Field label="To (date range)"><input className="input" type="date" name="periodEnd" /></Field>
          <Field label="“As of” date (if any)" hint="Required for a Balance Sheet" className="sm:col-span-2"><input className="input" type="date" name="asOf" data-testid="bk-as-of" /></Field>
        </div>
      </fieldset>
      <p className="text-xs text-slate-600 sm:col-span-2">The upload date and time and who uploaded it are recorded automatically.</p>
    </div>
  );
}

type MetaDoc = {
  docType: string | null;
  reportType?: string | null;
  year: number | null;
  month: number | null;
  reportPeriodType?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  reportAsOf?: Date | null;
  createdAt: Date;
  uploadedByPortal?: { name: string } | null;
  uploadedByStaff?: { name: string } | null;
};

/** Shown beside every bookkeeping file: what it is, the period it covers, "as of", and — separately — uploaded on/by. */
export function UploadMeta({ d, label }: { d: MetaDoc; label?: string | null }) {
  const period = periodText(d);
  const asOf = asOfText(d);
  const missing = missingInfo(d);
  const what = label ?? (d.docType && d.docType in BK_UPLOAD_TYPES ? BK_UPLOAD_TYPES[d.docType as keyof typeof BK_UPLOAD_TYPES] : null);
  const by = d.uploadedByPortal ? `${d.uploadedByPortal.name} (client)` : d.uploadedByStaff ? `${d.uploadedByStaff.name} (staff)` : "not recorded";
  return (
    <span className="block text-xs text-slate-600" data-testid="upload-meta">
      {what && <span>{what} · </span>}
      <span>Period: {period ?? "—"}</span>
      {asOf && <span> · As of {asOf}</span>}
      <span className="block">Uploaded on {fmtDateTime(d.createdAt)} by {by}</span>
      {missing.length > 0 && <Badge tone="amber" className="mt-0.5">Needs review: {missing.join(", ")}</Badge>}
    </span>
  );
}
