import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field } from "@/components/ui";
import { ChevronRight, Mail, MessageCircleMore, Phone, Send } from "lucide-react";
import { NavyCard, PageBanner } from "@/components/portal/luxury";
import { MessageComposer } from "@/components/portal/message-composer";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { BUSINESS } from "@/lib/business";
import { MAX_UPLOAD_LABEL } from "@/lib/files";
import { fmtDateTime } from "@/lib/format";

type FormAction = (prev: { error?: string; ok?: string; at?: number } | null, fd: FormData) => Promise<{ error?: string; ok?: string; at?: number } | null>;

export type ConversationRow = { id: string; subject: string; lastMessageAt: Date; messages: { body: string }[]; _count: { messages: number } };
export type ThreadMessage = {
  id: string;
  body: string;
  direction: string;
  createdAt: Date;
  staffAuthor: { name: string } | null;
  portalAuthor: { name: string } | null;
  attachments: { id: string; title: string }[];
};
export type ThreadLetter = { id: string; messageId: string | null; acknowledgedAt: Date | null };

export const OFFICE_EMAIL = "info@tturnerassociates.com";

/** Text uses the firm's Twilio business number only once it is connected. */
export function officeTextNumber() {
  const from = process.env.TWILIO_FROM_NUMBER?.replace(/\D/g, "") ?? "";
  return from.length === 11 && from.startsWith("1") && process.env.TWILIO_ACCOUNT_SID ? { tel: `+${from}`, display: `${from.slice(1, 4)}-${from.slice(4, 7)}-${from.slice(7)}` } : null;
}

/**
 * Message Center, shared by the client's own page and View as Client. The page passes the
 * conversations, the open thread, its links (`hrefFor`) and the actions: the portal's own, or the
 * preview stand-ins with `readOnly` (the composer shows, disabled, with a note).
 */
export function MessagesPageView({
  conversations,
  selected,
  thread,
  letters,
  showAll,
  clientName,
  multiAccount,
  canUpload,
  hrefFor,
  linkFor,
  send,
  acknowledge,
  readOnly,
}: {
  conversations: ConversationRow[];
  selected: ConversationRow | undefined;
  thread: ThreadMessage[];
  letters: ThreadLetter[];
  showAll: boolean;
  clientName: string;
  multiAccount: boolean;
  canUpload: boolean;
  /** Query for the Message Center (without "?"), e.g. "c=…" or "view=all". */
  hrefFor: (query?: string) => string;
  linkFor: (documentId: string) => string;
  send: FormAction;
  acknowledge: (letterId: string) => FormAction;
  readOnly?: boolean;
}) {
  const letterOf = new Map(letters.map((l) => [l.messageId, l]));
  const banner = <PageBanner icon={MessageCircleMore} title="Message Center" subtitle="Get in touch with our office quickly and securely." />;

  // Approved Message Center design (default view).
  if (!selected && !showAll) {
    const textNumber = officeTextNumber();
    const office = OFFICE_EMAIL;
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
                <p className="py-2 text-slate-600" data-testid="messages-empty">No messages yet. Write to our office with <strong>Send a Message</strong>.</p>
              ) : (
                <ul className="divide-y divide-ivory-200">
                  {conversations.slice(0, 3).map((c) => (
                    <li key={c.id}>
                      <Link href={hrefFor(`c=${c.id}`)} className="flex items-center gap-3 py-3">
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
              <Link href={hrefFor("view=all")} className="mt-3 block rounded-xl border-2 border-gold-500 bg-gradient-to-b from-white to-gold-50 py-2.5 text-center font-semibold text-navy-900 hover:to-gold-100">View All Messages</Link>
            </NavyCard>
          </div>
          <section className="min-w-0 rounded-2xl border border-ivory-200 bg-white p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:p-6">
            <h2 className="mb-4 flex items-center gap-3 font-serif text-xl sm:text-xl font-bold text-navy-900"><Send className="size-6 text-gold-600" aria-hidden />Send a Message</h2>
            {multiAccount && <p className="mb-4 text-xs text-slate-600" data-testid="message-target">Sending about: <strong className="text-navy-900">{clientName}</strong></p>}
            <MessageComposer action={send} canUpload={canUpload} textNumber={textNumber} email={office} uploadLabel={MAX_UPLOAD_LABEL} readOnly={readOnly} />
          </section>
        </div>
      </>
    );
  }

  const composer = (
    <PreviewDisabled readOnly={readOnly}>
      <ActionForm action={send} className="space-y-3" resetOnSuccess idempotent>
        {selected && <input type="hidden" name="conversationId" value={selected.id} />}
        {!selected && <Field label="Subject"><input className="input" name="subject" required maxLength={200} /></Field>}
        <Field label="Message">
          <textarea className="input" name="body" rows={4} required />
        </Field>
        {canUpload && <Field label="Attach a file (optional)" hint="PDF, JPG or PNG up to 5 MB."><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>}
        <Button type="submit" data-testid="send-reply">Send securely</Button>
      </ActionForm>
    </PreviewDisabled>
  );

  return (
    <>
      {banner}
      <div className="grid gap-4 lg:grid-cols-3" data-testid="message-threads">
        <div className="min-w-0 space-y-2">
          <Link href={hrefFor()} className="block rounded-lg border border-navy-100 bg-white px-3 py-2 text-sm font-semibold text-navy-900">+ New message</Link>
          {conversations.length === 0 ? (
            <EmptyState title="No messages yet" />
          ) : (
            <ul className="divide-y divide-navy-100 rounded-xl border border-navy-100 bg-white">
              {conversations.map((c) => (
                <li key={c.id}>
                  <Link href={hrefFor(`c=${c.id}`)} className={`block px-3 py-2 hover:bg-navy-50 ${c.id === selected?.id ? "bg-navy-50" : ""}`}>
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
                  const l = letterOf.get(m.id);
                  return (
                    <li key={m.id} className={`max-w-[85%] rounded-2xl px-4 py-2 ${mine ? "ml-auto bg-navy-900 text-white" : "bg-navy-50"}`}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      {m.attachments.map((a) => (
                        <a key={a.id} className={`mt-1 block text-sm underline ${mine ? "text-gold-300" : ""}`} href={linkFor(a.id)} target="_blank" rel="noopener">📎 {a.title}</a>
                      ))}
                      <p className={`mt-1 text-xs ${mine ? "text-navy-100" : "text-slate-500"}`}>{mine ? m.portalAuthor?.name ?? "You" : m.staffAuthor?.name ?? "T. Turner & Associates"} · {fmtDateTime(m.createdAt)}</p>
                      {l && (
                        <div className="mt-3 rounded-xl border border-gold-300 bg-white px-3 py-2.5 text-sm text-navy-900" data-testid="letter-ack">
                          {l.acknowledgedAt ? (
                            <p data-testid="letter-acknowledged">You told us you read this notice on {fmtDateTime(l.acknowledgedAt)}. Thank you.</p>
                          ) : (
                            <PreviewDisabled readOnly={readOnly}>
                              <ActionForm action={acknowledge(l.id)} className="space-y-2">
                                <p>Optional: let us know you&apos;ve read this letter. You don&apos;t need to do anything else.</p>
                                <Button type="submit" variant="secondary" className="w-full sm:w-auto" data-testid="acknowledge-letter">I have read this notice</Button>
                              </ActionForm>
                            </PreviewDisabled>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="mb-2 text-xs text-slate-600" data-testid="message-target">{selected ? "About" : "Sending about"}: <strong className="text-navy-900">{clientName}</strong></p>
            {composer}
          </Card>
        </div>
      </div>
    </>
  );
}
