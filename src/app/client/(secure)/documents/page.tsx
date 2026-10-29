import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { PortalDocumentsView } from "@/components/portal/documents-view";
import { portalUploadAction } from "@/app/actions/portal";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalDocuments } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { prisma } from "@/lib/prisma";
import { SCAN_LABELS } from "@/lib/scan-labels";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Documents" };

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const docs = await loadPortalDocuments(current.clientId, current);
  // The client's own recent uploads, including ones still being checked.
  const mine = await prisma.document.findMany({
    where: { clientId: current.clientId, uploadedByPortalId: user.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, title: true, year: true, scanStatus: true, needsReview: true, createdAt: true },
  });
  const thisYear = new Date().getFullYear();
  return (
    <>
      <PageHeader title="Documents" subtitle="Private to you and TTurner & Associates Group. Links expire shortly after the page loads." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><PortalDocumentsView docs={docs} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} /></div>
        {current.canUpload && (
          <Card title="Send us a document">
            <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess>
              <Field label="File" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
              <Field label="What is it?"><input className="input" name="title" placeholder="e.g. 1099-NEC from Acme" /></Field>
              <Field label="Tax year this is for">
                <select className="input" name="year" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
                  <option value="unsure">Not sure</option>
                </select>
              </Field>
              <Button type="submit">Upload securely</Button>
            </ActionForm>
          </Card>
        )}
        {mine.length > 0 && (
          <Card title="Your recent uploads" className="lg:col-span-3">
            <ul className="divide-y divide-navy-100 text-sm" data-testid="my-uploads">
              {mine.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{d.title} · {d.year ?? "year to be confirmed"} · {fmtDateTime(d.createdAt)}</span>
                  <span className="text-slate-700">
                    {SCAN_LABELS[d.scanStatus].client}
                    {d.scanStatus === "CLEAN" && (d.needsReview ? " · waiting for our review" : " · reviewed")}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
