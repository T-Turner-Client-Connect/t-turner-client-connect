import Link from "next/link";
import { Notice, PageHeader } from "@/components/ui";
import { JotformFrame } from "@/components/portal/jotform-frame";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { questionnaireLink } from "@/lib/services/tax-center";
import { recordQuestionnaireOpened } from "@/lib/services/questionnaire-intake";

export const metadata = { title: "Tax questionnaire" };

/**
 * The client's own questionnaire, shown inside Client Connect. The form link
 * carries the signed client + year reference, so the submission is linked to
 * this account automatically. A new-tab link is always offered as a fallback.
 */
export default async function QuestionnairePage({ params, searchParams }: { params: Promise<{ year: string }>; searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { year } = await params;
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const taxYear = Number(year);
  let url: string | null = null;
  try {
    url = await questionnaireLink(user, current.clientId, taxYear);
  } catch {
    url = null;
  }
  const back = `/client/tax-center?account=${current.clientId}`;
  if (!url) return <><PageHeader title={`${year} tax questionnaire`} /><Notice>The {year} questionnaire isn&apos;t available yet. <Link className="underline" href={back}>Back to My Tax Center</Link></Notice></>;
  await recordQuestionnaireOpened(current.clientId, taxYear);
  const fallback = `/client/questionnaire/${taxYear}?c=${encodeURIComponent(current.clientId)}`;
  return (
    <>
      <PageHeader title={`${year} tax questionnaire`} subtitle="Your answers go straight to our office and are linked to your account automatically." />
      <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link className="underline" href={back}>← My Tax Center</Link>
        <a className="underline" href={fallback} target="_blank" rel="noopener noreferrer" data-testid="q-newtab">Trouble seeing the form? Open it in a new tab</a>
      </p>
      <JotformFrame src={url} title={`${year} tax questionnaire`} />
    </>
  );
}
