import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { forgotPasswordAction } from "@/app/actions/auth";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Reset your password</h1>
      <p className="mb-4 text-sm text-slate-600">We&apos;ll email a link that works for one hour.</p>
      <ActionForm action={forgotPasswordAction} className="space-y-4">
        <Field label="Email"><input className="input" type="email" name="email" required autoComplete="username" /></Field>
        <Button type="submit" className="w-full">Send reset link</Button>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/staff/login" className="underline">Back to sign in</Link></p>
    </>
  );
}
