import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { claimOwnerAction } from "@/app/actions/owner";
import { requireUser } from "@/lib/auth/session";
import { ownerNavState } from "@/lib/auth/owner";

export const metadata = { title: "Set up Owner's Office" };

export default async function ClaimOwnerPage() {
  const user = await requireUser();
  if ((await ownerNavState(user)) !== "claim") notFound();
  return (
    <>
      <PageHeader title="Set up your Owner's Office" subtitle="A private section for your revenue, expenses, invoices and pricing." />
      <Card className="max-w-xl">
        <p className="text-sm text-slate-700">
          This links the Owner&apos;s Office to <strong>this staff account</strong> ({user.email}) permanently. Other staff and Admins won&apos;t see it in menus, links,
          searches, reports or exports. After this, access follows your account — not your email address — and only you can share it.
        </p>
        <ActionForm action={claimOwnerAction} className="mt-4 space-y-3" showSuccess={false}>
          <Field label="Confirm your password"><input className="input" type="password" name="password" required autoComplete="current-password" /></Field>
          <Button type="submit">Link the Owner&apos;s Office to my account</Button>
        </ActionForm>
      </Card>
    </>
  );
}
