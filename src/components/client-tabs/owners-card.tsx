import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import { archiveOwnerAction, decidePersonalTaxAction, inviteOwnerAction, ownerPermissionsAction, saveOwnerAction, uploadK1Action } from "@/app/actions/business-owners";
import { prisma } from "@/lib/prisma";
import { formatPhone } from "@/lib/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { OWNER_AREAS, OWNER_TITLES, pct } from "@/lib/portal/owner-areas";
import { canManageOwnerPermissions, INVITE_STATUS_LABEL, listBusinessOwners, type InviteStatus } from "@/lib/services/business-owners";
import { pendingPersonalTaxRequests } from "@/lib/services/personal-tax-requests";
import { downloadToken } from "@/lib/services/documents";
import { isPrimaryOwner } from "@/lib/auth/permissions";

const STATUS_TONE: Record<InviteStatus, "gray" | "amber" | "green" | "red"> = { NOT_INVITED: "gray", INVITED: "amber", ACTIVE: "green", EXPIRED: "red", REVOKED: "red" };

type Owner = Awaited<ReturnType<typeof listBusinessOwners>>["owners"][number];

function OwnerFields({ o }: { o?: Owner }) {
  return (
    <>
      <Field label="Name"><input className="input" name="name" defaultValue={o?.contact.name ?? ""} required /></Field>
      <Field label="Title / role">
        <select className="input" name="title" defaultValue={o?.title ?? "MEMBER"}>
          {Object.entries(OWNER_TITLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Email" hint="Their own address: each owner gets a separate login."><input className="input" type="email" name="email" defaultValue={o?.contact.email ?? ""} /></Field>
      <Field label="Mobile phone"><input className="input" type="tel" name="phone" defaultValue={o?.contact.phone ?? ""} /></Field>
      <Field label="Ownership %" hint="e.g. 25 or 33.33. Ownership never grants portal access."><input className="input" name="ownership" inputMode="decimal" defaultValue={o?.ownershipBps != null ? String(o.ownershipBps / 100) : ""} /></Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="receivesK1" defaultChecked={o ? o.receivesK1 : true} className="size-4 accent-navy-900" /> Receives a K-1</label>
      <Field label="Notes (optional)" className="sm:col-span-2" hint="No SSNs or tax figures."><textarea className="input" name="notes" rows={2} defaultValue={o?.notes ?? ""} /></Field>
    </>
  );
}

/**
 * Owners card for a business client: every owner with their ownership, K-1 and
 * login status; add / edit / remove (archive); "Invite to portal" for each
 * owner's own login; and the per-owner permission matrix (Tabitha or staff she
 * authorized). Ownership % and portal permissions are kept apart.
 */
export async function OwnersCard({ clientId, actor, managedBusiness }: { clientId: string; actor: Actor; managedBusiness: boolean }) {
  const [{ owners, total, warning }, manager, isTabitha, requests, k1Docs] = await Promise.all([
    listBusinessOwners(clientId, { includeArchived: true }),
    canManageOwnerPermissions(actor),
    isPrimaryOwner(actor.id),
    pendingPersonalTaxRequests(clientId),
    prisma.document.findMany({ where: { clientId, category: "OWNER_K1", deletedAt: null }, select: { id: true, title: true, year: true, visibility: true, businessOwnerId: true, scanStatus: true }, orderBy: [{ year: "desc" }, { createdAt: "desc" }] }),
  ]);
  const active = owners.filter((o) => !o.archivedAt);
  const archived = owners.filter((o) => o.archivedAt);
  const thisYear = new Date().getFullYear();

  return (
    <Card title="Owners" actions={<span className="text-sm text-slate-600" data-testid="ownership-total">{active.length} owner{active.length === 1 ? "" : "s"} · {pct(total)} recorded</span>}>
      <div data-testid="owners-card">
        {active.length > 0 && warning && <div className="mb-3"><Notice tone="warn">{warning}</Notice></div>}
        {requests.length > 0 && (
          <div className="mb-4 space-y-2" data-testid="personal-tax-requests">
            {requests.map((r) => (
              <div key={r.id} className="rounded-xl border border-gold-300 bg-gold-50 p-3 text-sm">
                <p className="font-semibold text-navy-900">{r.portalUser.name} asked for personal tax preparation · {fmtDate(r.createdAt)}</p>
                {r.note && <p className="text-slate-700">{r.note}</p>}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <ActionForm action={decidePersonalTaxAction.bind(null, clientId, r.id, true)} className="flex flex-wrap items-end gap-2">
                    <Field label="Existing Personal record ID (optional)" hint="Leave blank to set up a new Personal record for them."><input className="input" name="existingClientId" /></Field>
                    <Button type="submit">Accept</Button>
                  </ActionForm>
                  <ActionForm action={decidePersonalTaxAction.bind(null, clientId, r.id, false)}><Button type="submit" variant="secondary">Decline</Button></ActionForm>
                </div>
              </div>
            ))}
          </div>
        )}

        {active.length === 0 ? (
          <p className="mb-3 text-sm text-slate-600">No owners listed yet. Add each owner; every owner can have their own portal login.</p>
        ) : (
          <ul className="mb-4 divide-y divide-navy-100">
            {active.map((o) => {
              const docs = k1Docs.filter((d) => d.businessOwnerId === o.id);
              const others = active.filter((x) => x.id !== o.id);
              return (
                <li key={o.id} className="py-3" data-testid="owner-row" data-owner={o.contact.name}>
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
                      <span className="min-w-0">
                        <span className="font-semibold text-navy-900">{o.contact.name}</span>
                        <span className="text-slate-600"> · {o.title ? OWNER_TITLES[o.title as keyof typeof OWNER_TITLES] : "Owner"} · {pct(o.ownershipBps)}</span>
                        {o.receivesK1 && <Badge tone="gold" className="ml-2">K-1</Badge>}
                        <span className="block text-sm text-slate-600">{[o.contact.email, o.contact.phoneNormalized && formatPhone(o.contact.phoneNormalized)].filter(Boolean).join(" · ") || "No contact details"}</span>
                      </span>
                      <span className="flex items-center gap-2" data-testid="owner-status">
                        <Badge tone={STATUS_TONE[o.status]}>{INVITE_STATUS_LABEL[o.status]}</Badge>
                        <span className="text-sm underline">Manage</span>
                      </span>
                    </summary>

                    <div className="mt-3 space-y-4">
                      <ActionForm action={saveOwnerAction.bind(null, clientId, o.id)} className="grid gap-3 sm:grid-cols-2">
                        <OwnerFields o={o} />
                        <div className="flex flex-wrap gap-2 sm:col-span-2">
                          <Button type="submit">Save owner</Button>
                          <ConfirmButton action={archiveOwnerAction.bind(null, clientId, o.id)} variant="danger" confirm={`Remove ${o.contact.name} as an owner? They're archived (not deleted): their K-1s and history stay, and their login loses this business right away.`}>Remove owner</ConfirmButton>
                        </div>
                      </ActionForm>

                      <section className="rounded-xl border border-navy-100 p-3">
                        <h3 className="mb-1 text-sm font-semibold text-navy-900">Portal login</h3>
                        <p className="mb-2 text-sm text-slate-600">
                          {o.status === "ACTIVE" ? `Active login (${o.portalUser?.email})${o.portalUser?.lastLoginAt ? ` · last signed in ${fmtDateTime(o.portalUser.lastLoginAt)}` : " · not signed in yet"}.` : o.status === "INVITED" ? `Invitation sent to ${o.openInvite?.email} · expires ${fmtDate(o.openInvite!.expiresAt)}.` : "Their own login, separate from the other owners. It starts with their own K-1s and Messages only."}
                        </p>
                        {o.status !== "ACTIVE" && (
                          <ActionForm action={inviteOwnerAction.bind(null, clientId, o.id)}>
                            <Button type="submit" variant="secondary" disabled={!o.contact.email}>{o.status === "INVITED" ? "New invitation link" : "Invite to portal"}</Button>
                            {!o.contact.email && <span className="ml-2 text-xs text-slate-600">Add their email first.</span>}
                          </ActionForm>
                        )}
                      </section>

                      {o.permissions && (
                        <section className="rounded-xl border border-navy-100 p-3" data-testid="owner-permissions">
                          <h3 className="text-sm font-semibold text-navy-900">Portal permissions</h3>
                          <p className="mb-2 text-xs text-slate-600">{manager ? "Changes apply to their login right away and are logged." : "Only Tabitha, or staff she authorized, can change these."} Their own K-1s are always visible to them.</p>
                          <ActionForm action={ownerPermissionsAction.bind(null, clientId, o.id)}>
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[520px] text-sm">
                                <thead><tr className="text-left text-slate-600"><th className="py-1.5 pr-3 font-semibold">Area</th><th className="py-1.5 pr-3 font-semibold">Access</th></tr></thead>
                                <tbody className="divide-y divide-navy-100">
                                  {OWNER_AREAS.map((a) => (
                                    <tr key={a.key}>
                                      <td className="py-2 pr-3"><span className="font-medium text-navy-900">{a.label}</span><span className="block text-xs text-slate-600">{a.hint}</span></td>
                                      <td className="py-2 pr-3">
                                        <span className="flex flex-wrap gap-3">
                                          {a.actions.map((x) => {
                                            const val = o.permissions![x.flag];
                                            // Banking needs a Managed Business and Tabitha herself; otherwise shown read-only (value kept).
                                            const locked = !manager || (x.flag === "canViewBookkeeping" && (!managedBusiness || (!isTabitha && !val)));
                                            return (
                                              <label key={x.flag} className="flex items-center gap-1.5">
                                                <input type="checkbox" name={locked ? undefined : x.flag} defaultChecked={val} disabled={locked} className="size-4 accent-navy-900" data-flag={x.flag} />
                                                {locked && val && <input type="hidden" name={x.flag} value="on" />}
                                                {x.label}
                                              </label>
                                            );
                                          })}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                  <tr>
                                    <td className="py-2 pr-3"><span className="font-medium text-navy-900">K-1s</span><span className="block text-xs text-slate-600">Their own: always. Another owner&apos;s: only if you share it here, per owner.</span></td>
                                    <td className="py-2 pr-3">
                                      <span className="block text-xs font-semibold text-emerald-800">Own K-1s ✓</span>
                                      {others.map((h) => (
                                        <label key={h.id} className="mt-1 flex items-center gap-1.5">
                                          {manager && <input type="hidden" name="k1Holder" value={h.id} />}
                                          <input type="checkbox" name={`k1:${h.id}`} defaultChecked={o.k1Viewing.some((g) => g.holderOwnerId === h.id)} disabled={!manager} className="size-4 accent-navy-900" />
                                          Also see {h.contact.name}&apos;s K-1s
                                        </label>
                                      ))}
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                            {manager && <div className="mt-2"><Button type="submit">Save permissions</Button></div>}
                          </ActionForm>
                        </section>
                      )}

                      {o.receivesK1 && (
                        <section className="rounded-xl border border-navy-100 p-3" data-testid="owner-k1s">
                          <h3 className="mb-1 text-sm font-semibold text-navy-900">K-1s for {o.contact.name}</h3>
                          {docs.length > 0 && (
                            <ul className="mb-2 space-y-1 text-sm">
                              {docs.map((d) => (
                                <li key={d.id}>
                                  <a className="underline" href={`/api/documents/${downloadToken(d.id, { staffId: actor.id })}`}>{d.title}</a>
                                  {d.year && <span className="text-slate-600"> · {d.year}</span>} <Badge tone={d.visibility === "PUBLISHED" ? "green" : "gray"}>{d.visibility === "PUBLISHED" ? "Visible to owner" : "Staff only"}</Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                          <ActionForm action={uploadK1Action.bind(null, clientId, o.id)} className="grid gap-2 sm:grid-cols-4" resetOnSuccess>
                            <Field label="Tax year"><select className="input" name="year" defaultValue={thisYear - 1}>{Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
                            <Field label="File" className="sm:col-span-2"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required /></Field>
                            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="publish" defaultChecked className="size-4 accent-navy-900" /> Visible to this owner</label>
                            <div className="sm:col-span-4"><Button type="submit" variant="secondary">Upload K-1</Button></div>
                          </ActionForm>
                        </section>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}

        <details>
          <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Add an owner</summary>
          <ActionForm action={saveOwnerAction.bind(null, clientId, null)} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
            <OwnerFields />
            <div className="sm:col-span-2"><Button type="submit">Add owner</Button></div>
          </ActionForm>
        </details>

        {archived.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm text-slate-600 underline">Former owners ({archived.length})</summary>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {archived.map((o) => <li key={o.id}>{o.contact.name} · {pct(o.ownershipBps)} · removed {fmtDate(o.archivedAt!)}</li>)}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}
