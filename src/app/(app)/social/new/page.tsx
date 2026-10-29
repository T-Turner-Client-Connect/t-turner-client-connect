import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { createSocialAction } from "@/app/actions/social";
import { requireUser } from "@/lib/auth/session";

export const metadata = { title: "Create post" };

export default async function NewSocialPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Create a social post" />
      <Card className="max-w-xl">
        <ActionForm action={createSocialAction} className="space-y-4" showSuccess={false}>
          <Field label="Working title" hint="Only staff see this."><input className="input" name="title" required placeholder="e.g. Tax season kickoff" /></Field>
          <Button type="submit">Start draft</Button>
        </ActionForm>
      </Card>
    </>
  );
}
