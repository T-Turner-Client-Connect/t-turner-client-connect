import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { uploadDocumentAction } from "@/app/actions/workspace";
import { CATEGORY_LABELS, REPORT_LABELS } from "@/lib/services/documents";
import { MONTHS } from "@/lib/services/bookkeeping";
import { TAX_DOC_TYPES } from "@/lib/document-types";

/**
 * Staff upload: choose the client (unless fixed), category, tax year, optional
 * month/report/tax document type, and staff-only draft or publish. Every file
 * is quarantined until the malware scan passes.
 */
export function UploadDocumentForm({ clientId, clients }: { clientId?: string; clients?: { id: string; displayName: string }[] }) {
  const year = new Date().getFullYear();
  return (
    <ActionForm action={uploadDocumentAction.bind(null, clientId ?? null)} className="grid gap-3 sm:grid-cols-2" resetOnSuccess idempotent>
      {!clientId && (
        <Field label="Client" className="sm:col-span-2">
          <select className="input" name="clientId" required defaultValue="">
            <option value="" disabled>Choose a client…</option>
            {clients?.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
          </select>
        </Field>
      )}
      <Field label="File" hint="PDF, JPG or PNG up to 5 MB." className="sm:col-span-2"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
      <Field label="Title"><input className="input" name="title" placeholder="e.g. 2025 Form 1040" /></Field>
      <Field label="Category">
        <select className="input" name="category" defaultValue="TAXES">
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Tax year" hint="Required for tax records."><input className="input" name="year" inputMode="numeric" defaultValue={year - 1} /></Field>
      <Field label="Month (bookkeeping, optional)">
        <select className="input" name="month" defaultValue="">
          <option value="">—</option>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
      </Field>
      <Field label="Tax document type" hint="Required for tax records. Federal, state and amended returns appear separately in the client's Retrieve Tax Filings. Labels the file only — it never marks a return accepted or work complete.">
        <select className="input" name="docType" defaultValue="">
          <option value="">—</option>
          {Object.entries(TAX_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Report type (bookkeeping, optional)">
        <select className="input" name="reportType" defaultValue="">
          <option value="">Not a report</option>
          {Object.entries(REPORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <fieldset className="space-y-1 text-sm sm:col-span-2">
        <legend className="mb-1 font-semibold text-navy-900">Who can see it</legend>
        <label className="flex items-center gap-2"><input type="radio" name="visibility" value="STAFF_ONLY" defaultChecked /> Staff-only draft</label>
        <label className="flex items-center gap-2"><input type="radio" name="visibility" value="PUBLISHED" /> Publish to the client&apos;s portal — shown (and the client notified) only after the malware scan passes</label>
      </fieldset>
      <div className="sm:col-span-2"><Button type="submit">Upload document</Button></div>
    </ActionForm>
  );
}
