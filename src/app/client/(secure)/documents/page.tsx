import { isBusinessVaultCat, isVaultCat, type BusinessVaultCat, type VaultCat } from "@/components/portal/vault-page";
import { VaultPageView } from "@/components/portal/vault-view";
import { myOwnerRequests } from "@/lib/services/owner-personal-docs";
import { portalUploadAction } from "@/app/actions/portal";
import { portalDocumentScope } from "@/lib/portal/access";
import { isPortalVerified, vaultYears } from "@/lib/services/tax-center";
import { portalViewer } from "@/lib/portal/viewer";
import { loadPortalDocuments } from "@/lib/portal/views";
import { identityOverviewForViewer, portalIdentityOverview } from "@/lib/services/identity";
import { serviceProfile } from "@/lib/services/service-profile";

export const metadata = { title: "Document Vault" };

export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ account?: string; year?: string; upload?: string; cat?: string }> }) {
  const sp = await searchParams;
  const v = await portalViewer("documents", sp.account);
  const { user, current } = v;
  if (!current) return null;
  // View as Client with no portal login: no login to verify, so past-year records show as staff see them published.
  const verified = user ? await isPortalVerified(user.id) : true;
  const yearFilter = sp.year === "none" ? ("none" as const) : Number(sp.year) || null;
  const cat: VaultCat = isVaultCat(sp.cat) ? sp.cat : "all";
  const { businessOnly, business, services, types } = await serviceProfile(current.clientId);
  const bizCat: BusinessVaultCat = isBusinessVaultCat(sp.cat) ? sp.cat : "all";
  const [docs, folders, overview] = await Promise.all([
    loadPortalDocuments(current.clientId, current, { year: yearFilter, includeHistorical: verified, viewer: user?.id ?? null }),
    vaultYears(current.clientId, portalDocumentScope(current, user?.id ?? null)),
    // Identity records appear as status-only rows; they open from Identity Documents.
    // Business accounts: only this login's own owner record.
    (current.canViewIdentity || business) && !businessOnly ? (user ? portalIdentityOverview(user, current.clientId) : identityOverviewForViewer(current.clientId, null)) : Promise.resolve(null),
  ]);
  const ownerRequestCount = businessOnly && user ? (await myOwnerRequests(user, current.clientId)).filter((r) => r.status === "OPEN").length : 0;
  const thisYear = new Date().getFullYear();
  const q = `account=${current.clientId}`;
  return (
    <VaultPageView
      data={{ docs, folders, overview, verified, businessOnly, services, types, ownerRequestCount, perms: current }}
      cat={cat}
      bizCat={bizCat}
      yearFilter={yearFilter}
      uploadYear={Number(sp.upload) >= thisYear - 7 && Number(sp.upload) <= thisYear ? String(sp.upload) : ""}
      hrefFor={(path, query) => `${path}?${q}${query ? `&${query}` : ""}`}
      linkFor={v.linkFor}
      upload={v.act(portalUploadAction, current.clientId)}
      readOnly={v.readOnly}
    />
  );
}
