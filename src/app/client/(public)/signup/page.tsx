import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { startSignupAction } from "@/app/actions/signup";
import { selfServiceAvailable } from "@/lib/services/client-signup";
import { BUSINESS } from "@/lib/business";

export const metadata = { title: "Create Client Account" };

export default async function SignupPage() {
  // Rendered per request: whether sign-up is open depends on live settings.
  await connection();
  const open = await selfServiceAvailable();
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Create Client Account</h1>
      <p className="mb-4 text-sm text-slate-600">New to {BUSINESS.shortName}? Create your secure portal login. We&apos;ll email you a code to confirm your address.</p>
      <Notice>
        <strong>Already a client?</strong> <Link className="underline" href="/client/activate">Activate your portal</Link> instead so it connects to your existing file.
      </Notice>
      {!open ? (
        <div className="mt-4"><Notice tone="warn" title="Online sign-up opens soon">Please call our office at {BUSINESS.officePhoneDisplay} and we&apos;ll set up your account.</Notice></div>
      ) : (
        <ActionForm action={startSignupAction} className="mt-4 space-y-4" showSuccess={false}>
          <Field label="Your name"><input className="input" name="name" autoComplete="name" required /></Field>
          <Field label="Email"><input className="input" type="email" name="email" autoComplete="email" required /></Field>
          <Field label="Password" hint="At least 12 characters, with letters and numbers or symbols."><input className="input" type="password" name="password" autoComplete="new-password" required minLength={12} /></Field>
          <Field label="Confirm password"><input className="input" type="password" name="confirm" autoComplete="new-password" required /></Field>
          <div className="hidden" aria-hidden><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
          <Button type="submit" className="w-full">Create account</Button>
        </ActionForm>
      )}
      <p className="mt-4 text-center text-sm">Have an account? <Link href="/client/login" className="underline">Sign in</Link></p>
      <p className="mt-2 text-center text-xs text-slate-500">This creates a client portal login only. Staff accounts are by invitation.</p>
    </>
  );
}
