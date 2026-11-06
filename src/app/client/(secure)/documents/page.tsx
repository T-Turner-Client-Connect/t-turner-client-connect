import Link from "next/link";
import { FolderLock } from "lucide-react";
import { PageBanner } from "@/components/portal/luxury";
import { BenefitStrip, BUSINESS_VAULT_CATEGORIES, businessVaultData, CategorySidebar, DocumentsTable, isBusinessVaultCat, isVaultCat, UploadPanel, vaultData, VaultReminders, type BusinessVaultCat, type VaultCat } from "@/components/portal/vault-page";
import { myOwnerRequests } from "@/lib/services/owner-personal-docs";
import { portalUploadAction } from "@/app/actions/portal";
import { portalDocumentScope } from "@/lib/portal/access";
import { isPortalVerified, vaultYears } from "@/lib/services/tax-center";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalDocuments } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { portalIdentityOverview } from "@/lib/services/identity";
import { serviceProfile } from "@/lib/services/service-profile";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";

export const metadata = { title: "Document Vault" };

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string; year?: string; upload?: string; cat?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const verified = await isPortalVerified(user.id);
  const yearFilter = sp.year === "none" ? ("none" as const) : Number(sp.year) || null;
  const cat: VaultCat = isVaultCat(sp.cat) ? sp.cat : "all";
  const { businessOnly, business, services, types } = await serviceProfile(current.clientId);
  const bizCat: BusinessVaultCat = isBusinessVaultCat(sp.cat) ? sp.cat : "all";
  const [docs, folders, overview] = await Promise.all([
    loadPortalDocuments(current.clientId, current, { year: yearFilter, includeHistorical: verified, viewer: user.id }),
    vaultYears(current.clientId, portalDocumentScope(current, user.id)),
    // Identity records appear as status-only rows; they open from Identity Documents.
    // Business accounts: only this login's own owner record.
    (current.canViewIdentity || business) && !businessOnly ? portalIdentityOverview(user, current.clientId) : Promise.resolve(null),
  ]);
  // Identity records have no tax year, so a year filter shows yearly documents only.
  const data = vaultData(docs, yearFilter ? null : overview);
  const q = `?account=${current.clientId}`;
  const href = (c: string, y: string | null = yearFilter ? String(yearFilter) : null) => `/client/documents${q}${c !== "all" ? `&cat=${c}` : ""}${y ? `&year=${y}` : ""}`;
  // A business-only account: the owner's categories (Business Tax, Personal Tax, Payroll, K-1, Other).
  // Payroll shows when payroll applies to this business and this login may see payroll.
  const biz = businessOnly ? businessVaultData(docs) : null;
  const payrollApplies = current.canViewPayroll && ((biz?.payroll.length ?? 0) > 0 || services.some((x) => x.trim().toLowerCase() === "payroll") || types.includes("PAYROLL"));
  const bizCategories = BUSINESS_VAULT_CATEGORIES.filter((c) => c.key !== "payroll" || payrollApplies);
  const ownerRequests = businessOnly ? (await myOwnerRequests(user, current.clientId)).filter((r) => r.status === "OPEN") : [];
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
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
          {biz ? <CategorySidebar active={bizCat} href={(c) => href(c)} categories={bizCategories} /> : <CategorySidebar active={cat} href={(c) => href(c)} />}
          <DocumentsTable rows={biz ? biz[bizCat === "payroll" && !payrollApplies ? "all" : bizCat] : data[cat]} years={folders} year={yearFilter} yearHref={(y) => href(cat, y)} linkFor={linkFor} identityHref={`/client/identity${q}`} />
          <div className="grid grid-cols-1 gap-5 lg:col-span-2 lg:grid-cols-2 2xl:col-span-1 2xl:grid-cols-1">
            {current.canUpload && (
              <UploadPanel
                action={portalUploadAction.bind(null, current.clientId)}
                defaultYear={Number(sp.upload) >= thisYear - 7 && Number(sp.upload) <= thisYear ? String(sp.upload) : ""}
              />
            )}
            {businessOnly && (
              <section className="rounded-2xl border border-gold-200 bg-white p-4" data-testid="personal-docs-panel">
                <h2 className="mb-1 font-serif text-lg font-bold text-navy-900">Your personal tax documents</h2>
                <p className="text-sm text-navy-800">W-2s, 1099s, 1098, property taxes, car tags, donations and other personal items, by tax year. Only you and our office can see them — never the business&apos;s other owners.</p>
                {ownerRequests.length > 0 && <p className="mt-2 text-sm font-semibold text-gold-800" data-testid="owner-requests-count">{ownerRequests.length} requested from you</p>}
                <Link href={`/client/tax-center/upload${q}`} className="mt-3 inline-flex rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="personal-upload-link">Send personal tax documents</Link>
              </section>
            )}
            {businessOnly && current.canViewPayroll && current.canUploadPayroll && (
              <section className="rounded-2xl border border-gold-200 bg-white p-4" data-testid="payroll-upload">
                <h2 className="mb-2 font-serif text-lg font-bold text-navy-900">Send a payroll file</h2>
                <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="space-y-2" resetOnSuccess>
                  <input type="hidden" name="payroll" value="1" />
                  <Field label="Description (optional)"><input className="input" name="title" maxLength={200} placeholder="e.g. October payroll register" /></Field>
                  <Field label="Year"><select className="input" name="year" defaultValue={String(thisYear)}>{[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
                  <Field label="File"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
                  <Button type="submit">Upload payroll file</Button>
                </ActionForm>
              </section>
            )}
            <VaultReminders />

          </div>
        </div>
      </div>
    </>
  );
}
