import Link from "next/link";
import { UnsubscribeForm } from "@/components/unsubscribe-form";
import { unsubscribeAction } from "@/app/actions/unsubscribe";
import { readUnsubscribeToken } from "@/lib/unsubscribe-token";
import { maskEmail } from "@/lib/services/mfa";
import { BUSINESS } from "@/lib/business";

export const metadata = { title: "Email preferences", robots: { index: false, follow: false } };

/**
 * Public unsubscribe confirmation (no sign-in). Opening the link changes
 * nothing — link scanners open links too — the person confirms with a button.
 * Email apps' one-click unsubscribe uses POST /api/unsubscribe/[token].
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const check = readUnsubscribeToken(token);
  return (
    <div className="rounded-2xl border border-ivory-200 bg-white p-6 shadow-sm sm:p-10" data-testid="unsubscribe-page">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-700">Communication Preferences</p>
      <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Unsubscribe</h1>
      {check.ok ? (
        <>
          <p className="mt-3 text-[17px] text-slate-700">
            Choose which emails {BUSINESS.legalName} should stop sending to <strong className="text-navy-900">{maskEmail(check.payload.email)}</strong>.
          </p>
          <div className="mt-6">
            <UnsubscribeForm
              action={unsubscribeAction.bind(null, token)}
              thisLabel={check.payload.kind === "GENERAL" ? "General business update emails" : "Promotional emails"}
              thisHint={check.payload.kind === "GENERAL" ? "Office news, holiday closures and other nonessential announcements." : "Email flyers, newsletters, special offers and marketing announcements."}
            />
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-900" role="alert">
          <p className="font-semibold">{check.reason === "expired" ? "This unsubscribe link has expired." : "This unsubscribe link isn't valid."}</p>
          <p className="mt-1 text-sm">
            Sign in to your portal to manage your <Link className="underline" href="/client/account#communication-preferences">Communication Preferences</Link>, or call our office at{" "}
            <a className="underline" href={`tel:${BUSINESS.officePhoneTel}`}>{BUSINESS.officePhoneDisplay}</a> and we&apos;ll update them for you.
          </p>
        </div>
      )}
      <p className="mt-8 text-sm text-slate-600">
        Texts: reply <strong>STOP</strong> to any text from us to stop all texts, or <strong>START</strong> to resume.
      </p>
    </div>
  );
}
