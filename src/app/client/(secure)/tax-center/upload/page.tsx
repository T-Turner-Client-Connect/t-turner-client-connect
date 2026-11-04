import Link from "next/link";
import { CloudUpload } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { TaxUploadForm } from "@/components/portal/tax-upload-form";
import { requirePortalUser } from "@/lib/portal/session";
import { requirePersonalTaxAccount, resolveAccount } from "@/lib/portal/account";
import { questionnaireYears } from "@/lib/services/tax-center";

export const metadata = { title: "Upload Documents" };

export default async function TaxUpload({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  await requirePersonalTaxAccount(current.clientId);
  const q = `?account=${current.clientId}`;
  const years = questionnaireYears();
  const thisYear = years[0];
  // Older years can still be uploaded to; the four recent years are listed first.
  const all = [...years, ...Array.from({ length: 6 }, (_, i) => thisYear - 4 - i)];
  const defaultYear = sp.year === "unsure" ? "unsure" : all.includes(Number(sp.year)) ? String(Number(sp.year)) : String(thisYear - 1);
  return (
    <>
      <PageBanner icon={CloudUpload} title="Upload Documents" subtitle="Securely send your tax documents to our office for the year you choose." />
      {!current.canUpload ? (
        <Notice tone="warn" title="Uploading isn't included in your access to this account">Ask the account owner, or <Link className="underline" href={`/client/messages${q}`}>message our office</Link> and we&apos;ll help.</Notice>
      ) : (
        <TaxUploadForm account={current.clientId} years={all} defaultYear={defaultYear} vaultHref={`/client/documents${q}`} />
      )}
    </>
  );
}
