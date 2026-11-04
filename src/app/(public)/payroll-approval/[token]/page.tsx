import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { ApprovalSummary, DecisionForm } from "@/components/payroll/approval-summary";
import { dayOf, money, whenOf } from "@/components/payroll/status";
import { linkDecideAction, linkSendCodeAction, linkVerifyAction } from "@/app/actions/payroll-portal";
import { getPortalUser } from "@/lib/portal/session";
import { LINK_MESSAGES, linkView, type LinkState } from "@/lib/services/payroll-approval";
import { PAYROLL_VERIFY_COOKIE } from "@/lib/payroll/cookie";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Approve payroll" };

/**
 * Mobile-first approval page opened from a texted or emailed link. The link alone is not enough:
 * the approver's own signed-in portal session on this device, or a one-time code (or password +
 * authenticator), confirms who is deciding before any detail or decision.
 */
export default async function PayrollLinkPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const v = await linkView(token);
  if (v.state !== "OK" || !v.link || !v.view) {
    const mine = v.state === "USED" && v.link ? await prisma.payrollApproval.findFirst({ where: { linkId: v.link.id } }) : null;
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-navy-100 bg-white p-6 text-center" data-testid="link-state">
        <h1 className="font-serif text-2xl font-bold text-navy-900">{v.state === "USED" ? "Decision recorded" : "This link can't be used"}</h1>
        <p className="mt-2 text-sm text-slate-700">{mine ? `You ${mine.decision === "APPROVED" ? "approved" : "denied"} this payroll on ${whenOf(mine.createdAt)}.` : LINK_MESSAGES[v.state as Exclude<LinkState, "OK">]}</p>
        <Link href="/client/payroll-approval" className="mt-4 inline-block rounded-xl bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white">Sign in to your portal</Link>
      </div>
    );
  }
  const session = await getPortalUser();
  const sameUser = session?.id === v.link.portalUserId;
  const cookie = (await cookies()).get(PAYROLL_VERIFY_COOKIE)?.value ?? "";
  const verified = sameUser || cookie.split(".")[0] === v.link.id;
  const { version } = v.view;
  return (
    <div className="mx-auto max-w-md space-y-4 sm:max-w-2xl">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-600">Payroll approval</p>
        <h1 className="font-serif text-2xl font-bold text-navy-900">{v.business}</h1>
        <p className="text-sm text-slate-700">For {v.approver?.name}. Pay date {dayOf(version.checkDate)} · total {money(v.view.cost)}.</p>
      </header>
      {!verified ? (
        <section className="space-y-4 rounded-2xl border border-navy-100 bg-white p-5" data-testid="verify-step">
          <h2 className="font-serif text-lg font-bold text-navy-900">Step 1 · Confirm it&apos;s you</h2>
          <p className="text-sm text-slate-700">Because this is payroll, we confirm your identity before showing the details or recording a decision.</p>
          <ActionForm action={linkSendCodeAction.bind(null, token)}>
            <button type="submit" className="w-full rounded-xl bg-navy-900 px-4 py-3 text-base font-semibold text-white">Email me a 6-digit code</button>
          </ActionForm>
          <ActionForm action={linkVerifyAction.bind(null, token)} className="space-y-2">
            <label className="block text-sm font-semibold text-navy-900">Code
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className="input mt-1 w-full text-center text-2xl tracking-[0.4em]" placeholder="••••••" />
            </label>
            <button type="submit" className="w-full rounded-xl border-2 border-navy-900 px-4 py-3 text-base font-semibold text-navy-900">Confirm</button>
          </ActionForm>
          {v.approver?.mfaEnabledAt && (
            <details className="text-sm">
              <summary className="cursor-pointer font-semibold text-navy-900">Use my password and authenticator app instead</summary>
              <ActionForm action={linkVerifyAction.bind(null, token)} className="mt-2 space-y-2">
                <input name="password" type="password" autoComplete="current-password" className="input w-full" placeholder="Portal password" />
                <input name="authenticatorCode" inputMode="numeric" className="input w-full" placeholder="Authenticator code" />
                <button type="submit" className="w-full rounded-xl border-2 border-navy-900 px-4 py-2.5 font-semibold text-navy-900">Confirm</button>
              </ActionForm>
            </details>
          )}
          <p className="text-xs text-slate-500">Already signed in to your portal on this phone? <Link href="/client/payroll-approval" className="underline">Open Payroll Approval</Link>. We never accept approvals by text reply.</p>
        </section>
      ) : (
        <>
          <ApprovalSummary business={v.business} version={version} showDetail={v.view.showDetail} />
          <h2 className="font-serif text-lg font-bold text-navy-900">Step 2 · Your decision</h2>
          <DecisionForm action={linkDecideAction.bind(null, token)} />
          <p className="text-xs text-slate-500">This link works once and expires {whenOf(v.link.expiresAt)}. Approval doesn&apos;t release payroll; the office submits it after every required owner approves.</p>
        </>
      )}
    </div>
  );
}
