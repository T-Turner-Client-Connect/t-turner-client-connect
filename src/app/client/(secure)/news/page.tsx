import { NewsAndCountdowns } from "@/components/portal/news-countdowns";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { announcementsForClient, countdownsFor } from "@/lib/services/news";

export const metadata = { title: "News & Tax Countdowns" };

export default async function News({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const [countdowns, news] = await Promise.all([countdownsFor(current.clientId), announcementsForClient(current.clientId)]);
  return (
    <NewsAndCountdowns cards={countdowns.cards} news={news} personalized />
  );
}
