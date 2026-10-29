import Link from "next/link";
import { Badge, buttonClass, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { clientWhere } from "@/lib/services/clients";
import { formatPhone } from "@/lib/normalize";
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS } from "@/lib/format";

export const metadata = { title: "Clients" };

const PAGE_SIZE = 50;
type SP = Promise<Record<string, string | undefined>>;

export default async function ClientsPage({ searchParams }: { searchParams: SP }) {
  await requireUser();
  const sp = await searchParams;
  const filters = { q: sp.q, status: sp.status, type: sp.type, groupId: sp.group, tag: sp.tag, assignedToId: sp.staff, archived: sp.archived === "1" };
  const page = Math.max(1, Number(sp.page) || 1);
  const where = clientWhere(filters);
  const [clients, count, groups, staff] = await Promise.all([
    prisma.client.findMany({
      where,
      include: { assignedTo: { select: { name: true } }, groups: { include: { group: { select: { name: true } } } }, _count: { select: { contacts: true } } },
      orderBy: { displayName: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.client.count({ where }),
    prisma.group.findMany({ orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]);
    return `/clients?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={filters.archived ? "Archived clients" : "Clients"}
        subtitle={`${count} ${count === 1 ? "client" : "clients"}${filters.archived ? " in the archive" : ""}`}
        actions={
          <>
            <LinkButton href={filters.archived ? "/clients" : "/clients?archived=1"} variant="secondary">
              {filters.archived ? "Back to current clients" : "View archive"}
            </LinkButton>
            <LinkButton href="/clients/new">Add client</LinkButton>
          </>
        }
      />
      <form className="mb-4 grid gap-2 rounded-xl border border-navy-100 bg-white p-3 sm:grid-cols-2 lg:grid-cols-6" role="search">
        {filters.archived && <input type="hidden" name="archived" value="1" />}
        <label className="lg:col-span-2">
          <span className="sr-only">Search</span>
          <input className="input" name="q" defaultValue={sp.q} placeholder="Search name, business, email, phone" />
        </label>
        <select className="input" name="status" defaultValue={sp.status ?? ""} aria-label="Status">
          <option value="">Any status</option>
          {Object.entries(CLIENT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" name="type" defaultValue={sp.type ?? ""} aria-label="Client type">
          <option value="">Any type</option>
          {Object.entries(CLIENT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" name="group" defaultValue={sp.group ?? ""} aria-label="Group">
          <option value="">Any group</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select className="input" name="staff" defaultValue={sp.staff ?? ""} aria-label="Assigned staff">
          <option value="">Anyone assigned</option>
          <option value="none">Unassigned</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-6">
          <button className={buttonClass("primary")}>Apply</button>
          <Link href={filters.archived ? "/clients?archived=1" : "/clients"} className={buttonClass("ghost")}>Clear</Link>
        </div>
      </form>

      {clients.length === 0 ? (
        <EmptyState title={filters.q || sp.status || sp.type || sp.group ? "No clients match those filters" : "No clients yet"}>
          Add a client, or import contacts from a spreadsheet on the <Link className="underline" href="/imports">Imports</Link> page.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-navy-100 overflow-hidden rounded-xl border border-navy-100 bg-white">
          {clients.map((c) => (
            <li key={c.id}>
              <Link href={`/clients/${c.id}`} className="grid gap-1 px-4 py-3 hover:bg-navy-50 md:grid-cols-[2fr_2fr_1fr_1fr] md:items-center md:gap-4">
                <div>
                  <p className="font-semibold text-navy-900">{c.displayName}</p>
                  {c.businessName && c.businessName !== c.displayName && <p className="text-sm text-slate-600">{c.businessName}</p>}
                </div>
                <div className="text-sm text-slate-700">
                  {c.email && <p className="truncate">{c.email}</p>}
                  {c.phoneNormalized && <p>{formatPhone(c.phoneNormalized)}</p>}
                  {c._count.contacts > 0 && <p className="text-xs text-slate-500">+{c._count.contacts} contact{c._count.contacts > 1 ? "s" : ""}</p>}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge tone={c.status === "ACTIVE" ? "green" : c.status === "PROSPECT" ? "gold" : "gray"}>{CLIENT_STATUS_LABELS[c.status]}</Badge>
                  <Badge tone="navy">{CLIENT_TYPE_LABELS[c.clientType]}</Badge>
                </div>
                <p className="text-sm text-slate-600">{c.assignedTo?.name ?? "Unassigned"}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pages">
          {page > 1 ? <Link className={buttonClass("secondary")} href={qs({ page: String(page - 1) })}>Previous</Link> : <span />}
          <span>Page {page} of {pages}</span>
          {page < pages ? <Link className={buttonClass("secondary")} href={qs({ page: String(page + 1) })}>Next</Link> : <span />}
        </nav>
      )}
    </>
  );
}
