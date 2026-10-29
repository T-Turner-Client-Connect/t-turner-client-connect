import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { acceptInviteAction } from "@/app/actions/auth";
import { findOpenInvite } from "@/lib/services/users";

export const metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findOpenInvite(token);
  if (!invite) return <Notice tone="error" title="Invitation not valid">This link has expired, was replaced or revoked, or was already used. Ask an Admin for a new invitation.</Notice>;
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Create Your Staff Account</h1>
      <p className="mb-4 text-sm text-slate-600">
        Welcome, {invite.name}. Choose a password for <strong>{invite.email}</strong> ({invite.role === "ADMIN" ? "Admin" : "Staff"} account).
      </p>
      <ActionForm action={acceptInviteAction.bind(null, token)} className="space-y-4" showSuccess={false}>
        <Field label="Password" hint="At least 12 characters, with letters and numbers or symbols.">
          <input className="input" type="password" name="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password"><input className="input" type="password" name="confirm" required autoComplete="new-password" /></Field>
        <Button type="submit" className="w-full">Create my account</Button>
      </ActionForm>
    </>
  );
}
