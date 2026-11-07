import { Landmark } from "lucide-react";
import type { RefundTransferPayment } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { DEBT_CHECK, OFFSET_RISK, RT_STATUS, type RtStatus } from "@/lib/services/refund-transfers";

const usd = (c: number | null) => (c == null ? "" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * "Pay From My Refund" on Billing & Payments. Records the client's choice, debt check and
 * acknowledgments for the office to review; it is not a Republic Bank application and charges nothing.
 */
/** `action`: the portal's request action bound to the account, or View as Client's stand-in (`readOnly`: shown disabled). */
export function PayFromRefund({ action, readOnly, existing }: { action: (prev: { error?: string; ok?: string; at?: number } | null, fd: FormData) => Promise<{ error?: string; ok?: string; at?: number } | null>; readOnly?: boolean; existing: RefundTransferPayment | null }) {
  const taxYear = new Date().getFullYear() - 1;
  const head = (
    <span className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-navy-900 text-gold-300" aria-hidden><Landmark className="size-5" /></span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-navy-900">Pay From My Refund</span>
        <span className="block text-xs text-slate-600">Republic Bank Refund Transfer · Republic Bank charges its own fees</span>
      </span>
    </span>
  );
  if (existing) {
    const st = RT_STATUS[existing.status as RtStatus];
    return (
      <div className="rounded-xl border-2 border-gold-400 bg-white px-4 py-3" data-testid="pay-refund-status">
        {head}
        <p className="mt-2 text-sm text-navy-900"><strong>{taxYear} return:</strong> {st.label}{existing.amountCents != null && <> · fee {usd(existing.amountCents)}</>}</p>
        {existing.status === "REQUESTED" && <p className="mt-1 text-xs text-slate-600">Our office will review your request and confirm the fee before your return is filed.</p>}
        {(existing.status === "SHORT" || existing.status === "NOT_RECEIVED") && <p className="mt-1 text-xs text-red-800">The remaining balance needs another payment method. Please choose one below or contact our office.</p>}
      </div>
    );
  }
  return (
    <details className="group rounded-xl border-2 border-gold-400 bg-white open:bg-ivory-50/40" data-testid="pay-refund">
      <summary className="cursor-pointer list-none px-4 py-3 [&::-webkit-details-marker]:hidden">{head}</summary>
      <PreviewDisabled readOnly={readOnly} className="border-t border-gold-200 px-4 py-3">
      <ActionForm action={action} className={readOnly ? "space-y-3 text-sm text-navy-900" : "space-y-3 border-t border-gold-200 px-4 py-3 text-sm text-navy-900"}>
        <input type="hidden" name="taxYear" value={taxYear} />
        <p>Would you like your tax preparation fees deducted from your tax refund? Republic Bank charges additional fees for this optional Refund Transfer service. Paying directly avoids those fees. Our office will confirm the total fees with you before you authorize the service.</p>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="font-bold">IMPORTANT: PLEASE CHECK FOR OUTSTANDING DEBTS BEFORE SELECTING PAY FROM MY REFUND</p>
          <p className="mt-1">If you would like your tax preparation fees deducted from your refund, please call the U.S. Treasury Offset Program at <a className="font-semibold underline" href="tel:+18003043107">1-800-304-3107</a> to check for debts reported to the program that may reduce or intercept your federal tax refund.</p>
          <p className="mt-1">These may include past-due federal or state obligations, child support, and certain other qualifying debts.</p>
          <p className="mt-1">Please note: This check does not guarantee your refund will be issued or that all debts have been identified. You may also need to check directly with the IRS or your state tax agency.</p>
          <p className="mt-1">If your refund is reduced, intercepted, or insufficient to cover your tax preparation fees, you will be required to pay the remaining balance using another approved payment method.</p>
        </div>
        <fieldset>
          <legend className="mb-1 font-semibold">Have you checked for outstanding debts that may affect your refund?</legend>
          {Object.entries(DEBT_CHECK).map(([k, v]) => <label key={k} className="flex items-center gap-2"><input type="radio" name="debtCheck" value={k} required className="accent-navy-900" /> {v}</label>)}
        </fieldset>
        <fieldset>
          <legend className="mb-1 font-semibold">Do you or your spouse owe federal or state tax, child support, or other debts that could reduce your refund?</legend>
          <div className="flex flex-wrap gap-4">{Object.entries(OFFSET_RISK).map(([k, v]) => <label key={k} className="flex items-center gap-2"><input type="radio" name="offsetRisk" value={k} required className="accent-navy-900" /> {v}</label>)}</div>
        </fieldset>
        <label className="flex items-start gap-2"><input type="checkbox" name="ack" required className="mt-1 accent-navy-900" /> <span>I understand my refund amount and timing are not guaranteed. If my refund is intercepted, reduced, delayed, or not enough, I am still responsible for any unpaid preparation fees, and the office may ask me to use another approved payment method.</span></label>
        <p className="text-xs text-slate-600">If you haven&apos;t checked yet, you can still continue — your request stays pending review. Republic Bank&apos;s own application and agreement are completed separately.</p>
        <Button type="submit" data-testid="request-refund-pay">Choose Pay From My Refund</Button>
      </ActionForm>
      </PreviewDisabled>
    </details>
  );
}
