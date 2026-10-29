import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { createCampaignAction } from "@/app/actions/campaigns";
import { requireUser } from "@/lib/auth/session";
import { PURPOSE_LABELS } from "@/lib/consent";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="New campaign" subtitle="Start a draft. Nothing is sent from a draft." />
      <Card className="max-w-2xl">
        <ActionForm action={createCampaignAction} className="space-y-4" showSuccess={false}>
          <Field label="Campaign title" hint="Only staff see this.">
            <input className="input" name="title" required maxLength={150} placeholder="e.g. 2026 tax season kickoff" />
          </Field>
          <Field label="Purpose" hint="Decides who is eligible. Promotions need documented marketing permission.">
            <select className="input" name="purpose" defaultValue="SERVICE">
              {Object.entries(PURPOSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Send by">
            <select className="input" name="channel" defaultValue="EMAIL">
              <option value="EMAIL">Email</option>
              <option value="SMS">Text message</option>
              <option value="BOTH">Both email and text</option>
            </select>
          </Field>
          <Button type="submit">Create draft</Button>
        </ActionForm>
      </Card>
    </>
  );
}
