import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { PortalHomeView } from "@/components/portal/home-view";
import { businessHomeTiles } from "@/components/portal/business-home-view";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import { portalViewer } from "@/lib/portal/viewer";
import { loadPortalHome } from "@/lib/portal/views";
import { loadGreetingName } from "@/lib/portal/greeting";
import { businessDashboardFor, homeKind, portalBusinessDashboard } from "@/lib/services/portal-business";
import { splitFlyer } from "@/lib/news/flyers";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Client portal" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ account?: string; year?: string; month?: string }> }) {
  const sp = await searchParams;
  const v = await portalViewer("home", sp.account);
  const { user, accounts, current, linkFor, readOnly } = v;
  if (!current) return <Notice title="No accounts yet">Your login isn&apos;t connected to an account right now. Please contact our office.</Notice>;
  // One sign-in, Personal and Business: an owner of an approved Managed Business lands on its dashboard.
  // (Regular tax clients have no such account, so their Home is unchanged.)
  if (!sp.account) {
    const business = accounts.find((a) => homeKind(a) === "BUSINESS");
    if (business) redirect(`/client?account=${business.clientId}`);
  }
  const q = `?account=${current.clientId}`;
  const data = await loadPortalHome(current.clientId, current, user?.id ?? null);

  if (homeKind(current) === "BUSINESS") {
    // View as Client: the same dashboard, built from the grant in view (the login's own flags, with
    // the staff member's billing permission applied) — or the client's records when there's no login.
    const d = user && !readOnly
      ? await portalBusinessDashboard(user, current.clientId, sp.month)
      : await businessDashboardFor(current.clientId, sp.month, { canUpload: current.canUpload, canMessage: current.canMessage, canViewBilling: current.canViewBilling }, user ? ((await prisma.portalUser.findUnique({ where: { id: user.id }, select: { preferredState: true } }))?.preferredState ?? null) : null);
    // The same quick-access tiles as the regular business Home (K-1s open from the Document Vault here).
    const tiles = businessHomeTiles(data, (path) => `${path}${q}`, `/client/documents${q}`, `/client/payroll${q}`);
    // The owner's own (personal) account, for personal tax uploads and identity documents.
    const personal = accounts.find((a) => a.client.clientType === "INDIVIDUAL");
    const news = data.updates.map((a) => { const f = splitFlyer(a.body); return { id: a.id, title: a.title, body: f.text, flyer: f.flyer, topic: a.topic, clientId: a.clientId, pinned: a.pinned, at: a.publishedAt ?? a.createdAt }; });
    return <BusinessDashboardView d={d} tiles={tiles} q={q} base={`/client${q}`} linkFor={linkFor} personalQ={personal ? `?account=${personal.clientId}` : null} news={news} readOnly={readOnly} previewHref={readOnly ? (path, extra) => `${path}${q}${extra ? `&${extra}` : ""}` : undefined} />;
  }

  const name = await loadGreetingName(current.clientId, user?.id ?? null);
  return (
    <PortalHomeView
      data={data}
      q={q}
      clientId={current.clientId}
      name={name ?? undefined}
      accountName={current.client.businessName || current.client.displayName}
      year={Number(sp.year) || undefined}
      linkFor={linkFor}
    />
  );
}
