import { redirect } from "next/navigation";
import { MfaCodeForm } from "@/components/mfa-forms";
import { verifyMfaAction, logoutAction } from "@/app/actions/auth";
import { getSessionState } from "@/lib/auth/session";

export const metadata = { title: "Two-step verification" };

export default async function MfaPage() {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  if (state.mfaPassed) redirect("/");
  if (!state.mfaEnrolled) redirect("/staff/mfa/setup");
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Two-step verification</h1>
      <p className="mb-4 text-sm text-slate-600">Signed in as {state.actor.email}.</p>
      <MfaCodeForm action={verifyMfaAction} />
      <form action={logoutAction} className="mt-4 text-center"><button className="text-sm underline">Use a different account</button></form>
    </>
  );
}
