import Link from "next/link";
import { Notice, PageHeader } from "@/components/ui";
import { TaxUploadForm } from "@/components/portal/tax-upload-form";
import { CLIENT_DOC_TYPES } from "@/lib/document-types";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { questionnaireYears } from "@/lib/services/tax-center";

export const metadata = { title: "Upload Documents" };

export default async function TaxUpload({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const years = questionnaireYears();
  const thisYear = years[0];
  // Older years can still be uploaded to; the four recent years are listed first.
  const all = [...years, ...Array.from({ length: 6 }, (_, i) => thisYear - 4 - i)];
  const defaultYear = sp.year === "unsure" ? "unsure" : all.includes(Number(sp.year)) ? String(Number(sp.year)) : String(thisYear - 1);
  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href={`/client/tax-center${q}`}>← My Tax Center</Link></p>
      <PageHeader title="Upload Documents" subtitle={`For ${current.client.businessName || current.client.displayName}. Files go into your secure Document Vault for the year you choose.`} />
      {!current.canUpload ? (
        <Notice tone="warn" title="Uploading isn't included in your access to this account">Ask the account owner, or <Link className="underline" href={`/client/messages${q}`}>message our office</Link> and we&apos;ll help.</Notice>
      ) : (
        <div className="max-w-xl rounded-2xl border border-ivory-200 bg-white p-5 shadow-sm">
          <TaxUploadForm account={current.clientId} years={all} defaultYear={defaultYear} categories={CLIENT_DOC_TYPES} vaultHref={`/client/documents${q}`} />
          <p className="mt-4 text-xs text-slate-600">Every file is checked for viruses before anyone can open it. Got a letter from the IRS, the state or a city? Use <Link className="underline" href={`/client/tax-center/notice${q}`}>Upload Audit or Tax Notice</Link> so we can track its deadline.</p>
        </div>
      )}
    </>
  );
}
