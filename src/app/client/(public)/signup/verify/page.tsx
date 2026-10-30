import Link from "next/link";
import { cookies } from "next/headers";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { completeSignupAction, resendSignupAction } from "@/app/actions/signup";
import { signupDestination } from "@/lib/services/client-signup";

export const metadata = { title: "Confirm your email" };

export default async function VerifySignupPage() {
  const name = process.env.NODE_ENV === "production" ? "__Host-tcc_signup" : "tcc_signup";
  const masked = await signupDestination((await cookies()).get(name)?.value);
  if (!masked) {
    return (
      <>
        <h1 className="mb-2 text-2xl font-bold">Confirm your email</h1>
        <Notice tone="warn">This sign-up session ended. <Link className="underline" href="/client/signup">Start again</Link>.</Notice>
      </>
    );
  }
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Check your email</h1>
      <p className="mb-4 text-sm text-slate-600">
        If this address can be used for a new account, we sent a 6-digit code to <strong>{masked}</strong>. It expires in 15 minutes and works once.
      </p>
      <ActionForm action={completeSignupAction} className="space-y-4" showSuccess={false}>
        <Field label="6-digit code"><input className="input text-center text-xl tracking-[0.3em]" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus /></Field>
        <Button type="submit" className="w-full">Confirm and continue</Button>
      </ActionForm>
      <ActionForm action={resendSignupAction} className="mt-3 text-center text-sm">
        Didn&apos;t receive a code? <button className="font-semibold underline">Resend code</button>
      </ActionForm>
      <p className="mt-3 text-center text-xs text-slate-500">Check your spam folder. Already have an account? You&apos;ll get an email telling you to sign in instead.</p>
    </>
  );
}
