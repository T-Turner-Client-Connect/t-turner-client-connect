import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import clsx from "clsx";
import { Badge, Card, EmptyState, Notice } from "@/components/ui";
import { PortalHomeView } from "@/components/portal/home-view";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import { businessHomeTiles } from "@/components/portal/business-home-view";
import { BUSINESS_VIEW_CLIENT, hasBusinessView } from "@/lib/portal/access";
import { can } from "@/lib/auth/permissions";
import { businessDashboardFor } from "@/lib/services/portal-business";
import { licensesPageFor, payrollPageFor, yearEndPageFor } from "@/lib/services/portal-business-pages";
import { previewClientInvoicing } from "@/lib/services/portal-client-invoicing";
import { InvoicingPageView, LicensesPageView, NotBusinessNotice, PayrollPageView, YearEndPageView } from "@/components/portal/business-pages";
import { PortalDocumentsView } from "@/components/portal/documents-view";
import { PortalTaxesView } from "@/components/portal/taxes-view";
import { PortalSummaryView } from "@/components/portal/tax-summary-portal";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import {
  loadPortalDocuments,
  loadPortalHome,
  OWNER_PREVIEW_PERMS,
} from "@/lib/portal/views";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { downloadToken } from "@/lib/services/documents";
import { previewSummaries } from "@/lib/services/tax-summary";
import { ID_TYPES, staffIdentityOverview } from "@/lib/services/identity";
import { audit } from "@/lib/audit";
import { loadGreetingName } from "@/lib/portal/greeting";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "View as Client" };

const VIEWS = [
  ["home", "Home"],
  ["summary", "Tax Summary & Approval"],
  ["taxes", "Taxes & Filings"],
  ["documents", "Document Vault"],
  ["messages", "Messages"],
  ["identity", "Identity"],
  // Business view only (the dashboard's Payroll, Licenses, 1099 / W-2 and Client Invoicing cards).
  ["payroll", "Payroll"],
  ["licenses", "Business Licenses"],
  ["year-end", "1099 / W-2"],
  ["invoicing", "Client Invoicing"],
] as const;
const BUSINESS_VIEWS: readonly string[] = ["payroll", "licenses", "year-end", "invoicing"];
type View = (typeof VIEWS)[number][0];

/** Which preview page a client-portal link opens. */
function viewFor(path: string): View {
  if (path.startsWith("/client/taxes/summary")) return "summary";
  if (path.startsWith("/client/taxes") || path.startsWith("/client/tax-center"))
    return "taxes";
  if (path.startsWith("/client/documents")) return "documents";
  if (path.startsWith("/client/messages")) return "messages";
  if (path.startsWith("/client/identity")) return "identity";
  if (path.startsWith("/client/payroll-approval")) return "home";
  if (path.startsWith("/client/payroll")) return "payroll";
  if (path.startsWith("/client/licenses")) return "licenses";
  if (path.startsWith("/client/year-end")) return "year-end";
  if (path.startsWith("/client/invoicing")) return "invoicing";
  return "home";
}

/**
 * View as Client: the client's portal as they see it (owner-level
 * permissions), page by page, read-only. Links move between preview pages;
 * nothing can be uploaded, signed or sent. Every page view is audited.
 */
export default async function PortalPreview({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; year?: string; c?: string; month?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const view: View = (VIEWS.find(([v]) => v === sp.view)?.[0] ??
    "home") as View;
  const client = await prisma.client.findUnique({
    where: { id },
    select: { id: true, displayName: true, businessName: true, ...BUSINESS_VIEW_CLIENT },
  });
  if (!client) notFound();
  // The preview shows what an OWNER login would see, by the portal's own rule: an approved Managed
  // Business or a client on the Bookkeeping Client list gets the business view; a Regular Tax
  // Client never sees the Business side.
  const businessView = hasBusinessView({ role: "OWNER", canViewBookkeeping: true }, client);
  const PREVIEW_PERMS = { ...OWNER_PREVIEW_PERMS, canViewBookkeeping: businessView };
  await audit(prisma, {
    actorId: user.id,
    action: "portal.staff_preview",
    entityType: "Client",
    entityId: id,
    clientId: id,
    details: { view },
  });
  const base = `/clients/${id}/portal-preview`;
  const previewHref = (path: string, extra = "") => {
    const v = viewFor(path);
    const year = /(?:^|&)year=(\d{4})/.exec(extra)?.[1];
    return `${base}?view=${v}${year ? `&year=${year}` : ""}`;
  };
  const linkFor = (docId: string) =>
    `/api/documents/${downloadToken(docId, { staffId: user.id })}`;
  const year = Number(sp.year) || undefined;

  let body: React.ReactNode;
  if (view === "home" && businessView) {
    // The business dashboard, as an owner login of this business sees it (same rule as the portal).
    // Billing figures only for staff who may see billing.
    const perms = { canUpload: true, canMessage: true, canViewBilling: await can(user, "billing", "view") };
    const [d, home] = await Promise.all([
      businessDashboardFor(id, sp.month, perms, null),
      loadPortalHome(id, PREVIEW_PERMS, null),
    ]);
    // A dashboard link opens the matching preview page; pages View as Client can't show are disabled.
    const dashHref = (path: string, extra = "") => {
      const v = viewFor(path);
      if (v === "home") return null;
      const c = v === "messages" ? /(?:^|&)c=([\w-]+)/.exec(extra)?.[1] : undefined;
      return `${base}?view=${v}${c ? `&c=${c}` : ""}`;
    };
    body = (
      <BusinessDashboardView
        d={d}
        tiles={businessHomeTiles(home, dashHref, dashHref("/client/documents"), dashHref("/client/payroll"))}
        q=""
        base={`${base}?view=home`}
        linkFor={linkFor}
        personalQ={null}
        readOnly
        previewHref={dashHref}
      />
    );
  } else if (view === "home") {
    const [home, greet] = await Promise.all([
      loadPortalHome(id, PREVIEW_PERMS, null),
      loadGreetingName(id, null),
    ]);
    body = (
      <PortalHomeView
        data={home}
        linkFor={linkFor}
        q=""
        readOnly
        previewHref={previewHref}
        name={greet ?? undefined}
        year={year}
      />
    );
  } else if (BUSINESS_VIEWS.includes(view) && !businessView) {
    body = <NotBusinessNotice />;
  } else if (view === "payroll") {
    // Read-only, owner-level document scope; documents open with a staff link.
    body = <PayrollPageView d={await payrollPageFor(id, PREVIEW_PERMS, null)} linkFor={linkFor} back={`${base}?view=home`} />;
  } else if (view === "licenses") {
    body = <LicensesPageView d={await licensesPageFor(id, PREVIEW_PERMS, null)} linkFor={linkFor} back={`${base}?view=home`} />;
  } else if (view === "year-end") {
    body = <YearEndPageView d={await yearEndPageFor(id)} canUpload back={`${base}?view=home`} readOnly />;
  } else if (view === "invoicing") {
    body = <InvoicingPageView d={await previewClientInvoicing(id)} back={`${base}?view=home`} readOnly />;
  } else if (view === "summary") {
    body = (
      <PortalSummaryView
        summaries={await previewSummaries(id)}
        clientId={id}
        readOnly
      />
    );
  } else if (view === "taxes") {
    body = (
      <PortalTaxesView data={await loadPortalTaxes(id)} linkFor={linkFor} />
    );
  } else if (view === "documents") {
    body = (
      <PortalDocumentsView
        docs={await loadPortalDocuments(
          id,
          PREVIEW_PERMS,
          year ? { year } : {},
        )}
        linkFor={linkFor}
      />
    );
  } else if (view === "messages") {
    const threads = await prisma.conversation.findMany({
      where: { clientId: id, messages: { some: { channel: "PORTAL" } } },
      include: {
        messages: {
          where: { channel: "PORTAL" },
          orderBy: { createdAt: "asc" },
          include: {
            staffAuthor: { select: { name: true } },
            portalAuthor: { select: { name: true } },
          },
        },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 20,
    });
    const open = threads.find((t) => t.id === sp.c) ?? threads[0];
    body = threads.length ? (
      <div className="grid gap-4 lg:grid-cols-3">
        <ul className="min-w-0 space-y-2">
          {threads.map((t) => (
            <li key={t.id}>
              <Link
                href={`${base}?view=messages&c=${t.id}`}
                className={clsx(
                  "block rounded-xl border p-3 text-sm",
                  t.id === open?.id
                    ? "border-gold-500 bg-gold-50"
                    : "border-ivory-200 bg-white",
                )}
              >
                <span className="block truncate font-semibold">
                  {t.subject}
                </span>
                <span className="text-xs text-slate-600">
                  {fmtDateTime(t.lastMessageAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Card className="min-w-0 lg:col-span-2" title={open?.subject}>
          <ul className="space-y-3 text-sm">
            {open?.messages.map((m) => (
              <li
                key={m.id}
                className={clsx(
                  "rounded-xl p-3",
                  m.direction === "OUTBOUND" ? "bg-navy-50" : "bg-ivory-50",
                )}
              >
                <p className="text-xs text-slate-600">
                  {m.direction === "OUTBOUND"
                    ? (m.staffAuthor?.name ?? "Our office")
                    : (m.portalAuthor?.name ?? "Client")}{" "}
                  · {fmtDateTime(m.createdAt)}
                </p>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-600">
            Read-only. Internal notes and email/text threads are never shown to
            clients.
          </p>
        </Card>
      </div>
    ) : (
      <EmptyState title="No portal messages">
        The client hasn&apos;t exchanged portal messages yet.
      </EmptyState>
    );
  } else {
    const people = await staffIdentityOverview(user, id).catch(() => null);
    body = !people ? (
      <Notice>
        You don&apos;t have access to this client&apos;s identity documents.
      </Notice>
    ) : (
      <div className="grid gap-4 md:grid-cols-2">
        {people.map(({ person, slots }) => (
          <Card
            key={person.id}
            title={`${person.name} · ${person.role.toLowerCase()}`}
          >
            <ul className="space-y-1 text-sm">
              {slots.map((s) => {
                const st =
                  s.current?.status === "EXPIRED" ||
                  (s.daysLeft !== null && s.daysLeft < 0)
                    ? ["Expired", "red"]
                    : s.current
                      ? ["On file", "green"]
                      : s.pending.length
                        ? ["Waiting for our review", "gold"]
                        : s.rejected
                          ? ["Needs a new copy", "red"]
                          : ["Not provided", "gray"];
                return (
                  <li
                    key={s.type}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span>
                      {ID_TYPES[s.type].label}
                      {s.current?.expiresOn
                        ? ` · expires ${s.current.expiresOn}`
                        : ""}
                    </span>
                    <Badge tone={st[1] as never}>{st[0]}</Badge>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
        <p className="text-xs text-slate-600 md:col-span-2">
          Statuses only — images and numbers are never shown in this preview.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        role="status"
        className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-gold-500 bg-gold-100 px-4 py-3 text-navy-950"
        data-testid="view-as-client-banner"
      >
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          <Eye className="size-5 shrink-0" aria-hidden /> VIEW AS CLIENT —{" "}
          {client.businessName || client.displayName} (read-only, owner
          permissions). Every page you open is logged.
        </span>
        <Link
          href={`/clients/${id}`}
          className="rounded-md bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white"
        >
          Exit
        </Link>
      </div>
      <nav
        aria-label="Client portal pages"
        className="flex gap-1.5 overflow-x-auto pb-1"
        data-testid="preview-tabs"
      >
        {VIEWS.filter(([v]) => businessView || !BUSINESS_VIEWS.includes(v)).map(([v, label]) => (
          <Link
            key={v}
            href={`${base}?view=${v}`}
            aria-current={v === view ? "page" : undefined}
            className={clsx(
              "shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold",
              v === view
                ? "bg-navy-900 text-gold-300"
                : "bg-white text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
      <section data-testid={`preview-${view}`}>{body}</section>
    </div>
  );
}
