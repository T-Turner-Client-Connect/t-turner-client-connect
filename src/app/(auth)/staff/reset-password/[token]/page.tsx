import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { resetPasswordAction } from "@/app/actions/auth";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <h1 className="mb-4 text-2xl font-bold">Choose a new password</h1>
      <ActionForm action={resetPasswordAction.bind(null, token)} className="space-y-4" showSuccess={false}>
        <Field label="New password" hint="At least 12 characters, with letters and numbers or symbols.">
          <input className="input" type="password" name="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password"><input className="input" type="password" name="confirm" required autoComplete="new-password" /></Field>
        <Button type="submit" className="w-full">Save password</Button>
      </ActionForm>
    </>
  );
}
