import { ActionForm } from "@/components/action-form";
import { Button, Notice, PageHeader } from "@/components/ui";
import { PortalTaxesView } from "@/components/portal/taxes-view";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { portalUploadAction } from "@/app/actions/portal";
import { portalExplainAction } from "@/app/actions/ask-client";
import { portalViewer } from "@/lib/portal/viewer";
import { loadPortalTaxes } from "@/lib/portal/tax-view";

export const metadata = { title: "Taxes" };

export default async function PortalTaxes({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("taxes", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const data = await loadPortalTaxes(current.clientId, user?.id ?? null);
  // Every question is answered right here: upload the file, type the answer, or both.
  const answer = (r: { id: string; title: string; clientExplanation: string | null }) =>
    current.canUpload ? (
      <PreviewDisabled readOnly={v.readOnly}>
        <ActionForm action={v.act(portalUploadAction, current.clientId)} className="mt-1 flex flex-wrap items-center gap-2" resetOnSuccess>
          <input type="hidden" name="requestId" value={r.id} />
          <input className="input max-w-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={`Upload for ${r.title}`} />
          <Button type="submit" variant="secondary">Upload</Button>
        </ActionForm>
        <ActionForm action={v.act(portalExplainAction, current.clientId, r.id)} className="mt-2 space-y-2">
          <label className="block text-xs font-semibold text-navy-700">
            {r.clientExplanation ? "Your answer (you can update it)" : "Or type your answer"}
            <textarea name="explanation" className="input mt-1 w-full" rows={2} maxLength={4000} required defaultValue={r.clientExplanation ?? ""} aria-label={`Answer for ${r.title}`} />
          </label>
          <Button type="submit" variant="secondary">Send answer</Button>
        </ActionForm>
      </PreviewDisabled>
    ) : null;
  return (
    <>
      <PageHeader title="Taxes" subtitle="Each filing is listed separately — federal and state, extensions and amendments." />
      <PortalTaxesView data={data} linkFor={v.linkFor} answer={answer} />
    </>
  );
}
