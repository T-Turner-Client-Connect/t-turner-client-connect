import Link from "next/link";
import { FolderLock } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { BenefitStrip, CategorySidebar, DocumentsTable, isVaultCat, UploadPanel, VAULT_CATEGORIES, vaultData, VaultReminders, type VaultCat } from "@/components/portal/vault-page";
import { portalUploadAction } from "@/app/actions/portal";
import { allowedCategories } from "@/lib/portal/access";
import { isPortalVerified, vaultYears } from "@/lib/services/tax-center";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalDocuments } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { portalIdentityOverview } from "@/lib/services/identity";
import { prisma } from "@/lib/prisma";
import { UploadReceipt } from "@/components/portal/upload-receipt";
import { scanConfigured } from "@/lib/scan";

export const metadata = { title: "Document Vault" };

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string; year?: string; upload?: string; cat?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const verified = await isPortalVerified(user.id);
  const yearFilter = sp.year === "none" ? ("none" as const) : Number(sp.year) || null;
  const cat: VaultCat = isVaultCat(sp.cat) ? sp.cat : "all";
  const [docs, folders, overview] = await Promise.all([
    loadPortalDocuments(current.clientId, current, { year: yearFilter, includeHistorical: verified }),
    vaultYears(current.clientId, allowedCategories(current)),
    // Identity records appear as status-only rows; they open from Identity Documents.
    current.canViewIdentity ? portalIdentityOverview(user, current.clientId) : Promise.resolve(null),
  ]);
  // Identity records have no tax year, so a year filter shows yearly documents only.
  const data = vaultData(docs, yearFilter ? null : overview);
  const q = `?account=${current.clientId}`;
  const href = (c: VaultCat, y: string | null = yearFilter ? String(yearFilter) : null) => `/client/documents${q}${c !== "all" ? `&cat=${c}` : ""}${y ? `&year=${y}` : ""}`;
  // The client's own recent uploads, including ones still being checked.
  const mine = current.canUpload
    ? await prisma.document.findMany({
        where: { clientId: current.clientId, uploadedByPortalId: user.id, deletedAt: null, category: { not: "IDENTITY" } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, docType: true, year: true, month: true, reportPeriodType: true, periodStart: true, periodEnd: true, scanStatus: true, scanAttempts: true, lastScanError: true, needsReview: true, createdAt: true, file: { select: { originalName: true } } },
      })
    : [];
  const thisYear = new Date().getFullYear();
  const linkFor = (id: string) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`;
  return (
    <>
      <PageBanner icon={FolderLock} title="Document Vault" subtitle="Your documents by tax year — private to you and T. Turner & Associates." />
      <div className="space-y-6">
        <BenefitStrip />
        {!verified && (
          <Notice tone="info" title="Past-year records are locked until your account is verified">
            Records from {thisYear - 2} and earlier open after you verify your account. <Link className="underline" href={`/client/taxes/filings${q}`}>Verify now</Link>.
          </Notice>
        )}
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[16rem_minmax(0,1fr)_22rem]">
          <CategorySidebar data={data} active={cat} href={(c) => href(c)} />
          <DocumentsTable
            rows={data[cat]}
            title={VAULT_CATEGORIES.find((c) => c.key === cat)!.label}
            years={folders}
            year={yearFilter}
            yearHref={(y) => href(cat, y)}
            linkFor={linkFor}
            identityHref={`/client/identity${q}`}
          />
          <div className="grid gap-6 lg:col-span-2 lg:grid-cols-2 2xl:col-span-1 2xl:grid-cols-1">
            {current.canUpload && (
              <UploadPanel
                action={portalUploadAction.bind(null, current.clientId)}
                accountName={current.client.businessName || current.client.displayName}
                defaultYear={Number(sp.upload) >= thisYear - 7 && Number(sp.upload) <= thisYear ? String(sp.upload) : ""}
              >
                {mine.length > 0 && (
                  <div className="mt-5 border-t border-ivory-200 pt-4">
                    <p className="mb-1 font-semibold text-navy-900">Recently sent</p>
                    <ul className="divide-y divide-navy-100 text-sm" data-testid="my-uploads">
                      {mine.map((d) => (
                        <li key={d.id} className="py-2">
                          <UploadReceipt d={d} scannerConfigured={scanConfigured()} />
                          {d.scanStatus === "CLEAN" && <span className="text-xs text-slate-600">{d.needsReview ? "Waiting for our review" : "Reviewed by our office"}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </UploadPanel>
            )}
            <VaultReminders />
          </div>
        </div>
      </div>
    </>
  );
}
