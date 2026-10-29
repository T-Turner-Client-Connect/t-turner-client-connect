import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { PortalDocumentsView } from "@/components/portal/documents-view";
import { portalUploadAction } from "@/app/actions/portal";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalDocuments } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";

export const metadata = { title: "Documents" };

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const docs = await loadPortalDocuments(current.clientId, current);
  return (
    <>
      <PageHeader title="Documents" subtitle="Private to you and T. Turner & Associates. Links expire shortly after the page loads." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><PortalDocumentsView docs={docs} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} /></div>
        {current.canUpload && (
          <Card title="Send us a document">
            <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess>
              <Field label="File" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
              <Field label="What is it?"><input className="input" name="title" placeholder="e.g. 1099-NEC from Acme" /></Field>
              <Button type="submit">Upload securely</Button>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
