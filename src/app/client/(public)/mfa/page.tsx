import { redirect } from "next/navigation";
import { MfaCodeForm } from "@/components/mfa-forms";
import { portalLogoutAction, portalVerifyMfaAction } from "@/app/actions/portal";
import { getPortalSessionState } from "@/lib/portal/session";

export const metadata = { title: "Two-step verification" };

export default async function PortalMfa() {
  const s = await getPortalSessionState();
  if (!s) redirect("/client/login");
  if (s.mfaPassed) redirect("/client");
  if (!s.mfaEnrolled) redirect("/client/mfa/setup");
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Two-step verification</h1>
      <p className="mb-4 text-sm text-slate-600">Enter the code from your authenticator app.</p>
      <MfaCodeForm action={portalVerifyMfaAction} />
      <form action={portalLogoutAction} className="mt-4 text-center"><button className="text-sm underline">Sign out</button></form>
    </>
  );
}
