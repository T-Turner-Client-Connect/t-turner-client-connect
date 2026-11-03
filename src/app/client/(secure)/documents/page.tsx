import Link from "next/link";
import { FolderLock } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { BenefitStrip, CategorySidebar, DocumentsTable, isVaultCat, UploadPanel, vaultData, VaultReminders, type VaultCat } from "@/components/portal/vault-page";
import { portalUploadAction } from "@/app/actions/portal";
import { allowedCategories } from "@/lib/portal/access";
import { isPortalVerified, vaultYears } from "@/lib/services/tax-center";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalDocuments } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { portalIdentityOverview } from "@/lib/services/identity";

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
  const thisYear = new Date().getFullYear();
  const linkFor = (id: string) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`;
  return (
    <>
      <PageBanner icon={FolderLock} title="Document Vault" subtitle="Your secure, year-round storage for tax documents, IDs, and important records." />
      <div className="space-y-6">
        <BenefitStrip />
        {!verified && (
          <Notice tone="info" title="Past-year records are locked until your account is verified">
            Records from {thisYear - 2} and earlier open after you verify your account. <Link className="underline" href={`/client/taxes/filings${q}`}>Verify now</Link>.
          </Notice>
        )}
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
          <CategorySidebar active={cat} href={(c) => href(c)} />
          <DocumentsTable rows={data[cat]} years={folders} year={yearFilter} yearHref={(y) => href(cat, y)} linkFor={linkFor} identityHref={`/client/identity${q}`} />
          <div className="grid grid-cols-1 gap-5 lg:col-span-2 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
            {current.canUpload && (
              <UploadPanel
                action={portalUploadAction.bind(null, current.clientId)}
                defaultYear={Number(sp.upload) >= thisYear - 7 && Number(sp.upload) <= thisYear ? String(sp.upload) : ""}
              />
            )}
            <VaultReminders />
          </div>
        </div>
      </div>
    </>
  );
}
