import { redirect } from "next/navigation";
import { MfaSetupForm } from "@/components/mfa-forms";
import { confirmMfaSetupAction } from "@/app/actions/auth";
import { getSessionState } from "@/lib/auth/session";
import { beginEnrollment } from "@/lib/services/mfa";

export const metadata = { title: "Set up two-step verification" };

export default async function MfaSetupPage({ searchParams }: { searchParams: Promise<{ recovered?: string }> }) {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  if (state.mfaEnrolled) redirect(state.mfaPassed ? "/" : "/staff/mfa");
  const { secret, qrSvg } = await beginEnrollment({ kind: "staff", id: state.actor.id });
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Set up two-step verification</h1>
      {(await searchParams).recovered && (
        <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
          Recovery worked. Set up your authenticator app again below, and save your new recovery codes. Remember to delete STAFF_RECOVERY_CODE in Netlify.
        </p>
      )}
      <p className="mb-4 text-sm text-slate-600">
        Required for every staff account because this system holds client information. Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then scan this code.
      </p>
      {/* QR SVG is generated on the server from our own otpauth URI. */}
      <div className="mx-auto mb-3 w-48" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <details className="mb-4 text-sm">
        <summary className="cursor-pointer underline">Can&apos;t scan? Enter this key instead</summary>
        <p className="mt-2 break-all rounded bg-navy-50 p-2 font-mono" data-testid="mfa-secret">{secret}</p>
      </details>
      <MfaSetupForm action={confirmMfaSetupAction} continueHref="/" />
    </>
  );
}
