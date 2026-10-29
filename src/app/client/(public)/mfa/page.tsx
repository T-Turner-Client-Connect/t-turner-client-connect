import { redirect } from "next/navigation";
import { SignInVerification } from "@/components/verification";
import { sendSignInCodeAction, verifySignInAction } from "@/app/actions/verification";
import { portalLogoutAction } from "@/app/actions/portal";
import { getPortalSessionState } from "@/lib/portal/session";
import { signInDiagnostics } from "@/lib/auth/diagnostics";
import { BUSINESS } from "@/lib/business";

export const metadata = { title: "Verify it's you" };

export default async function PortalMfa() {
  const s = await getPortalSessionState();
  if (!s) redirect("/client/login");
  if (s.mfaPassed) redirect("/client");
  if (!s.mfaEnrolled) redirect("/client/mfa/setup");
  const diagnostics = await signInDiagnostics({ kind: "portal", id: s.actor.id });
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Verify it&apos;s you</h1>
      <p className="mb-4 text-sm text-slate-600">
        {s.emailCodes ? "We'll email you a one-time code. No app needed." : "Enter the code from your authenticator app."}
      </p>
      <SignInVerification
        verifyAction={verifySignInAction.bind(null, "portal")}
        sendCodeAction={sendSignInCodeAction.bind(null, "portal")}
        diagnostics={diagnostics}
        emailFirst={s.emailCodes}
        authenticatorAvailable={diagnostics.enrolledAt !== null}
        recovery={
          <ul className="space-y-1.5">
            <li><strong>Can&apos;t get into your email or authenticator?</strong> Call our office at {BUSINESS.officePhoneDisplay}. After we confirm your identity, we&apos;ll reset your sign-in verification.</li>
            <li>We will never ask for your password or your codes by phone or email.</li>
          </ul>
        }
      />
      <form action={portalLogoutAction} className="mt-4 text-center"><button className="text-sm underline">Sign out</button></form>
    </>
  );
}
