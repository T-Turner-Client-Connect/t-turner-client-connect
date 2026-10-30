import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { createLinkedBusinessAction, grantOwnerAccessAction, linkExistingBusinessAction } from "@/app/actions/related-businesses";
import { prisma } from "@/lib/prisma";
import { businessFamily, REL_ROLES } from "@/lib/services/related-businesses";

/**
 * Staff tabs across one owner's records, with + Add / Link Another Business
 * on the owner's main record (their Personal record, or the Business record
 * they were set up under). Each tab is a separate client record.
 */
export async function BusinessTabs({ clientId, base }: { clientId: string; base: "/clients" | "/bookkeeping" }) {
  const fam = await businessFamily(clientId);
  if (!fam) return null;
  const { current, anchor, person, businesses } = fam;
  const tabs = [...(person ? [{ id: person.id, label: `Personal — ${person.displayName}` }] : []), ...businesses.map((b) => ({ id: b.id, label: b.businessName || b.displayName }))];
  // Businesses are added from the owner's main record; a lone Business record can become one.
  const onMain = current.id === anchor.id;
  const others = businesses.filter((b) => b.id !== anchor.id);
  const [candidates, logins, access] = onMain
    ? await Promise.all([
        prisma.client.findMany({ where: { archivedAt: null, clientType: { not: "INDIVIDUAL" }, id: { notIn: [anchor.id, ...businesses.map((b) => b.id)] }, ownsBusinesses: { none: {} } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 300 }),
        prisma.portalAccess.findMany({ where: { clientId: current.id, revokedAt: null }, include: { portalUser: { select: { id: true, email: true } } } }),
        prisma.portalAccess.findMany({ where: { clientId: { in: others.map((b) => b.id) }, revokedAt: null }, select: { clientId: true, portalUserId: true } }),
      ])
    : [[], [], []];
  if (tabs.length < 2 && !onMain) return null;
  return (
    <div className="mb-4 rounded-2xl border border-ivory-200 bg-white p-3 shadow-sm" data-testid="business-tabs">
      <nav aria-label="Owner's businesses" className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <Link key={t.id} href={`${base}/${t.id}`} aria-current={t.id === current.id ? "page" : undefined} className={`rounded-full px-3 py-1.5 text-sm font-semibold ${t.id === current.id ? "bg-navy-900 text-gold-300 ring-2 ring-gold-500" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100"}`}>
            {t.label}
          </Link>
        ))}
        {!onMain && <Link href={`/clients/${anchor.id}#link-business`} className="text-sm underline">+ Add / Link Another Business</Link>}
      </nav>
      <p className="mt-2 text-xs text-slate-600">Viewing <strong>{current.businessName || current.displayName}</strong>. Each business keeps its own EIN, accounts, billing, documents, staff and Coetha link.</p>
      {onMain && (
        <details className="mt-2" id="link-business">
          <summary className="cursor-pointer text-sm font-semibold underline">+ Add / Link Another Business</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            <ActionForm action={linkExistingBusinessAction.bind(null, current.id)} className="space-y-2 rounded-xl bg-ivory-50 p-3">
              <p className="text-sm font-semibold">Link an existing business</p>
              <Field label="Business"><select className="input" name="businessId" defaultValue=""><option value="">Choose…</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select></Field>
              <Field label="Role"><select className="input" name="role" defaultValue="OWNER">{Object.entries(REL_ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Button type="submit" variant="secondary">Link business</Button>
            </ActionForm>
            <ActionForm action={createLinkedBusinessAction.bind(null, current.id)} className="space-y-2 rounded-xl bg-ivory-50 p-3" resetOnSuccess>
              <p className="text-sm font-semibold">Create a new business profile</p>
              <Field label="Business name"><input className="input" name="businessName" /></Field>
              <Field label="Type"><select className="input" name="clientType" defaultValue="BUSINESS"><option value="BUSINESS">Business</option><option value="NONPROFIT">Nonprofit</option></select></Field>
              <Field label="Business email (optional)"><input className="input" type="email" name="email" /></Field>
              <Field label="Business phone (optional)"><input className="input" type="tel" name="phone" /></Field>
              <Button type="submit" variant="secondary">Create &amp; link</Button>
            </ActionForm>
          </div>
          {anchor.clientType !== "INDIVIDUAL" && (
            <p className="mt-2 text-xs text-slate-600" data-testid="main-record-note">
              {current.businessName || current.displayName} stays exactly as it is — same contact, login, documents, bookkeeping and billing. Each business you add gets its own record and tab; nothing is copied or moved into it.
            </p>
          )}
          {logins.length > 0 && others.length > 0 && (
            <div className="mt-3 rounded-xl border border-ivory-200 p-3 text-sm" data-testid="owner-access">
              <p className="mb-1 font-semibold">Portal access per business</p>
              <p className="mb-2 text-xs text-slate-600">The same login{logins.length === 1 ? "" : "s"} already used for {current.businessName || current.displayName}. Owning a business doesn&apos;t open it automatically — grant each one here.</p>
              <ul className="space-y-1">
                {logins.flatMap((l) =>
                  others.map((b) => {
                    const has = access.some((a) => a.clientId === b.id && a.portalUserId === l.portalUser.id);
                    return (
                      <li key={`${l.portalUser.id}:${b.id}`} className="flex flex-wrap items-center gap-2">
                        {l.portalUser.email} → {b.displayName} {has ? <Badge tone="green">Has access</Badge> : (
                          <ActionForm action={grantOwnerAccessAction.bind(null, current.id, b.id, l.portalUser.id)} confirm={`Give ${l.portalUser.email} portal access to ${b.displayName}?`} className="inline">
                            <Button type="submit" variant="ghost">Give access to this business</Button>
                          </ActionForm>
                        )}
                      </li>
                    );
                  }),
                )}
              </ul>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
