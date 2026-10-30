import Link from "next/link";
import { BusinessTabs } from "@/components/business-tabs";
import { notFound } from "next/navigation";
import type { ConsentKind } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { addNoteAction, recordConsentAction, removeContactAction, saveContactAction, setArchivedAction } from "@/app/actions/clients";
import { saveTaskAction } from "@/app/actions/tasks";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { clientTimeline } from "@/lib/services/clients";
import { CONSENT_LABELS, currentConsent, TAX_INFO_KINDS } from "@/lib/consent";
import { formatPhone } from "@/lib/normalize";
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS, fmtDate, fmtDateTime } from "@/lib/format";
import { MessagesTab } from "@/components/client-tabs/messages";
import { DocumentsTab } from "@/components/client-tabs/documents";
import { BookkeepingTab } from "@/components/client-tabs/bookkeeping";
import { PortalTab } from "@/components/client-tabs/portal";
import { TaxesTab } from "@/components/client-tabs/taxes";

export const metadata = { title: "Client" };

const PERSON_KINDS: ConsentKind[] = ["SMS_SERVICE", "SMS_MARKETING", "EMAIL_MARKETING"];
const STATUS_TONE = { GRANTED: "green", REVOKED: "red", UNKNOWN: "gray" } as const;
const STATUS_TEXT = { GRANTED: "Yes", REVOKED: "Opted out", UNKNOWN: "Unknown" } as const;

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "messages", label: "Messages" },
  { key: "documents", label: "Documents" },
  { key: "bookkeeping", label: "Bookkeeping" },
  { key: "taxes", label: "Taxes" },
  { key: "portal", label: "Portal & signatures" },
] as const;

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab)?.key ?? "overview";
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      assignedTo: { select: { name: true } },
      contacts: { orderBy: { name: "asc" } },
      groups: { include: { group: true } },
      consentRecords: { include: { recordedBy: { select: { name: true } }, evidenceFile: { select: { id: true, originalName: true } }, contact: { select: { name: true } } }, orderBy: { createdAt: "desc" } },
      tasks: { where: { status: "OPEN" }, include: { assignee: { select: { name: true } } }, orderBy: { dueAt: "asc" } },
    },
  });
  if (!client) notFound();
  const [timeline, staff, newDocs] = await Promise.all([
    clientTimeline(id),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.document.count({ where: { clientId: id, needsReview: true, deletedAt: null } }),
  ]);
  const addresses = [
    ...(client.emailNormalized ? [{ channel: "EMAIL" as const, addressNormalized: client.emailNormalized }] : []),
    ...(client.phoneNormalized ? [{ channel: "SMS" as const, addressNormalized: client.phoneNormalized }] : []),
    ...client.contacts.flatMap((c) => [
      ...(c.emailNormalized ? [{ channel: "EMAIL" as const, addressNormalized: c.emailNormalized }] : []),
      ...(c.phoneNormalized ? [{ channel: "SMS" as const, addressNormalized: c.phoneNormalized }] : []),
    ]),
  ];
  const suppressions = addresses.length
    ? await prisma.suppression.findMany({ where: { liftedAt: null, OR: addresses } })
    : [];

  const people = [{ id: null as string | null, name: `${client.displayName} (primary)` }, ...client.contacts.map((c) => ({ id: c.id as string | null, name: c.name }))];
  const forPerson = (pid: string | null) => client.consentRecords.filter((r) => r.contactId === pid);
  const clientLevel = forPerson(null);

  return (
    <>
      <BusinessTabs clientId={id} base="/clients" />
      <PageHeader
        title={client.displayName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {client.businessName && client.businessName !== client.displayName && <span>{client.businessName}</span>}
            <Badge tone={client.status === "ACTIVE" ? "green" : client.status === "PROSPECT" ? "gold" : "gray"}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
            <Badge>{CLIENT_TYPE_LABELS[client.clientType]}</Badge>
            {client.taxReturnDerived && <Badge tone="amber">From tax-prep data</Badge>}
            {client.archivedAt && <Badge tone="red">Archived {fmtDate(client.archivedAt)}</Badge>}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/clients/${id}/edit`}>Edit</LinkButton>
            {client.archivedAt ? (
              <ConfirmButton action={setArchivedAction.bind(null, id, false)}>Restore</ConfirmButton>
            ) : (
              <ConfirmButton action={setArchivedAction.bind(null, id, true)} variant="danger" confirm="Archive this client? Their history is kept and you can restore them anytime.">
                Archive
              </ConfirmButton>
            )}
          </>
        }
      />
      {client.archivedAt && (
        <div className="mb-4"><Notice tone="warn">This client is archived. They won&apos;t receive campaigns or portal access. All history is kept.</Notice></div>
      )}

      <nav aria-label="Client sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-navy-100 bg-white p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/clients/${id}${t.key === "overview" ? "" : `?tab=${t.key}`}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${tab === t.key ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50"}`}
          >
            {t.label}
            {t.key === "documents" && newDocs > 0 && (
              <span className="ml-1.5 rounded-full bg-gold-500 px-2 text-xs font-bold text-navy-950" aria-label={`${newDocs} new documents`} data-testid="new-docs-badge">{newDocs} new</span>
            )}
          </Link>
        ))}
        <Link href={`/clients/${id}/portal-preview`} className="ml-auto whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold text-gold-700 hover:bg-gold-100">
          Preview portal ↗
        </Link>
      </nav>

      {tab === "messages" && <MessagesTab clientId={id} conversationId={sp.c} user={user} />}
      {tab === "documents" && <DocumentsTab clientId={id} user={user} />}
      {tab === "bookkeeping" && <BookkeepingTab clientId={id} />}
      {tab === "taxes" && <TaxesTab clientId={id} user={user} />}
      {tab === "portal" && <PortalTab clientId={id} contacts={client.contacts} isAdmin={user.role === "ADMIN"} actor={user} />}

      {tab === "overview" && (
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="font-semibold text-slate-600">Email</dt><dd>{client.email ?? "—"}</dd></div>
              <div><dt className="font-semibold text-slate-600">Mobile</dt><dd>{client.phoneNormalized ? formatPhone(client.phoneNormalized) : client.phone ?? "—"}</dd></div>
              <div className="sm:col-span-2">
                <dt className="font-semibold text-slate-600">Mailing address</dt>
                <dd>{[client.addressLine1, client.addressLine2, [client.city, client.state].filter(Boolean).join(", "), client.postalCode].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
              <div><dt className="font-semibold text-slate-600">Services</dt><dd>{client.services.join(", ") || "—"}</dd></div>
              <div><dt className="font-semibold text-slate-600">Assigned to</dt><dd>{client.assignedTo?.name ?? "Unassigned"}</dd></div>
              <div><dt className="font-semibold text-slate-600">Groups</dt><dd className="flex flex-wrap gap-1">{client.groups.length ? client.groups.map((g) => <Badge key={g.groupId} tone="gold">{g.group.name}</Badge>) : "—"}</dd></div>
              <div><dt className="font-semibold text-slate-600">Tags</dt><dd className="flex flex-wrap gap-1">{client.tags.length ? client.tags.map((t) => <Badge key={t} tone="gray">{t}</Badge>) : "—"}</dd></div>
              <div className="sm:col-span-2"><dt className="font-semibold text-slate-600">Source</dt><dd>{client.source ?? "—"}</dd></div>
              {client.notes && <div className="sm:col-span-2"><dt className="font-semibold text-slate-600">Notes</dt><dd className="whitespace-pre-wrap">{client.notes}</dd></div>}
            </dl>
          </Card>

          <Card title="Contacts" actions={<span className="text-sm text-slate-600">People at this business or household</span>}>
            {client.contacts.length > 0 && (
              <ul className="mb-4 divide-y divide-navy-100">
                {client.contacts.map((c) => (
                  <li key={c.id} className="py-3">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                        <span>
                          <span className="font-semibold text-navy-900">{c.name}</span>
                          {c.title && <span className="text-slate-600"> · {c.title}</span>}
                          <span className="block text-sm text-slate-600">{[c.email, c.phoneNormalized && formatPhone(c.phoneNormalized)].filter(Boolean).join(" · ") || "No contact details"}</span>
                        </span>
                        <span className="text-sm underline">Edit</span>
                      </summary>
                      <ActionForm action={saveContactAction.bind(null, id, c.id)} className="mt-3 grid gap-3 sm:grid-cols-2">
                        <Field label="Name"><input className="input" name="name" defaultValue={c.name} required /></Field>
                        <Field label="Preferred name" hint="Portal greeting for a business"><input className="input" name="preferredName" defaultValue={c.preferredName ?? ""} /></Field>
                        <Field label="Title"><input className="input" name="title" defaultValue={c.title ?? ""} /></Field>
                        <Field label="Email"><input className="input" type="email" name="email" defaultValue={c.email ?? ""} /></Field>
                        <Field label="Mobile phone"><input className="input" type="tel" name="phone" defaultValue={c.phone ?? ""} /></Field>
                        <div className="flex gap-2 sm:col-span-2">
                          <Button type="submit">Save contact</Button>
                          <ConfirmButton action={removeContactAction.bind(null, id, c.id)} variant="danger" confirm={`Remove ${c.name}? Their permission history is removed with them.`}>Remove</ConfirmButton>
                        </div>
                      </ActionForm>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Add a contact</summary>
              <ActionForm action={saveContactAction.bind(null, id, null)} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
                <Field label="Name"><input className="input" name="name" required /></Field>
                <Field label="Preferred name" hint="Portal greeting for a business"><input className="input" name="preferredName" /></Field>
                <Field label="Title"><input className="input" name="title" placeholder="e.g. Office manager" /></Field>
                <Field label="Email"><input className="input" type="email" name="email" /></Field>
                <Field label="Mobile phone"><input className="input" type="tel" name="phone" /></Field>
                <div className="sm:col-span-2"><Button type="submit">Add contact</Button></div>
              </ActionForm>
            </details>
          </Card>

          <Card title="Communication permissions">
            {suppressions.length > 0 && (
              <div className="mb-4">
                <Notice tone="error" title="Opted out / do not contact">
                  <ul className="list-disc pl-5">
                    {suppressions.map((s) => (
                      <li key={s.id}>
                        {s.channel === "SMS" ? formatPhone(s.addressNormalized) : s.addressNormalized} — {s.reason.toLowerCase()} on {fmtDate(s.createdAt)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1">Campaign selections can&apos;t override this. Only an Admin can lift an opt-out, with a documented reason.</p>
                </Notice>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="text-left text-slate-600">
                    <th className="py-2 pr-3 font-semibold">Person</th>
                    {PERSON_KINDS.map((k) => <th key={k} className="py-2 pr-3 font-semibold">{CONSENT_LABELS[k]}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-100">
                  {people.map((p) => (
                    <tr key={p.id ?? "primary"}>
                      <td className="py-2 pr-3 font-medium">{p.name}</td>
                      {PERSON_KINDS.map((k) => {
                        const s = currentConsent(forPerson(p.id), k);
                        return <td key={k} className="py-2 pr-3"><Badge tone={STATUS_TONE[s]}>{STATUS_TEXT[s]}</Badge></td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {TAX_INFO_KINDS.map((k) => {
                const s = currentConsent(clientLevel, k);
                return (
                  <div key={k} className="flex items-center justify-between rounded-lg border border-navy-100 px-3 py-2 text-sm">
                    <span>{CONSENT_LABELS[k]}</span>
                    <Badge tone={STATUS_TONE[s]}>{s === "GRANTED" ? "Signed & reviewed" : STATUS_TEXT[s]}</Badge>
                  </div>
                );
              })}
            </div>

            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Record a permission change</summary>
              <ActionForm action={recordConsentAction.bind(null, id)} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
                <Field label="Permission">
                  <select className="input" name="kind" required>
                    {Object.entries(CONSENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </Field>
                <Field label="Status">
                  <select className="input" name="status" required>
                    <option value="GRANTED">Agreed (opted in)</option>
                    <option value="REVOKED">Withdrawn (opted out)</option>
                  </select>
                </Field>
                <Field label="Person" hint="Section 7216 consents always belong to the client.">
                  <select className="input" name="contactId">
                    {people.map((p) => <option key={p.id ?? "primary"} value={p.id ?? ""}>{p.name}</option>)}
                  </select>
                </Field>
                <Field label="Source" hint='Where it came from, e.g. "Signed consent form", "Phone call".'>
                  <input className="input" name="source" required />
                </Field>
                <Field label="Scope" className="sm:col-span-2" hint="Exactly what they agreed to. Required for Section 7216.">
                  <input className="input" name="scope" />
                </Field>
                <Field label="Date given"><input className="input" type="date" name="effectiveAt" max={new Date().toISOString().slice(0, 10)} /></Field>
                <Field label="Expires (if any)" hint="7216 consents usually state a duration."><input className="input" type="date" name="expiresAt" /></Field>
                <Field label="Evidence document" hint="Signed form (PDF/JPG/PNG). Required for a Section 7216 grant.">
                  <input className="input" type="file" name="evidence" accept="application/pdf,image/png,image/jpeg" />
                </Field>
                <Field label="Evidence note"><input className="input" name="evidenceNote" placeholder="e.g. Original in client folder" /></Field>
                <div className="sm:col-span-2">
                  <Notice tone="info">
                    A marketing checkbox is not a Section 7216 consent. {user.role === "ADMIN"
                      ? "As an Admin, recording a 7216 grant confirms you reviewed the signed document and its scope."
                      : "Only an Admin can record a 7216 grant after reviewing the signed document. Anyone can record a withdrawal."}
                  </Notice>
                </div>
                <div className="sm:col-span-2"><Button type="submit">Record</Button></div>
              </ActionForm>
            </details>

            {client.consentRecords.length > 0 && (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Permission history ({client.consentRecords.length})</summary>
                <ul className="mt-2 divide-y divide-navy-100 text-sm">
                  {client.consentRecords.map((r) => (
                    <li key={r.id} className="py-2">
                      <p>
                        <strong>{CONSENT_LABELS[r.kind]}</strong> → {r.status === "GRANTED" ? "agreed" : r.status === "REVOKED" ? "withdrawn" : "unknown"}
                        {r.contact && <> · {r.contact.name}</>}
                      </p>
                      <p className="text-slate-600">
                        {fmtDate(r.effectiveAt)} · {r.source}{r.scope && <> · Scope: {r.scope}</>}
                        {r.expiresAt && <> · Expires {fmtDate(r.expiresAt)}</>} · Recorded by {r.recordedBy?.name ?? "system"}
                        {r.evidenceFile && <> · <a className="underline" href={`/api/files/${r.evidenceFile.id}`} target="_blank" rel="noopener">{r.evidenceFile.originalName}</a></>}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          <Card title="Activity">
            <ActionForm action={addNoteAction.bind(null, id)} className="mb-4 space-y-2" resetOnSuccess>
              <label className="block">
                <span className="sr-only">New note</span>
                <textarea className="input" name="body" rows={3} placeholder="Add a note (no SSNs or tax-return figures)" required />
              </label>
              <Button type="submit">Add note</Button>
            </ActionForm>
            {timeline.length === 0 ? (
              <p className="text-sm text-slate-600">No activity yet.</p>
            ) : (
              <ol className="relative space-y-4 border-l-2 border-navy-100 pl-4">
                {timeline.map((item) => (
                  <li key={item.id} className="relative">
                    <span className={`absolute -left-[23px] top-1.5 size-3 rounded-full ${item.kind === "note" ? "bg-gold-500" : item.kind === "task" ? "bg-navy-700" : "bg-slate-300"}`} aria-hidden />
                    <p className="text-sm font-semibold text-navy-900">{item.title}</p>
                    {item.body && <p className="whitespace-pre-wrap text-sm text-slate-700">{item.body}</p>}
                    <p className="text-xs text-slate-500">{fmtDateTime(item.at)}{item.by && <> · {item.by}</>}</p>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Open tasks">
            {client.tasks.length ? (
              <ul className="mb-3 space-y-2 text-sm">
                {client.tasks.map((t) => (
                  <li key={t.id} className="rounded-lg border border-navy-100 px-3 py-2">
                    <p className="font-medium">{t.title}</p>
                    <p className="text-slate-600">{t.assignee?.name ?? "Unassigned"} · due {fmtDate(t.dueAt)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-sm text-slate-600">No open tasks.</p>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-navy-800 underline">Add a follow-up</summary>
              <ActionForm action={saveTaskAction.bind(null, null)} className="mt-3 space-y-3" resetOnSuccess>
                <input type="hidden" name="clientId" value={id} />
                <Field label="Task"><input className="input" name="title" required placeholder="e.g. Request missing W-2" /></Field>
                <Field label="Assign to">
                  <select className="input" name="assigneeId" defaultValue={user.id}>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Due"><input className="input" type="date" name="dueAt" /></Field>
                <Field label="Priority">
                  <select className="input" name="priority" defaultValue="NORMAL">
                    <option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option>
                  </select>
                </Field>
                <Button type="submit">Add task</Button>
              </ActionForm>
            </details>
          </Card>
          <Card title="Record">
            <dl className="space-y-2 text-sm">
              <div><dt className="text-slate-600">Added</dt><dd>{fmtDateTime(client.createdAt)}</dd></div>
              <div><dt className="text-slate-600">Last updated</dt><dd>{fmtDateTime(client.updatedAt)}</dd></div>
            </dl>
            <p className="mt-3 text-sm"><Link className="underline" href="/clients">← All clients</Link></p>
          </Card>
        </div>
      </div>
      )}
    </>
  );
}
