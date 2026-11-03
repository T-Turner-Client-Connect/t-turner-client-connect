import { NewsAndCountdowns } from "@/components/portal/news-countdowns";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { announcementsForClient, countdownsFor } from "@/lib/services/news";

export const metadata = { title: "News & Tax Countdowns" };

export default async function News({ searchParams }: { searchParams: Promise<{ account?: string; all?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const [countdowns, news] = await Promise.all([countdownsFor(current.clientId), announcementsForClient(current.clientId)]);
  return (
    <NewsAndCountdowns cards={countdowns.cards} news={news} personalized showAll={sp.all === "1"} allHref={`/client/news?account=${current.clientId}&all=1`} />
  );
}
