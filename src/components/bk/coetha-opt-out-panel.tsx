import { UserX } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { clearCoethaOptOutAction, setCoethaOptOutAction } from "@/app/actions/coetha";
import { OPT_OUT_VIA, type coethaOptOutView } from "@/lib/services/coetha-opt-out";
import { letterDateText, officeDay } from "@/lib/client-letters/templates";
import { fmtDateTime } from "@/lib/format";

type OptOut = Awaited<ReturnType<typeof coethaOptOutView>>;

/**
 * "Client prefers no Coetha" on the bookkeeping dashboard and the Coetha page. Shows the
 * preference (date, how the client told us, note, who recorded it) and, for staff who can edit
 * this client's books, the form to record or clear it. Both are audit-logged by the service.
 */
export function CoethaOptOutPanel({ clientId, optOut, canSet }: { clientId: string; optOut: OptOut; canSet: boolean }) {
  if (optOut) {
    return (
      <div className="rounded-2xl border border-slate-300 bg-slate-50 p-4 text-sm text-navy-900" data-testid="coetha-opt-out">
        <p className="flex items-center gap-2 font-semibold"><UserX className="size-5 text-slate-600" aria-hidden /> Client prefers no Coetha</p>
        <p className="mt-1">
          Told us on {letterDateText(optOut.toldOn)} by {optOut.viaLabel.toLowerCase()}. Recorded by {optOut.recordedByName}, {fmtDateTime(optOut.updatedAt)}.
        </p>
        {optOut.note && <p className="mt-1 whitespace-pre-line text-slate-700">“{optOut.note}”</p>}
        <p className="mt-1 text-slate-700">Coetha won&apos;t run, prepare drafts or request documents for this client. Our team prepares their books without Coetha.</p>
        {canSet && (
          <ActionForm action={clearCoethaOptOutAction.bind(null, clientId)} className="mt-3" confirm="Clear “Client prefers no Coetha”? Coetha will be able to work on this client's books again.">
            <Button type="submit" variant="secondary" data-testid="coetha-opt-out-clear">Clear preference</Button>
          </ActionForm>
        )}
      </div>
    );
  }
  if (!canSet) return null;
  return (
    <details className="rounded-2xl border border-ivory-200 bg-white p-4 text-sm shadow-sm" data-testid="coetha-opt-out-form">
      <summary className="cursor-pointer font-semibold text-navy-900">Client prefers no Coetha…</summary>
      <p className="mt-2 text-slate-700">Record it when the client tells us they&apos;d rather we prepare their books without Coetha. Coetha then won&apos;t run, draft or request documents for them; everything else about their service stays the same. It can be cleared later.</p>
      <ActionForm action={setCoethaOptOutAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Date they told us">
          <input type="date" name="toldOn" required defaultValue={officeDay().toISOString().slice(0, 10)} className="input" />
        </Field>
        <Field label="How they told us">
          <select name="via" required className="input" defaultValue="">
            <option value="" disabled>Choose…</option>
            {Object.entries(OPT_OUT_VIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)" className="sm:col-span-2">
          <textarea name="note" rows={2} maxLength={1000} className="input" />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" data-testid="coetha-opt-out-save">Record preference</Button>
        </div>
      </ActionForm>
    </details>
  );
}
