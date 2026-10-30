import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice, PageHeader } from "@/components/ui";
import { referralAction } from "@/app/actions/tax-center";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";

export const metadata = { title: "Refer a Friend" };

export default async function Referrals({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canMessage) return <Notice>Messaging isn&apos;t included in your access to this account.</Notice>;
  return (
    <>
      <PageHeader title="Refer a Friend" subtitle="Know someone who could use our help? Share their details and we'll reach out." />
      <section className="max-w-xl rounded-2xl border border-ivory-200 bg-white p-6" data-testid="referrals-panel">
        <ActionForm action={referralAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess>
          <Field label="Their name"><input className="input" name="name" required /></Field>
          <Field label="Phone or email"><input className="input" name="contact" required /></Field>
          <Field label="Note (optional)"><input className="input" name="note" /></Field>
          <Button type="submit">Send referral</Button>
        </ActionForm>
        <p className="mt-3 text-xs text-slate-500">Please share their details only with their permission.</p>
      </section>
    </>
  );
}
