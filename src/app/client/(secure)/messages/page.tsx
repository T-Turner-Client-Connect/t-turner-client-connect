import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice } from "@/components/ui";
import { ChevronRight, Mail, MessageCircleMore, Phone, Send } from "lucide-react";
import { NavyCard, PageBanner } from "@/components/portal/luxury";
import { MessageComposer } from "@/components/portal/message-composer";
import { BUSINESS } from "@/lib/business";
import { MAX_UPLOAD_LABEL } from "@/lib/files";
import { portalMessageAction } from "@/app/actions/portal";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { prisma } from "@/lib/prisma";
import { markClientRead, portalConversations } from "@/lib/services/messaging";
import { downloadToken } from "@/lib/services/documents";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Messages" };

export default async function PortalMessages({ searchParams }: { searchParams: Promise<{ account?: string; c?: string; new?: string; view?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current, accounts } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  if (!current.canMessage) return <Notice>Messaging isn&apos;t enabled for your access to this account.</Notice>;
  const q = `?account=${current.clientId}`;
  const conversations = await portalConversations(user, current.clientId);
  const selected = sp.c ? conversations.find((c) => c.id === sp.c) : undefined;
  const thread = selected
    ? await prisma.message.findMany({
        where: { conversationId: selected.id, channel: "PORTAL" },
        include: { staffAuthor: { select: { name: true } }, portalAuthor: { select: { name: true } }, attachments: { where: { visibility: "PUBLISHED", deletedAt: null, category: { not: "OWNER_K1" } }, select: { id: true, title: true } } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  if (selected) await markClientRead(user, selected.id);

  const composer = (
    <ActionForm action={portalMessageAction.bind(null, current.clientId)} className="space-y-3" resetOnSuccess idempotent>
      {selected && <input type="hidden" name="conversationId" value={selected.id} />}
      {!selected && <Field label="Subject"><input className="input" name="subject" required maxLength={200} /></Field>}
      <Field label="Message">
        <textarea className="input" name="body" rows={4} required />
      </Field>
      {current.canUpload && <Field label="Attach a file (optional)" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>}
      <Button type="submit">Send securely</Button>
    </ActionForm>
  );

  const banner = <PageBanner icon={MessageCircleMore} title="Message Center" subtitle="Get in touch with our office quickly and securely." />;

  // Approved Message Center design (default view).
  if (!selected && sp.view !== "all") {
    const from = process.env.TWILIO_FROM_NUMBER?.replace(/\D/g, "") ?? "";
    // Text uses the firm's Twilio business number only once it is connected.
    const textNumber = from.length === 11 && from.startsWith("1") && process.env.TWILIO_ACCOUNT_SID ? { tel: `+${from}`, display: `${from.slice(1, 4)}-${from.slice(4, 7)}-${from.slice(7)}` } : null;
    const office = "info@tturnerassociates.com";
    const row = "flex items-center gap-4 rounded-xl border border-gold-300 bg-gold-50/70 px-4 py-3 shadow-sm hover:border-gold-500 hover:bg-gold-50";
    return (
      <>
        {banner}
        <div className="grid items-start gap-6 grid-cols-1 lg:grid-cols-[0.7fr_1.6fr]" data-testid="message-center">
          <div className="min-w-0 space-y-6">
            <NavyCard icon={Mail} title="Contact Our Office">
              <div className="space-y-3">
                {textNumber && (
                  <a href={`sms:${textNumber.tel}`} className={row}>
                    <MessageCircleMore className="size-9 shrink-0 text-gold-600" aria-hidden />
                    <span className="min-w-0 flex-1"><span className="block text-lg font-semibold text-navy-900">Text Our Office</span><span className="text-slate-600">Send a text message</span></span>
                    <ChevronRight className="size-5 text-gold-600" aria-hidden />
                  </a>
                )}
                <a href={`mailto:${office}`} className={row}>
                  <Mail className="size-9 shrink-0 text-gold-600" aria-hidden />
                  <span className="min-w-0 flex-1"><span className="block text-lg font-semibold text-navy-900">Email Our Office</span><span className="text-slate-600">Send us an email</span></span>
                  <ChevronRight className="size-5 text-gold-600" aria-hidden />
                </a>
                <a href={`tel:${BUSINESS.officePhoneTel}`} className={row}>
                  <Phone className="size-9 shrink-0 text-gold-600" aria-hidden />
                  <span className="min-w-0 flex-1"><span className="block text-lg font-semibold text-navy-900">Call Our Office</span><span className="font-semibold text-navy-900">{BUSINESS.officePhoneDisplay}</span></span>
                  <ChevronRight className="size-5 text-gold-600" aria-hidden />
                </a>
              </div>
            </NavyCard>
            <NavyCard icon={Mail} title="Recent Messages">
              {conversations.length === 0 ? (
                <p className="py-2 text-slate-600">No messages yet.</p>
              ) : (
                <ul className="divide-y divide-ivory-200">
                  {conversations.slice(0, 3).map((c) => (
                    <li key={c.id}>
                      <Link href={`/client/messages${q}&c=${c.id}`} className="flex items-center gap-3 py-3">
                        <span className={`size-3 shrink-0 rounded-full ${c._count.messages > 0 ? "bg-emerald-600" : "bg-ivory-300"}`} aria-label={c._count.messages > 0 ? "New reply" : undefined} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-lg font-semibold text-navy-900">{c.subject}</span>
                          <span className="line-clamp-2 block text-slate-600">{c.messages[0]?.body}</span>
                          <span className="block text-sm text-slate-500">{fmtDateTime(c.lastMessageAt)}</span>
                        </span>
                        <ChevronRight className="size-5 shrink-0 text-gold-600" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link href={`/client/messages${q}&view=all`} className="mt-3 block rounded-xl border-2 border-gold-500 bg-gradient-to-b from-white to-gold-50 py-2.5 text-center font-semibold text-navy-900 hover:to-gold-100">View All Messages</Link>
            </NavyCard>
          </div>
          <section className="min-w-0 rounded-2xl border border-ivory-200 bg-white p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:p-6">
            <h2 className="mb-4 flex items-center gap-3 font-serif text-xl sm:text-xl font-bold text-navy-900"><Send className="size-6 text-gold-600" aria-hidden />Send a Message</h2>
            {accounts.length > 1 && <p className="mb-4 text-xs text-slate-600" data-testid="message-target">Sending about: <strong className="text-navy-900">{current.client.businessName || current.client.displayName}</strong></p>}
            <MessageComposer action={portalMessageAction.bind(null, current.clientId)} canUpload={current.canUpload} textNumber={textNumber} email={office} uploadLabel={MAX_UPLOAD_LABEL} />
          </section>
        </div>
      </>
    );
  }

  return (
    <>
      {banner}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-2">
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
        <div className="min-w-0 lg:col-span-2">
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
                      <p className={`mt-1 text-xs ${mine ? "text-navy-100" : "text-slate-500"}`}>{mine ? m.portalAuthor?.name ?? "You" : m.staffAuthor?.name ?? "T. Turner & Associates"} · {fmtDateTime(m.createdAt)}</p>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="mb-2 text-xs text-slate-600" data-testid="message-target">{selected ? "About" : "Sending about"}: <strong className="text-navy-900">{current.client.businessName || current.client.displayName}</strong></p>
            {composer}
          </Card>
        </div>
      </div>
    </>
  );
}
