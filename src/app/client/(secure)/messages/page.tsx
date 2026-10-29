import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { portalMessageAction } from "@/app/actions/portal";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { prisma } from "@/lib/prisma";
import { markClientRead, portalConversations } from "@/lib/services/messaging";
import { downloadToken } from "@/lib/services/documents";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Messages" };

export default async function PortalMessages({ searchParams }: { searchParams: Promise<{ account?: string; c?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  if (!current.canMessage) return <Notice>Messaging isn&apos;t enabled for your access to this account.</Notice>;
  const q = `?account=${current.clientId}`;
  const conversations = await portalConversations(user, current.clientId);
  const selected = sp.c ? conversations.find((c) => c.id === sp.c) : undefined;
  const thread = selected
    ? await prisma.message.findMany({
        where: { conversationId: selected.id, channel: "PORTAL" },
        include: { staffAuthor: { select: { name: true } }, portalAuthor: { select: { name: true } }, attachments: { where: { visibility: "PUBLISHED", deletedAt: null }, select: { id: true, title: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  if (selected) await markClientRead(user, selected.id);

  const composer = (
    <ActionForm action={portalMessageAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess idempotent>
      {selected && <input type="hidden" name="conversationId" value={selected.id} />}
      {!selected && <Field label="Subject"><input className="input" name="subject" required maxLength={200} /></Field>}
      <Field label="Message"><textarea className="input" name="body" rows={4} required /></Field>
      {current.canUpload && <Field label="Attach a file (optional)" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>}
      <Button type="submit">Send securely</Button>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title="Messages" subtitle="Secure messages with TTurner & Associates Group." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2">
          <Link href={`/client/messages${q}`} className="block rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-semibold text-navy-900">+ New message</Link>
          {conversations.length === 0 ? (
            <EmptyState title="No messages yet" />
          ) : (
            <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
              {conversations.map((c) => (
                <li key={c.id}>
                  <Link href={`/client/messages${q}&c=${c.id}`} className={`block px-3 py-2 hover:bg-navy-50 ${c.id === selected?.id ? "bg-navy-50" : ""}`}>
                    <p className="flex items-center justify-between gap-2 font-semibold text-navy-900"><span className="truncate">{c.subject}</span>{c._count.messages > 0 && <Badge tone="gold">{c._count.messages} new</Badge>}</p>
                    <p className="truncate text-sm text-slate-600">{c.messages[0]?.body}</p>
                    <p className="text-xs text-slate-500">{fmtDateTime(c.lastMessageAt)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="lg:col-span-2">
          <Card title={selected ? selected.subject : "New message"}>
            {selected && (
              <ol className="mb-4 space-y-3">
                {thread.map((m) => {
                  const mine = m.direction === "INBOUND";
                  return (
                    <li key={m.id} className={`max-w-[85%] rounded-2xl px-4 py-2 ${mine ? "ml-auto bg-navy-900 text-white" : "bg-navy-50"}`}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      {m.attachments.map((a) => (
                        <a key={a.id} className={`mt-1 block text-sm underline ${mine ? "text-gold-300" : ""}`} href={`/api/documents/${downloadToken(a.id, { portalUserId: user.id })}`} target="_blank" rel="noopener">📎 {a.title}</a>
                      ))}
                      <p className={`mt-1 text-xs ${mine ? "text-navy-100" : "text-slate-500"}`}>{mine ? m.portalAuthor?.name ?? "You" : m.staffAuthor?.name ?? "TTurner & Associates Group"} · {fmtDateTime(m.createdAt)}</p>
                    </li>
                  );
                })}
              </ol>
            )}
            {composer}
          </Card>
        </div>
      </div>
    </>
  );
}
