import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { CLIENT_DOC_TYPES } from "@/lib/document-types";
import { allowedCategories } from "@/lib/portal/access";
import { isPortalVerified, vaultYears } from "@/lib/services/tax-center";

const chip = (on: boolean) => `rounded-full px-3 py-1 text-sm font-semibold ${on ? "bg-navy-900 text-gold-300 ring-2 ring-gold-500" : "bg-white text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100"}`;
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

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const verified = await isPortalVerified(user.id);
  const yearFilter = sp.year === "none" ? ("none" as const) : Number(sp.year) || null;
  const [docs, folders] = await Promise.all([
    loadPortalDocuments(current.clientId, current, { year: yearFilter, includeHistorical: verified }),
    vaultYears(current.clientId, allowedCategories(current)),
  ]);
  const q = `?account=${current.clientId}`;
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
      <PageHeader title="Document Vault" subtitle="Your documents by tax year — private to you and TTurner & Associates Group. Links expire shortly after the page loads." />
      <nav aria-label="Vault year" className="mb-4 flex flex-wrap gap-2" data-testid="vault-years">
        <Link href={`/client/documents${q}`} aria-current={!yearFilter ? "page" : undefined} className={chip(!yearFilter)}>All years</Link>
        {folders.map((f) => (
          <Link key={f.year ?? "none"} href={`/client/documents${q}&year=${f.year ?? "none"}`} aria-current={(f.year ?? "none") === yearFilter ? "page" : undefined} className={chip((f.year ?? "none") === yearFilter)}>
            📁 {f.year ?? "Year to confirm"} <span className="opacity-70">({f.count})</span>
          </Link>
        ))}
      </nav>
      {!verified && (
        <div className="mb-4">
          <Notice tone="info" title="Past-year records are locked until your account is verified">
            Records from {thisYear - 2} and earlier open after you verify your account. <Link className="underline" href={`/client/taxes/filings${q}`}>Verify now</Link>.
          </Notice>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><PortalDocumentsView docs={docs} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} /></div>
        {current.canUpload && (
          <Card title="Send us a document">
            <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess>
              <Field label="File" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
              <Field label="Kind of document">
                <select className="input" name="docType" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {Object.entries(CLIENT_DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Short description (optional)"><input className="input" name="title" placeholder="e.g. 1099-NEC from Acme" /></Field>
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
