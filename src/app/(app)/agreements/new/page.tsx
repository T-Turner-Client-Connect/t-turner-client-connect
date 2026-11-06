import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { AgreementBuilder } from "@/components/agreements/builder";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { createAgreementAction, newClientForAgreementAction } from "@/app/actions/agreements";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { library, prefillOptions, searchClients, templates } from "@/lib/services/agreements";
import { CLIENT_TYPE_LABELS } from "@/lib/format";

export const metadata = { title: "New agreement" };

/** New agreement on one page: (a) the client, (b) the type, (c) the options with a live preview. */
export default async function NewAgreementPage({ searchParams }: { searchParams: Promise<{ client?: string; q?: string; type?: string }> }) {
  await connection();
  await requireUser();
  const sp = await searchParams;
  const client = sp.client ? await prisma.client.findFirst({ where: { id: sp.client, archivedAt: null }, select: { id: true, displayName: true, businessName: true, clientType: true, email: true } }) : null;
  const results = !client ? await searchClients(sp.q ?? "") : [];
  const [tpls, lib] = await Promise.all([templates(), library()]);
  const prefills = client ? Object.fromEntries(await Promise.all(tpls.map(async (t) => [t.key, await prefillOptions(client.id, t.key)] as const))) : {};
  const name = client ? (client.clientType !== "INDIVIDUAL" && client.businessName ? client.businessName : client.displayName) : "";

  return (
    <>
      <PageHeader title="New agreement" subtitle="Pick the client, the type of agreement, then the options. You'll see the agreement as the client will before you save the draft." actions={<Link className="text-sm underline" href="/agreements">← All agreements</Link>} />
      <section aria-labelledby="step-a" className="mb-6" data-testid="step-a">
        <h2 id="step-a" className="mb-3 font-serif text-xl font-bold text-navy-900">Step 1 · Choose the client</h2>
        {client ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-navy-900 bg-white p-4" data-testid="chosen-client">
            <p><span className="font-semibold text-navy-900">{name}</span> <span className="text-sm text-slate-600">· {CLIENT_TYPE_LABELS[client.clientType]}{client.email ? ` · ${client.email}` : ""}</span></p>
            <Link className="min-h-11 py-2.5 text-sm underline" href="/agreements/new">Change client</Link>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Search existing clients">
              <form method="get" className="flex gap-2">
                <input className="input flex-1" name="q" defaultValue={sp.q ?? ""} placeholder="Name, business or email" aria-label="Search clients" />
                <Button type="submit" variant="secondary">Search</Button>
              </form>
              <ul className="mt-3 divide-y divide-navy-100 text-sm" data-testid="client-results">
                {results.map((c) => (
                  <li key={c.id}><Link className="flex min-h-11 items-center justify-between gap-2 py-2 hover:bg-navy-50" href={`/agreements/new?client=${c.id}`}><span className="font-medium text-navy-900">{c.clientType !== "INDIVIDUAL" && c.businessName ? c.businessName : c.displayName}</span><span className="text-xs text-slate-600">{CLIENT_TYPE_LABELS[c.clientType]}{c.email ? ` · ${c.email}` : ""}</span></Link></li>
                ))}
                {results.length === 0 && <li className="py-2 text-slate-600">No clients match.</li>}
              </ul>
            </Card>
            <Card title="New client">
              <p className="mb-2 text-sm text-slate-700">Creates the client record (as a prospect) after checking for an existing match by name, email and phone. A possible match is never created twice — pick it from the search instead.</p>
              <ActionForm action={newClientForAgreementAction} className="grid gap-2 sm:grid-cols-2">
                <Field label="Type"><select className="input" name="clientType" defaultValue="INDIVIDUAL"><option value="INDIVIDUAL">Individual</option><option value="BUSINESS">Business</option><option value="NONPROFIT">Nonprofit</option></select></Field>
                <Field label="Business or organization name"><input className="input" name="businessName" /></Field>
                <Field label="First name"><input className="input" name="firstName" /></Field>
                <Field label="Last name"><input className="input" name="lastName" /></Field>
                <Field label="Email"><input className="input" type="email" name="email" /></Field>
                <Field label="Mobile phone"><input className="input" type="tel" name="phone" /></Field>
                <div className="sm:col-span-2"><Button type="submit">Create client and continue</Button></div>
              </ActionForm>
              <p className="mt-2 text-xs text-slate-600">Need the full client form? <Link className="underline" href="/clients/new">Add client</Link>, then come back.</p>
            </Card>
          </div>
        )}
      </section>

      {client && (
        <AgreementBuilder
          action={createAgreementAction}
          templates={tpls.map((t) => ({ key: t.key, name: t.name, description: t.description, title: t.title, intro: t.intro, clauseKeys: t.clauseKeys, version: t.version }))}
          library={lib.map((c) => ({ key: c.key, title: c.title, kind: c.kind, version: c.version, status: c.status, body: c.body }))}
          clientName={name}
          clientId={client.id}
          prefills={prefills}
          initialTemplate={sp.type && tpls.some((t) => t.key === sp.type) ? sp.type : undefined}
        />
      )}
    </>
  );
}
