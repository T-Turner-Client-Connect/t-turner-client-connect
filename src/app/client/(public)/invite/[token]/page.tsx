import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import { portalAcceptInviteAction } from "@/app/actions/portal";
import { findOpenPortalInvite } from "@/lib/services/portal-accounts";

export const metadata = { title: "Set up your portal account" };

export default async function PortalInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findOpenPortalInvite(token);
  if (!invite) return <Notice tone="error" title="Invitation not valid">This link has expired or was already used. Please contact our office for a new one.</Notice>;
  return (
    <>
      <h1 className="mb-2 text-2xl font-bold">Welcome, {invite.name}</h1>
      <p className="mb-4 text-sm text-slate-600">Create a password for <strong>{invite.email}</strong>. Next, you&apos;ll set up two-step verification with an authenticator app.</p>
      <ActionForm action={portalAcceptInviteAction.bind(null, token)} className="space-y-4" showSuccess={false}>
        <Field label="Password" hint="At least 12 characters, with letters and numbers or symbols.">
          <input className="input" type="password" name="password" required minLength={12} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password"><input className="input" type="password" name="confirm" required autoComplete="new-password" /></Field>
        <Button type="submit" className="w-full">Create my account</Button>
      </ActionForm>
    </>
  );
}
