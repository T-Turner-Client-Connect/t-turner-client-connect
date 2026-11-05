import Link from "next/link";
import { CloudUpload } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { TaxUploadForm } from "@/components/portal/tax-upload-form";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { questionnaireYears } from "@/lib/services/tax-center";
import { serviceProfile } from "@/lib/services/service-profile";
import { myOwnerRequests, ownerForLogin } from "@/lib/services/owner-personal-docs";
import { ID_TYPES } from "@/lib/services/identity";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { portalUploadAction } from "@/app/actions/portal";

export const metadata = { title: "Upload Documents" };

export default async function TaxUpload({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  // A business-only account (no personal tax preparation) uses this page for each owner's own
  // personal supporting documents: filed privately to that owner and a tax year. This never adds
  // personal tax preparation; Tax Summary, refunds and the questionnaire stay closed to it.
  const { businessOnly } = await serviceProfile(current.clientId);
  const requests = businessOnly ? await myOwnerRequests(user, current.clientId) : [];
  // A business owner may send their own personal documents even without upload access to the business's files.
  const canSend = current.canUpload || (businessOnly && !!(await ownerForLogin(current.clientId, user.id)));
  const q = `?account=${current.clientId}`;
  const years = questionnaireYears();
  const thisYear = years[0];
  // Older years can still be uploaded to; the four recent years are listed first.
  const all = [...years, ...Array.from({ length: 6 }, (_, i) => thisYear - 4 - i)];
  const defaultYear = sp.year === "unsure" && !businessOnly ? "unsure" : all.includes(Number(sp.year)) ? String(Number(sp.year)) : String(thisYear - 1);
  return (
    <>
      <PageBanner icon={CloudUpload} title={businessOnly ? "Personal Tax Documents" : "Upload Documents"} subtitle={businessOnly ? "Send your own personal tax documents (W-2s, 1099s, 1098, property taxes, car tags, donations…) for the tax year you choose. Only you and our office can see them — never the business's other owners." : "Securely send your tax documents to our office for the year you choose."} />
      {businessOnly && requests.length > 0 && (
        <section className="mb-6 rounded-2xl border border-gold-300 bg-white p-4" data-testid="owner-requests">
          <h2 className="font-serif text-lg font-bold text-navy-900">Requested from you</h2>
          <ul className="mt-2 divide-y divide-ivory-200">
            {requests.map((r) => (
              <li key={r.id} className="py-3" data-testid="owner-request" data-status={r.status}>
                <p className="text-sm font-semibold text-navy-900">{r.title}{r.taxYear ? <span className="font-normal text-slate-600"> · {r.taxYear}</span> : null}</p>
                {r.instructions && <p className="text-xs text-slate-600">{r.instructions}</p>}
                {r.status === "SUBMITTED" ? (
                  <p className="mt-1 text-xs font-semibold text-emerald-700">Received — thank you.</p>
                ) : r.docType && r.docType in ID_TYPES ? (
                  <Link className="mt-1 inline-block text-sm font-semibold text-navy-900 underline decoration-gold-500" href={`/client/identity${q}`} data-testid="owner-request-identity">Provide it securely in Identity Documents</Link>
                ) : canSend ? (
                  <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="mt-2 flex flex-wrap items-center gap-2" resetOnSuccess>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input className="input max-w-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={`File for ${r.title}`} />
                    <Button type="submit">Send securely</Button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!canSend ? (
        <Notice tone="warn" title="Uploading isn't included in your access to this account">Ask the account owner, or <Link className="underline" href={`/client/messages${q}`}>message our office</Link> and we&apos;ll help.</Notice>
      ) : (
        <TaxUploadForm account={current.clientId} years={all} defaultYear={defaultYear} vaultHref={`/client/documents${q}${businessOnly ? "&cat=personal-tax" : ""}`} owner={businessOnly} />
      )}
    </>
  );
}
