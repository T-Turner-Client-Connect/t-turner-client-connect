import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { BookkeepingServiceFields } from "@/components/bookkeeping-service-fields";
import { Badge, Button, Card, Field, LinkButton, PageHeader } from "@/components/ui";
import { addExistingBookkeepingClientAction, addNewBookkeepingClientAction } from "@/app/actions/bookkeeping-clients";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Add Bookkeeping Client" };

type SP = { mode?: string; q?: string; client?: string };

export default async function AddBookkeepingClientPage({ searchParams }: { searchParams: Promise<SP> }) {
  await connection();
  const user = await requireUser();
  const sp = await searchParams;
  const mode = sp.mode === "new" ? "new" : "existing";
  const q = sp.q?.trim() ?? "";
  const search = q
    ? { OR: [{ displayName: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] }
    : {};
  const [staff, clients, total] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({
      where: { archivedAt: null, ...search },
      select: { id: true, displayName: true, email: true, assignedToId: true, bookkeepingProfile: { select: { active: true } } },
      orderBy: { displayName: "asc" },
      take: 300,
    }),
    prisma.client.count({ where: { archivedAt: null } }),
  ]);
  const available = clients.filter((c) => !c.bookkeepingProfile?.active);
  const enrolled = clients.filter((c) => c.bookkeepingProfile?.active);
  const preselect = available.find((c) => c.id === sp.client)?.id ?? (available.length === 1 ? available[0].id : "");
  const tab = (m: "existing" | "new", text: string) => (
    <Link
      href={m === "new" ? "/bookkeeping/new?mode=new" : "/bookkeeping/new"}
      aria-current={mode === m ? "page" : undefined}
      className={`rounded-full px-4 py-2 text-sm font-semibold ${mode === m ? "bg-navy-900 text-white" : "bg-white text-navy-900 ring-1 ring-ivory-200 hover:bg-ivory-50"}`}
    >
      {text}
    </Link>
  );

  return (
    <>
      <p className="mb-2 text-sm"><Link className="underline" href="/bookkeeping">← Bookkeeping Clients</Link></p>
      <PageHeader title="Add Bookkeeping Client" subtitle="Enroll a client who is already in the CRM, or create a new client. Nothing is sent to the client." />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Who are you adding?">
        {tab("existing", "Existing CRM client")}
        {tab("new", "New client")}
      </nav>

      {mode === "existing" ? (
        <Card title="1. Find the client">
          <form method="get" className="mb-3 flex flex-wrap items-end gap-2" role="search">
            <Field label="Search by name, email or phone"><input className="input w-72" name="q" defaultValue={q} placeholder="e.g. Bakery" /></Field>
            <Button type="submit" variant="secondary">Search</Button>
            {q && <Link href="/bookkeeping/new" className="pb-2 underline">Show all</Link>}
          </form>
          {enrolled.length > 0 && q && (
            <ul className="mb-3 space-y-1 text-sm" data-testid="already-enrolled">
              {enrolled.map((c) => (
                <li key={c.id}><Badge tone="green">Already enrolled</Badge> {c.displayName} · <Link className="underline" href={`/bookkeeping/${c.id}`}>Open workspace</Link></li>
              ))}
            </ul>
          )}
          {/* The form stays mounted after a save, so its success message and workspace link stay on screen. */}
          <ActionForm action={addExistingBookkeepingClientAction} className="grid gap-3 sm:grid-cols-3">
            {available.length === 0 ? (
              <div className="rounded-xl bg-ivory-50 p-4 text-sm sm:col-span-3" data-testid="no-candidates">
                <p className="font-semibold">{total === 0 ? "There are no clients in the CRM yet." : q ? `No client matching “${q}” is waiting to be enrolled.` : "Every CRM client is already a Bookkeeping Client."}</p>
                <p className="mt-1">Use <Link className="font-semibold underline" href="/bookkeeping/new?mode=new">New client</Link> to create the client and enroll them in one step, or import clients under Clients → Import.</p>
              </div>
            ) : (
              <>
                <Field label="Client" className="sm:col-span-3">
                  <select className="input" name="clientId" defaultValue={preselect} data-testid="existing-client">
                    <option value="">Choose a client… ({available.length} not yet enrolled)</option>
                    {available.map((c) => <option key={c.id} value={c.id}>{c.displayName}{c.email ? ` — ${c.email}` : ""}{c.bookkeepingProfile ? " (paused — will be reactivated)" : ""}</option>)}
                  </select>
                </Field>
                <h3 className="text-sm font-semibold sm:col-span-3">2. Service details</h3>
                <BookkeepingServiceFields staff={staff} canAssign={user.role === "ADMIN"} />
                <div className="sm:col-span-3"><Button type="submit">Add Bookkeeping Client</Button></div>
              </>
            )}
          </ActionForm>
        </Card>
      ) : (
        <Card title="New client">
          <p className="mb-3 text-sm text-slate-600">We check the CRM first. If this email or phone number already belongs to a client, you&apos;ll be pointed to that record instead, so no duplicate is created.</p>
          <ActionForm action={addNewBookkeepingClientAction} className="grid gap-3 sm:grid-cols-3">
            <Field label="Client type">
              <select className="input" name="clientType" defaultValue="BUSINESS"><option value="BUSINESS">Business</option><option value="INDIVIDUAL">Individual</option><option value="NONPROFIT">Nonprofit</option></select>
            </Field>
            <Field label="Business name" hint="For a business or nonprofit"><input className="input" name="businessName" /></Field>
            <div />
            <Field label="Contact first name"><input className="input" name="firstName" /></Field>
            <Field label="Contact last name"><input className="input" name="lastName" /></Field>
            <div />
            <Field label="Email" hint="Used to check for duplicates"><input className="input" type="email" name="email" /></Field>
            <Field label="Phone" hint="Used to check for duplicates"><input className="input" type="tel" name="phone" /></Field>
            <div />
            <h3 className="text-sm font-semibold sm:col-span-3">Service details</h3>
            <BookkeepingServiceFields staff={staff} canAssign={user.role === "ADMIN"} />
            <label className="flex items-start gap-2 text-sm sm:col-span-3"><input type="checkbox" name="differentClient" className="mt-1" /> If a client with the same <em>name</em> already exists, this is a different client — create a new record anyway. (A matching email or phone number always stops here.)</label>
            <div className="sm:col-span-3"><Button type="submit">Create client &amp; add to Bookkeeping</Button></div>
          </ActionForm>
          <p className="mt-3 text-xs text-slate-600">No portal invitation, email or text is sent. Invite the client from their client record when you&apos;re ready.</p>
        </Card>
      )}
      <p className="mt-4 text-sm"><LinkButton variant="ghost" href="/bookkeeping">Cancel</LinkButton></p>
    </>
  );
}
