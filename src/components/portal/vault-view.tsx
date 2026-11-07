import Link from "next/link";
import { FolderLock } from "lucide-react";
import { PageBanner } from "@/components/portal/luxury";
import { BenefitStrip, BUSINESS_VAULT_CATEGORIES, businessVaultData, CategorySidebar, DocumentsTable, UploadPanel, vaultData, VaultReminders, type BusinessVaultCat, type VaultCat } from "@/components/portal/vault-page";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Notice } from "@/components/ui";
import type { loadPortalDocuments } from "@/lib/portal/views";
import type { identityOverviewForViewer } from "@/lib/services/identity";

type FormAction = (prev: { error?: string; ok?: string; at?: number } | null, fd: FormData) => Promise<{ error?: string; ok?: string; at?: number } | null>;

export type VaultPageData = {
  docs: Awaited<ReturnType<typeof loadPortalDocuments>>;
  folders: { year: number | null; count: number }[];
  overview: Awaited<ReturnType<typeof identityOverviewForViewer>> | null;
  verified: boolean;
  businessOnly: boolean;
  services: string[];
  types: string[];
  ownerRequestCount: number;
  perms: { canUpload: boolean; canViewPayroll: boolean; canUploadPayroll: boolean };
};

/**
 * Document Vault, shared by the client's own page and View as Client. The page passes the data,
 * its links (`hrefFor` builds a client-page link, so the preview stays in the preview) and the
 * upload action: the portal's own, or the preview stand-in with `readOnly` (disabled, with a note).
 */
export function VaultPageView({
  data,
  cat,
  bizCat,
  yearFilter,
  uploadYear,
  hrefFor,
  linkFor,
  upload,
  readOnly,
}: {
  data: VaultPageData;
  cat: VaultCat;
  bizCat: BusinessVaultCat;
  yearFilter: number | "none" | null;
  uploadYear: string;
  /** A client page path (e.g. "/client/documents") plus query (without "?"). */
  hrefFor: (path: string, query?: string) => string;
  linkFor: (id: string) => string;
  upload: FormAction;
  readOnly?: boolean;
}) {
  const { docs, folders, overview, verified, businessOnly, services, types, perms } = data;
  // Identity records have no tax year, so a year filter shows yearly documents only.
  const vault = vaultData(docs, yearFilter ? null : overview);
  const href = (c: string, y: string | null = yearFilter ? String(yearFilter) : null) =>
    hrefFor("/client/documents", [c !== "all" ? `cat=${c}` : "", y ? `year=${y}` : ""].filter(Boolean).join("&"));
  // A business-only account: the owner's categories (Business Tax, Personal Tax, Payroll, K-1, Other).
  // Payroll shows when payroll applies to this business and this login may see payroll.
  const biz = businessOnly ? businessVaultData(docs) : null;
  const payrollApplies = perms.canViewPayroll && ((biz?.payroll.length ?? 0) > 0 || services.some((x) => x.trim().toLowerCase() === "payroll") || types.includes("PAYROLL"));
  const bizCategories = BUSINESS_VAULT_CATEGORIES.filter((c) => c.key !== "payroll" || payrollApplies);
  const thisYear = new Date().getFullYear();
  return (
    <>
      <PageBanner icon={FolderLock} title="Document Vault" subtitle="Your secure, year-round storage for tax documents, IDs, and important records." />
      <div className="space-y-6" data-testid="document-vault">
        <BenefitStrip />
        {!verified && (
          <Notice tone="info" title="Past-year records are locked until your account is verified">
            Records from {thisYear - 2} and earlier open after you verify your account. <Link className="underline" href={hrefFor("/client/taxes/filings")}>Verify now</Link>.
          </Notice>
        )}
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)] 2xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
          {biz ? <CategorySidebar active={bizCat} href={(c) => href(c)} categories={bizCategories} /> : <CategorySidebar active={cat} href={(c) => href(c)} />}
          <DocumentsTable rows={biz ? biz[bizCat === "payroll" && !payrollApplies ? "all" : bizCat] : vault[cat]} years={folders} year={yearFilter} yearHref={(y) => href(cat, y)} linkFor={linkFor} identityHref={hrefFor("/client/identity")} uploadHref={hrefFor("/client/tax-center/upload")} />
          <div className="grid grid-cols-1 gap-5 lg:col-span-2 lg:grid-cols-2 2xl:col-span-1 2xl:grid-cols-1">
            {perms.canUpload && <UploadPanel action={upload} defaultYear={uploadYear} readOnly={readOnly} />}
            {businessOnly && (
              <section className="rounded-2xl border border-gold-200 bg-white p-4" data-testid="personal-docs-panel">
                <h2 className="mb-1 font-serif text-lg font-bold text-navy-900">Your personal tax documents</h2>
                <p className="text-sm text-navy-800">W-2s, 1099s, 1098, property taxes, car tags, donations and other personal items, by tax year. Only you and our office can see them — never the business&apos;s other owners.</p>
                {data.ownerRequestCount > 0 && <p className="mt-2 text-sm font-semibold text-gold-800" data-testid="owner-requests-count">{data.ownerRequestCount} requested from you</p>}
                <Link href={hrefFor("/client/tax-center/upload")} className="mt-3 inline-flex rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="personal-upload-link">Send personal tax documents</Link>
              </section>
            )}
            {businessOnly && perms.canViewPayroll && perms.canUploadPayroll && (
              <section className="rounded-2xl border border-gold-200 bg-white p-4" data-testid="payroll-upload">
                <h2 className="mb-2 font-serif text-lg font-bold text-navy-900">Send a payroll file</h2>
                <PreviewDisabled readOnly={readOnly}>
                  <ActionForm action={upload} className="space-y-2" resetOnSuccess>
                    <input type="hidden" name="payroll" value="1" />
                    <Field label="Description (optional)"><input className="input" name="title" maxLength={200} placeholder="e.g. October payroll register" /></Field>
                    <Field label="Year"><select className="input" name="year" defaultValue={String(thisYear)}>{[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
                    <Field label="File"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
                    <Button type="submit">Upload payroll file</Button>
                  </ActionForm>
                </PreviewDisabled>
              </section>
            )}
            <VaultReminders />
          </div>
        </div>
      </div>
    </>
  );
}
