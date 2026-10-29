import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { portalPrefsAction } from "@/app/actions/portal";
import { requirePortalUser } from "@/lib/portal/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Account" };

export default async function PortalSettings() {
  const actor = await requirePortalUser();
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: actor.id } });
  return (
    <>
      <PageHeader title="Account" subtitle="Notification preferences and sign-in security." />
      <Card title="Notifications" className="max-w-xl">
        <p className="mb-3 text-sm text-slate-600">
          We&apos;ll let you know when there&apos;s a new message, document or request in your portal. Notices only contain a sign-in link — never your documents or account details.
          These are account notices, separate from any marketing preferences.
        </p>
        <ActionForm action={portalPrefsAction} className="space-y-3">
          <label className="flex items-center gap-2"><input type="checkbox" name="notifyByEmail" defaultChecked={user.notifyByEmail} className="size-4 accent-navy-900" /> Email me at {user.email}</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="notifyBySms" defaultChecked={user.notifyBySms} className="size-4 accent-navy-900" /> Text me</label>
          <Field label="Mobile number for texts" hint="Message & data rates may apply. Reply STOP to stop texts."><input className="input" type="tel" name="phone" defaultValue={user.phone ?? ""} /></Field>
          <Button type="submit">Save</Button>
        </ActionForm>
      </Card>
    </>
  );
}
