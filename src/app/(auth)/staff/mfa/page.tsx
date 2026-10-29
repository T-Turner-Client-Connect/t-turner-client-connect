import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInVerification } from "@/components/verification";
import { sendSignInCodeAction, verifySignInAction } from "@/app/actions/verification";
import { logoutAction } from "@/app/actions/auth";
import { getSessionState } from "@/lib/auth/session";
import { signInDiagnostics } from "@/lib/auth/diagnostics";
import { BUSINESS } from "@/lib/business";

export const metadata = { title: "Two-step verification" };

export default async function MfaPage() {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  if (state.mfaPassed) redirect("/");
  if (!state.mfaEnrolled) redirect("/staff/mfa/setup");
  const diagnostics = await signInDiagnostics({ kind: "staff", id: state.actor.id });
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Two-step verification</h1>
      <p className="mb-4 text-sm text-slate-600">Signed in as {state.actor.email}. Staff accounts use an authenticator app, with recovery codes as backup.</p>
      <SignInVerification
        verifyAction={verifySignInAction.bind(null, "staff")}
        sendCodeAction={sendSignInCodeAction.bind(null, "staff")}
        diagnostics={diagnostics}
        recovery={
          <ul className="space-y-1.5">
            <li><strong>Used or lost your recovery codes?</strong> Another Admin can reset your two-step verification from Settings → Staff accounts → Manage.</li>
            <li><strong>Only Admin, or no one else can help?</strong> <Link className="underline" href="/staff/recover">Use owner recovery</Link> — needs your password and a one-time code you set in Netlify.</li>
            <li>Questions: {BUSINESS.officePhoneDisplay}.</li>
          </ul>
        }
      />
      <form action={logoutAction} className="mt-4 text-center"><button className="text-sm underline">Use a different account</button></form>
    </>
  );
}
