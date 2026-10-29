import { redirect } from "next/navigation";
import { MfaSetupForm } from "@/components/mfa-forms";
import { portalConfirmMfaSetupAction } from "@/app/actions/portal";
import { getPortalSessionState } from "@/lib/portal/session";
import { beginEnrollment } from "@/lib/services/mfa";

export const metadata = { title: "Set up two-step verification" };

export default async function PortalMfaSetup() {
  const s = await getPortalSessionState();
  if (!s) redirect("/client/login");
  if (s.mfaEnrolled) redirect(s.mfaPassed ? "/client" : "/client/mfa");
  const { secret, qrSvg } = await beginEnrollment({ kind: "portal", id: s.actor.id });
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Protect your account</h1>
      <p className="mb-4 text-sm text-slate-600">
        Your portal holds private financial documents, so we require two-step verification. Install a free authenticator app (Google Authenticator, Microsoft Authenticator…) and scan this code.
      </p>
      <div className="mx-auto mb-3 w-48" dangerouslySetInnerHTML={{ __html: qrSvg }} />
      <details className="mb-4 text-sm">
        <summary className="cursor-pointer underline">Can&apos;t scan? Enter this key instead</summary>
        <p className="mt-2 break-all rounded bg-navy-50 p-2 font-mono" data-testid="mfa-secret">{secret}</p>
      </details>
      <MfaSetupForm action={portalConfirmMfaSetupAction} continueHref="/client" />
    </>
  );
}
