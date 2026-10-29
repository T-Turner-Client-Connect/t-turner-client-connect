import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { ownerRecoveryAction } from "@/app/actions/verification";
import { getSessionState } from "@/lib/auth/session";

export const metadata = { title: "Owner recovery" };

export default async function OwnerRecoveryPage() {
  const state = await getSessionState();
  if (!state) redirect("/staff/login");
  if (state.mfaPassed) redirect("/");
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Owner recovery</h1>
      <p className="mb-3 text-sm text-slate-600">For {state.actor.email} only. This resets two-step verification for this one account so you can set up your authenticator app again. Two-step verification stays required for everyone.</p>
      <Notice title="Before you start">
        In Netlify → Site configuration → Environment variables, add <code>STAFF_RECOVERY_CODE</code> with 20+ random characters (mark it secret), then redeploy. Enter that same
        value below. It works once. Delete the variable afterwards.
      </Notice>
      <ActionForm action={ownerRecoveryAction} className="mt-4 space-y-3" showSuccess={false}>
        <Field label="Your password"><input className="input" type="password" name="password" autoComplete="current-password" required /></Field>
        <Field label="Owner recovery code (from Netlify)"><input className="input" type="password" name="recoveryCode" autoComplete="off" required /></Field>
        <Button type="submit" className="w-full">Reset my two-step verification</Button>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link className="underline" href="/staff/mfa">Back</Link></p>
    </>
  );
}
