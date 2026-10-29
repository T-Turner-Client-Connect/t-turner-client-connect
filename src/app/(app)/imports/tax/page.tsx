import Link from "next/link";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { TaxImportWizard } from "@/components/tax-import-wizard";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Import e-file statuses" };

export default async function TaxImportPage() {
  await requireUser();
  const batches = await prisma.taxImportBatch.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  return (
    <>
      <PageHeader title="Import TaxAct e-file statuses" subtitle="Staff-controlled import from a TaxAct export. Nothing updates until you review and confirm." />
      <div className="mb-5">
        <Notice title="How to export from TaxAct Professional">
          In your TaxAct Account (Practice Manager) or Professional software, open <strong>Reports → E-file Details</strong>, filter by tax year and status, then click the Excel icon to save a
          CSV. Include a client ID column (TaxAct client ID) so filings match reliably. No direct TaxAct connection exists in this app — this import is the supported path.
        </Notice>
      </div>
      <TaxImportWizard />
      {batches.length > 0 && (
        <Card title="Previous imports" className="mt-6">
          <ul className="divide-y divide-ivory-200 text-sm">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap justify-between gap-2 py-2">
                <Link className="underline" href={`/imports/tax/${b.id}`}>{b.fileName}</Link>
                <span className="flex items-center gap-2">
                  <Badge tone={b.status === "COMMITTED" ? "green" : b.status === "REVIEW" ? "gold" : "gray"}>{b.status === "COMMITTED" ? `${b.appliedCount} applied` : b.status.toLowerCase()}</Badge>
                  <span className="text-slate-600">{fmtDateTime(b.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
