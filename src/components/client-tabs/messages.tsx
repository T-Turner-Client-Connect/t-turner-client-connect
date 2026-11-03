import Link from "next/link";
import type { Actor } from "@/lib/auth/actor";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice } from "@/components/ui";
import { conversationStateAction, staffMessageAction } from "@/app/actions/workspace";
import { prisma } from "@/lib/prisma";
import { channelAvailability, markStaffRead } from "@/lib/services/messaging";
import { clientTextingOn } from "@/lib/services/staff-alerts";
import { downloadToken } from "@/lib/services/documents";
import { fmtDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/normalize";

const CHANNEL_LABEL = { PORTAL: "Portal", EMAIL: "Email", SMS: "Text", INTERNAL_NOTE: "Internal note" } as const;
const STATUS_LABEL: Record<string, string> = {
  DELIVERED: "Delivered to portal",
  QUEUED: "Queued",
  PROVIDER_ACCEPTED: "Accepted by provider",
  FAILED: "Failed",
  BOUNCED: "Bounced",
  UNSUBSCRIBED: "Unsubscribed",
  SIMULATED: "Simulated (not sent)",
};
// Texts: Twilio accepts first, then its delivery receipt says Delivered or Failed.
const SMS_STATUS_LABEL: Record<string, string> = { QUEUED: "Sending…", PROVIDER_ACCEPTED: "Sent (waiting for delivery receipt)", DELIVERED: "Delivered", FAILED: "Not delivered" };
const statusLabel = (m: { channel: string; direction: string; status: string }) =>
  m.channel === "SMS" ? (m.direction === "INBOUND" ? "Received by text" : SMS_STATUS_LABEL[m.status] ?? m.status) : m.channel === "EMAIL" && m.status === "DELIVERED" ? "Delivered" : STATUS_LABEL[m.status];

export async function MessagesTab({ clientId, conversationId, user }: { clientId: string; conversationId?: string; user: Actor }) {
  const [client, portalUsers] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { email: true, phoneNormalized: true } }),
    prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, canMessage: true }, include: { portalUser: { select: { name: true } } } }),
  ]);
  const recipients: Record<string, string> = {
    PORTAL: portalUsers.length ? portalUsers.map((p) => p.portalUser.name).join(", ") + " (portal)" : "No one has portal access yet — invite them on the Portal tab",
    EMAIL: client.email ?? "No email on file",
    SMS: client.phoneNormalized ?? "No mobile number on file",
    INTERNAL_NOTE: "Staff only — never visible to the client",
  };
  const [conversations, staff, docs] = await Promise.all([
    prisma.conversation.findMany({
      where: { clientId },
      include: { assignedTo: { select: { name: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: { where: { channel: "SMS" } } } } },
      orderBy: { lastMessageAt: "desc" },
    }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.document.findMany({ where: { clientId, deletedAt: null, scanStatus: "CLEAN" }, select: { id: true, title: true, visibility: true }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const selected = conversationId ? conversations.find((c) => c.id === conversationId) : undefined;
  const thread = selected
    ? await prisma.message.findMany({
        where: { conversationId: selected.id },
        include: { staffAuthor: { select: { name: true } }, portalAuthor: { select: { name: true } }, attachments: { select: { id: true, title: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  if (selected?.unreadByStaff) await markStaffRead(selected.id);
  const channels = channelAvailability(await clientTextingOn());
  // Portal and text (SMS) conversations stay separate: a text thread offers only Text and notes,
  // a portal thread only Portal, Email and notes.
  const selectedIsSms = !!selected && selected._count.messages > 0;
  const channelKeys = (Object.keys(channels) as (keyof typeof channels)[]).filter((ch) =>
    !selected ? true : selectedIsSms ? ch === "SMS" || ch === "INTERNAL_NOTE" : ch !== "SMS",
  );
  const defaultChannel = selectedIsSms ? (channels.SMS.available ? "SMS" : "INTERNAL_NOTE") : "PORTAL";

  const composer = (
    <ActionForm action={staffMessageAction.bind(null, clientId)} className="space-y-3" resetOnSuccess idempotent>
      {selected && <input type="hidden" name="conversationId" value={selected.id} />}
      <fieldset>
        <legend className="mb-1 text-sm font-semibold text-navy-900">Send by</legend>
        <div className="flex flex-wrap gap-2">
          {channelKeys.map((ch) => (
            <label key={ch} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${channels[ch].available ? "border-navy-100" : "border-dashed border-slate-300 text-slate-500"}`}>
              <input type="radio" name="channel" value={ch} defaultChecked={ch === defaultChannel} disabled={!channels[ch].available} className="accent-navy-900" />
              {ch === "SMS" ? "Send Text Message (SMS)" : CHANNEL_LABEL[ch]}
              {!channels[ch].available && <Badge tone="gray">{ch === "SMS" && channels.SMS.note.startsWith("Client texting is off") ? "Off" : "Setup required"}</Badge>}
            </label>
          ))}
        </div>
        <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
          {channelKeys.map((ch) => <li key={ch}><strong>{CHANNEL_LABEL[ch]}</strong> → {recipients[ch]}</li>)}
        </ul>
        <p className="mt-1 text-xs text-slate-600">Use the portal for anything about taxes, statements or account details. Email and text should only point clients to the portal.</p>
        <p className="mt-1 text-xs text-slate-600" data-testid="sms-channel-note"><strong>Text:</strong> {channels.SMS.note} Texts are limited to 1,000 characters; the first text to a client adds “Reply STOP to opt out, HELP for help.”</p>
      </fieldset>
      {!selected && <Field label="Subject (portal and email; texts go in the client's Text Messages thread)"><input className="input" name="subject" maxLength={200} /></Field>}
      <Field label="Message"><textarea className="input" name="body" rows={4} required /></Field>
      {docs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm underline">Attach documents (portal only)</summary>
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm">
            {docs.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <input type="checkbox" name="attachmentIds" value={d.id} className="accent-navy-900" /> {d.title}
                {d.visibility === "STAFF_ONLY" && <Badge tone="amber">Will be published to the client</Badge>}
              </label>
            ))}
          </div>
        </details>
      )}
      <Button type="submit">{selected ? "Send" : "Start conversation"}</Button>
    </ActionForm>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-2">
        <Link href={`/clients/${clientId}?tab=messages`} className="block rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-semibold text-navy-900 hover:border-navy-700">+ New conversation</Link>
        {conversations.length === 0 ? (
          <EmptyState title="No conversations yet" />
        ) : (
          <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link href={`/clients/${clientId}?tab=messages&c=${c.id}`} className={`block px-3 py-2 hover:bg-navy-50 ${c.id === selected?.id ? "bg-navy-50" : ""}`}>
                  <p className="flex items-center justify-between gap-2 font-semibold text-navy-900">
                    <span className="flex min-w-0 items-center gap-1.5"><Badge tone={c._count.messages ? "green" : "navy"}>{c._count.messages ? "SMS" : "Portal"}</Badge><span className="truncate">{c.subject}</span></span>
                    {c.awaitingStaff && <Badge tone="gold">Needs reply</Badge>}
                  </p>
                  <p className="truncate text-sm text-slate-600">{c.messages[0]?.body}</p>
                  <p className="text-xs text-slate-500">{fmtDateTime(c.lastMessageAt)} · {c.assignedTo?.name ?? "Unassigned"}{c.closedAt ? " · Closed" : ""}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="lg:col-span-2">
        {selected ? (
          <Card title={`${selectedIsSms ? "Text messages (SMS)" : "Portal conversation"} · ${selected.subject}`}>
            <ActionForm action={conversationStateAction.bind(null, clientId, selected.id)} className="mb-4 flex flex-wrap items-end gap-2" showSuccess={false}>
              <Field label="Handled by">
                <select className="input" name="assignedToId" defaultValue={selected.assignedToId ?? ""}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === user.id ? " (me)" : ""}</option>)}
                </select>
              </Field>
              <Button variant="secondary" type="submit">Save</Button>
            </ActionForm>
            <ol className="mb-4 space-y-3">
              {thread.map((m) => {
                const out = m.direction === "OUTBOUND";
                if (m.channel === "INTERNAL_NOTE") {
                  return (
                    <li key={m.id} className="mx-auto max-w-[90%] rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2 text-amber-950">
                      <p className="text-xs font-bold uppercase tracking-wide">Internal note · staff only</p>
                      <p className="whitespace-pre-wrap text-[15px]">{m.body}</p>
                      <p className="mt-1 text-xs">{m.staffAuthor?.name ?? "Automatic note"} · {fmtDateTime(m.createdAt)}</p>
                    </li>
                  );
                }
                const sms = m.channel === "SMS";
                const bubble = sms ? (out ? "ml-auto border-2 border-emerald-700 bg-emerald-800 text-white" : "border-2 border-emerald-300 bg-emerald-50 text-emerald-950") : out ? "ml-auto bg-navy-900 text-white" : "bg-navy-50 text-navy-950";
                return (
                  <li key={m.id} data-testid={`msg-${m.channel.toLowerCase()}`} className={`max-w-[85%] rounded-2xl px-4 py-2 ${bubble}`}>
                    {sms && <p className="text-[11px] font-bold uppercase tracking-wide opacity-80">{out ? "Text sent (SMS)" : "Text received (SMS)"}</p>}
                    <p className="whitespace-pre-wrap text-[15px]">{m.body}</p>
                    {m.attachments.map((a) => (
                      <a key={a.id} className={`mt-1 block text-sm underline ${out ? "text-gold-300" : ""}`} href={`/api/documents/${downloadToken(a.id, { staffId: user.id })}`} target="_blank" rel="noopener">📎 {a.title}</a>
                    ))}
                    <p className={`mt-1 text-xs ${out ? "text-navy-100" : "text-slate-500"}`}>
                      {CHANNEL_LABEL[m.channel]} · {out ? m.staffAuthor?.name ?? "Staff" : m.portalAuthor?.name ?? (sms ? `Client · ${formatPhone(client.phoneNormalized)}` : "Client")} · {fmtDateTime(m.createdAt)} · {statusLabel(m)}
                      {out && m.channel === "PORTAL" && (m.readByClientAt ? " · Read" : " · Not read yet")}
                      {m.errorDetail && ` · ${m.errorDetail}`}
                    </p>
                  </li>
                );
              })}
            </ol>
            {composer}
          </Card>
        ) : (
          <Card title="New conversation">
            <div className="mb-3"><Notice>The client gets a notice by email or text (per their preferences) with a sign-in link — never the message itself.</Notice></div>
            {composer}
          </Card>
        )}
      </div>
    </div>
  );
}
