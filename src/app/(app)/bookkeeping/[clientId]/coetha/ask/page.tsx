import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { KeyRound, MessagesSquare, Paperclip, Power, ShieldCheck, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BusinessTabs } from "@/components/business-tabs";
import { ActionForm } from "@/components/action-form";
import { canUseLedger } from "@/lib/services/ledger";
import { COETHA_NO_KEY } from "@/lib/services/coetha";
import { COETHA_CHAT_PRIVACY, coethaChatView, MAX_QUESTION } from "@/lib/services/coetha-chat";
import { askCoethaAction } from "@/app/actions/coetha";
import { fmtDateTime } from "@/lib/format";
import { downloadToken } from "@/lib/services/documents";
import { CoethaUploadButton } from "@/components/coetha-upload-button";

export const metadata = { title: "Ask Coetha" };

const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";

const STARTERS = [
  "What still needs to be done to close last month?",
  "Which transactions waiting for review look like owner draws instead of expenses?",
  "Are there any possible duplicates in the recent transactions?",
  "Explain the biggest expense categories this month.",
];

export default async function AskCoethaPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true } });
  if (!client) notFound();
  const biz = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;

  if (!(await canUseLedger(user, clientId))) {
    return (
      <>
        <p className="mb-2 text-sm"><Link className="underline" href={base}>← Client Overview</Link></p>
        <div className={clsx(card, "p-6 text-navy-900")} data-testid="coetha-chat-no-access">Only Admins and the staff member assigned to {biz} can talk with Coetha about this business&apos;s books.</div>
      </>
    );
  }

  const v = await coethaChatView(user, clientId);

  return (
    <div className="space-y-5" data-testid="coetha-chat-page">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link className="underline" href={base}>← Client Overview</Link>
        <Link className="underline" href={`${base}/coetha`}>Coetha&apos;s drafts &amp; runs</Link>
      </p>
      <BusinessTabs clientId={clientId} base="/bookkeeping" isAdmin={user.role === "ADMIN"} />

      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-8">
        <div className="flex min-w-0 items-start gap-4">
          <span className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-lg border-2 border-gold-400"><MessagesSquare className="size-7 text-gold-400" aria-hidden /></span>
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-bold leading-tight text-white sm:text-3xl">Ask Coetha</h1>
            <p className="mt-1 border-t border-gold-500/40 pt-1 text-base text-navy-100">Client: <strong className="text-white" data-testid="coetha-chat-client">{biz}</strong></p>
            <p className="mt-2 text-sm text-navy-100">Talk with Coetha about this business&apos;s books only. She answers from its ledger and can explain, check and suggest, but she can&apos;t post or change anything. Corrections still go through Coetha&apos;s drafts and Tabitha&apos;s approval.</p>
          </div>
        </div>
      </section>

      {v.optedOut && <div className={clsx(card, "p-4 text-sm text-navy-900")} data-testid="coetha-chat-opted-out">This client prefers no Coetha, so Coetha can&apos;t be asked about their books.</div>}
      {!v.status.enabled && (
        <div className={clsx(card, "flex items-start gap-3 p-4 text-sm text-navy-900")} data-testid="coetha-chat-off">
          <Power className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />
          <p><strong>Coetha AI is turned off.</strong> Tabitha turns it on in the <Link className="font-semibold underline" href="/owner/automation">Owner&apos;s Office → Coetha &amp; bank feeds</Link>.</p>
        </div>
      )}
      {!v.status.keyPresent && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status" data-testid="coetha-chat-no-key">
          <KeyRound className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p><strong>{COETHA_NO_KEY}</strong></p>
        </div>
      )}
      {!v.hasBook && <div className={clsx(card, "p-4 text-sm text-navy-900")}>Set up this business&apos;s books first in <Link className="font-semibold underline" href={`${base}/books`}>Books &amp; Ledger</Link>.</div>}

      {/* The conversation */}
      <section className={clsx(card, "p-4 sm:p-5")} aria-label="Conversation with Coetha" data-testid="coetha-chat-thread">
        {v.messages.length === 0 ? (
          <div className="text-sm text-navy-900">
            <p className="font-semibold">No conversation yet for {biz}.</p>
            <p className="mt-1 text-slate-600">Some questions you could ask:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
              {STARTERS.map((s) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        ) : (
          <ol className="space-y-3">
            {v.messages.map((m) => (
              <li key={m.id} className={clsx("flex", m.role === "USER" ? "justify-end" : "justify-start")} data-testid={m.role === "USER" ? "chat-question" : "chat-answer"}>
                <div className={clsx("max-w-[min(42rem,92%)] rounded-2xl px-4 py-3 text-sm shadow-sm", m.role === "USER" ? "bg-navy-900 text-white" : "border border-gold-200 bg-white text-navy-900")}>
                  <p className={clsx("mb-1 flex flex-wrap items-center gap-x-2 text-xs", m.role === "USER" ? "text-navy-100" : "text-slate-600")}>
                    {m.role === "COETHA" && <Sparkles className="size-3.5 text-gold-600" aria-hidden />}
                    <span className="font-semibold">{m.author}</span>
                    <span>{fmtDateTime(m.createdAt)}</span>
                  </p>
                  {m.attachmentName && (
                    <p className="mb-1 flex items-center gap-1 text-xs" data-testid="chat-attachment">
                      <Paperclip className="size-3.5" aria-hidden />
                      {m.documentId ? <a className="underline" href={`/api/documents/${downloadToken(m.documentId, { staffId: user.id })}`} target="_blank" rel="noopener">{m.attachmentName}</a> : m.attachmentName}
                    </p>
                  )}
                  <div className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Ask */}
      {v.canAsk ? (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-chat-ask">
          <ActionForm action={askCoethaAction.bind(null, clientId)} resetOnSuccess showSuccess={false} idempotent>
            <label htmlFor="coetha-question" className="block text-sm font-semibold text-navy-900">Your question about {biz}&apos;s books</label>
            <textarea id="coetha-question" name="question" maxLength={MAX_QUESTION} rows={3} className="mt-1 w-full rounded-lg border border-ivory-300 bg-white px-3 py-2 text-base text-navy-900 focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-300" placeholder="e.g. Why is the October bank balance different from the statement?" data-testid="coetha-chat-input" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <CoethaUploadButton />
              <button type="submit" className="group inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-5 py-2 text-sm font-semibold text-navy-950 shadow hover:to-gold-600 disabled:opacity-70" data-testid="coetha-chat-send">
                <Sparkles className="size-4" aria-hidden />
                <span className="group-disabled:hidden">Ask Coetha</span>
                <span className="hidden group-disabled:inline">Coetha is thinking…</span>
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-600">Coetha sees this business&apos;s books only. You can send one document with a question: a check image, a statement page, a receipt or an invoice (PDF or picture, up to 5 MB). It&apos;s kept with this business as a staff-only document. Answers can take up to a minute.</p>
          </ActionForm>
        </section>
      ) : null}

      <p className="flex items-start gap-2 rounded-xl bg-ivory-100 p-3 text-xs text-navy-800 ring-1 ring-ivory-200" data-testid="coetha-chat-privacy"><ShieldCheck className="size-4 shrink-0 text-gold-600" aria-hidden /> {COETHA_CHAT_PRIVACY}</p>
    </div>
  );
}
