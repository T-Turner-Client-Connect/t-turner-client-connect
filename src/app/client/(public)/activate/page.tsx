import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { requestActivationAction } from "@/app/actions/signup";

export const metadata = { title: "Activate your portal" };

export default function ActivatePage() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Already a client? Activate your portal.</h1>
      <p className="mb-4 text-sm text-slate-600">
        Enter the email address we have on file for you. We&apos;ll send a secure activation link to that address — your portal connects to your existing client file only through that link
        or after our office verifies your identity.
      </p>
      <ActionForm action={requestActivationAction} className="space-y-4" resetOnSuccess>
        <Field label="Email on file with our office"><input className="input" type="email" name="email" autoComplete="email" required /></Field>
        <Field label="Your name (optional)"><input className="input" name="name" autoComplete="name" /></Field>
        <Field label="Phone (optional — helps us verify you)"><input className="input" type="tel" name="phone" autoComplete="tel" /></Field>
        <div className="hidden" aria-hidden><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <Button type="submit" className="w-full">Request activation link</Button>
      </ActionForm>
      <p className="mt-4 text-center text-sm">New client? <Link href="/client/signup" className="underline">Create Client Account</Link> · <Link href="/client/login" className="underline">Sign in</Link></p>
    </>
  );
}
