import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Brain, ClipboardCheck, Download, FileSearch, KeyRound, Loader2, MessageSquarePlus, MessagesSquare, Paperclip, Power, ShieldCheck, Sparkles } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BusinessTabs } from "@/components/business-tabs";
import { ActionForm } from "@/components/action-form";
import { canUseLedger } from "@/lib/services/ledger";
import { COETHA_NO_KEY } from "@/lib/services/coetha";
import { COETHA_CHAT_PRIVACY, coethaChatView, MAX_QUESTION, newChatKey } from "@/lib/services/coetha-chat";
import { applyDecisionsAction, forgetMemoryAction, reverseAutoPostedAction, askCoethaAction, prepareFromDocumentAction, retryReadingAction, summarizeAgainAction } from "@/app/actions/coetha";
import { applyDecisionsView } from "@/lib/services/coetha-decisions";
import { memoryView } from "@/lib/services/coetha-memory";
import { readingView } from "@/lib/services/coetha-reading";
import { CoethaReadingPoller } from "@/components/coetha-reading-poller";
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

/** How many of the chat's newest messages the page shows before "See all messages". */
const SHORT = 6;

export default async function AskCoethaPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ chat?: string; all?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  const showAll = sp.all === "1";
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

  const v = await coethaChatView(user, clientId, { chat: sp.chat, limit: showAll ? 500 : SHORT });
  const chatHref = (key: string, all = false) => `${base}/coetha/ask?chat=${encodeURIComponent(key)}${all ? "&all=1" : ""}`;
  const reading = await readingView(user, clientId);
  const apply = await applyDecisionsView(user, clientId);
  const memory = await memoryView(user, clientId);
  const jobOf = new Map(reading.jobs.map((j) => [j.id, j]));
  const waiting = v.messages.some((m) => m.status === "WAITING");
  const usd = (c: number | null) => (c == null ? "" : (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));

  return (
    <div className="space-y-5" data-testid="coetha-chat-page">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link className="underline" href={base}>← Client Overview</Link>
        <Link className="underline" href={`${base}/coetha`}>Coetha&apos;s drafts &amp; runs</Link>
      </p>
      <BusinessTabs clientId={clientId} base="/bookkeeping" isAdmin={user.role === "ADMIN"} />

      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-4 py-3 text-white ring-1 ring-gold-500/40">
        <MessagesSquare className="size-6 shrink-0 text-gold-400" aria-hidden />
        <h1 className="font-serif text-xl font-bold leading-tight text-white sm:text-2xl">Ask Coetha</h1>
        <p className="min-w-0 text-sm text-navy-100">Client: <strong className="text-white" data-testid="coetha-chat-client">{biz}</strong> · this business&apos;s books only</p>
      </header>

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

      {/* Chats: older conversations on the side, the open chat (short) with the question box on top */}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className={clsx(card, "p-3 lg:sticky lg:top-4 lg:self-start")} aria-label="Chats with Coetha" data-testid="coetha-chat-list">
          <Link href={chatHref(newChatKey())} className="mb-2 flex items-center justify-center gap-2 rounded-lg bg-navy-900 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="coetha-new-chat"><MessageSquarePlus className="size-4" aria-hidden /> New chat</Link>
          <p className="px-1 text-xs text-slate-600">What Coetha remembers carries into every chat.</p>
          {v.chats.length === 0 ? <p className="mt-2 px-1 text-sm text-slate-600">No chats yet.</p> : (
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto lg:max-h-[32rem]">
              {v.chats.map((c) => (
                <li key={c.key}>
                  <Link href={chatHref(c.key)} aria-current={c.key === v.chat.key ? "page" : undefined} className={clsx("block rounded-lg px-2 py-1.5 text-sm", c.key === v.chat.key ? "bg-gold-100 font-semibold text-navy-950 ring-1 ring-gold-300" : "text-navy-900 hover:bg-ivory-100")} data-testid="coetha-chat-link">
                    <span className="line-clamp-2 break-words">{c.title}</span>
                    <span className="block text-xs font-normal text-slate-600">{fmtDateTime(c.lastAt)} · {c.count} message{c.count === 1 ? "" : "s"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0 space-y-3">
          {v.canAsk ? (
            <section className={clsx(card, "p-3 sm:p-4")} data-testid="coetha-chat-ask">
              <ActionForm action={askCoethaAction.bind(null, clientId)} resetOnSuccess showSuccess={false} idempotent>
                <input type="hidden" name="chat" value={v.chat.key} />
                <label htmlFor="coetha-question" className="block text-sm font-semibold text-navy-900">{v.chat.isNew ? "Start a new chat" : "Continue this chat"} about {biz}&apos;s books</label>
                <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <textarea id="coetha-question" name="question" maxLength={MAX_QUESTION} rows={2} className="w-full rounded-lg border border-ivory-300 bg-white px-3 py-2 text-base text-navy-900 focus:border-gold-500 focus:outline-none focus:ring-2 focus:ring-gold-300" placeholder="Ask a question, or upload files and Coetha will read them" data-testid="coetha-chat-input" />
                  <div className="flex flex-col gap-2 sm:w-48">
                    <CoethaUploadButton clientId={clientId} />
                    <button type="submit" className="group inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-5 py-2 text-sm font-semibold text-navy-950 shadow hover:to-gold-600 disabled:opacity-70" data-testid="coetha-chat-send">
                      <Sparkles className="size-4" aria-hidden />
                      <span className="group-disabled:hidden">Ask Coetha</span>
                      <span className="hidden group-disabled:inline">Coetha is thinking…</span>
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-600">Files (check scans, statements, receipts, invoices; PDFs or pictures up to 60 MB each) are saved as staff-only documents for this business, and Coetha reads them in the background.</p>
              </ActionForm>
            </section>
          ) : null}

          <section className={clsx(card, "p-3 sm:p-4")} aria-label="Conversation with Coetha" data-testid="coetha-chat-thread">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="min-w-0 break-words font-serif text-base font-bold text-navy-900" data-testid="coetha-chat-title">{v.chat.title}</h2>
              {v.chat.total > SHORT && (
                showAll
                  ? <Link className="text-xs font-semibold text-navy-900 underline" href={chatHref(v.chat.key)} data-testid="coetha-chat-fewer">Show the latest only</Link>
                  : <Link className="text-xs font-semibold text-navy-900 underline" href={chatHref(v.chat.key, true)} data-testid="coetha-chat-all">See all {v.chat.total} messages</Link>
              )}
            </div>
            {v.messages.length === 0 ? (
              <div className="text-sm text-navy-900">
                <p className="font-semibold">{v.chats.length ? "A fresh chat. Coetha still remembers your decisions and instructions for this business." : `No conversation yet for ${biz}.`}</p>
                <p className="mt-1 text-slate-600">Some questions you could ask:</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">
                  {STARTERS.map((q) => <li key={q}>{q}</li>)}
                </ul>
              </div>
            ) : (
              <>
                {!showAll && v.chat.total > v.messages.length && <p className="mb-2 text-xs text-slate-600">Showing the latest {v.messages.length} of {v.chat.total} messages.</p>}
              <ol className="space-y-3">
                {v.messages.map((m) => (
                  <li key={m.id} className={clsx("flex", m.role === "USER" ? "justify-end" : "justify-start")} data-testid={m.role === "USER" ? "chat-question" : "chat-answer"}>
                    <div className={clsx("max-w-[min(42rem,92%)] rounded-2xl px-4 py-3 text-sm shadow-sm", m.role === "USER" ? "bg-navy-900 text-white" : "border border-gold-200 bg-white text-navy-900")}>
                      <p className={clsx("mb-1 flex flex-wrap items-center gap-x-2 text-xs", m.role === "USER" ? "text-navy-100" : "text-slate-600")}>
                        {m.role === "COETHA" && <Sparkles className="size-3.5 text-gold-600" aria-hidden />}
                        <span className="font-semibold">{m.author}</span>
                        <span>{fmtDateTime(m.createdAt)}</span>
                      </p>
                      {m.attachments.length > 0 && (
                        <ul className="mb-1 space-y-0.5 text-xs" data-testid="chat-attachment">
                          {m.attachments.map((f, k) => (
                            <li key={k} className="flex items-center gap-1">
                              <Paperclip className="size-3.5 shrink-0" aria-hidden />
                              {f.documentId ? <a className="truncate underline" href={`/api/documents/${downloadToken(f.documentId, { staffId: user.id })}`} target="_blank" rel="noopener">{f.name}</a> : <span className="truncate">{f.name}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>
                      {m.role === "USER" && m.jobIds.length === 0 && m.status === "WAITING" && (
                        <p className="mt-2 flex items-center gap-1 rounded-lg bg-white/10 p-2 text-xs font-semibold" data-testid="chat-busy"><Loader2 className="size-3.5 animate-spin" aria-hidden /> The AI service was busy. Your question is saved; Coetha will answer it here shortly. No need to send it again.</p>
                      )}
                      {m.role === "USER" && m.jobIds.length === 0 && m.status === "FAILED" && (
                        <p className="mt-2 rounded-lg bg-white/10 p-2 text-xs font-semibold">Coetha couldn&apos;t answer this one after several tries (the AI service stayed busy). Send it again in a few minutes.</p>
                      )}
                      {m.jobIds.length > 0 && (
                        <div className="mt-2 space-y-1 rounded-lg bg-white/10 p-2 text-xs" data-testid="chat-reading">
                          {m.status === "WAITING" && <p className="flex items-center gap-1 font-semibold"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Coetha is reading. You can leave this page; her answer will appear here.</p>}
                          {m.status === "FAILED" && <p className="font-semibold">Coetha couldn&apos;t finish this answer. What she read is below; ask again to get her answer.</p>}
                          {m.role === "USER" && m.status !== "WAITING" && m.jobIds.every((id) => jobOf.get(id)?.status === "DONE" || jobOf.get(id)?.status === "FAILED") && (
                            <ActionForm action={summarizeAgainAction.bind(null, clientId, m.id)} className="mb-1" showSuccess={false}>
                              <button type="submit" className="rounded border border-current px-2 py-0.5 font-semibold" data-testid="summarize-again">Summarize Again</button>
                            </ActionForm>
                          )}
                          {m.jobIds.map((id) => {
                            const j = jobOf.get(id);
                            if (!j) return null;
                            return (
                              <div key={id} data-testid="chat-reading-file">
                                <p className="flex flex-wrap items-center gap-x-2">
                                  <FileSearch className="size-3.5" aria-hidden />
                                  <span className="font-semibold">{j.name}</span>
                                  <span>
                                    {j.status === "QUEUED" && "waiting to be read"}
                                    {j.status === "READING" && (j.pages ? `reading: ${j.pagesDone} of ${j.pages} pages` : "starting")}
                                    {j.status === "DONE" && `read${j.pages ? ` (${j.pages} page${j.pages === 1 ? "" : "s"})` : ""}${j.findings.length ? `, ${j.findings.length} item${j.findings.length === 1 ? "" : "s"} found` : ""}`}
                                    {j.status === "FAILED" && <>couldn&apos;t be read: {j.error}</>}
                                  </span>
                                </p>
                                {j.status === "FAILED" && (
                                  <ActionForm action={retryReadingAction.bind(null, clientId, j.id)} className="mt-1" showSuccess={false}>
                                    <button type="submit" className="rounded border border-current px-2 py-0.5 font-semibold" data-testid="reading-retry">Try again</button>
                                  </ActionForm>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              </>
            )}
          </section>
        </div>
      </div>

      {/* What Coetha remembers for this business */}
      <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-memory">
        <details>
          <summary className="flex cursor-pointer items-center gap-2 font-serif text-lg font-bold text-navy-900"><Brain className="size-5 text-gold-600" aria-hidden /> What Coetha remembers for {biz} <span className="rounded-full bg-navy-900 px-2 py-0.5 font-sans text-xs font-bold text-white">{memory.length}</span></summary>
          <p className="mt-1 text-xs text-slate-600">Your decisions, standing instructions and holds. Coetha applies them to every question about this business, so you don&apos;t have to repeat them. Tell her &ldquo;remember …&rdquo; to add one; she saves only what you state. Removing one keeps it in the history.</p>
          {memory.length === 0 ? <p className="mt-2 text-sm text-slate-600">Nothing yet.</p> : (
            <ul className="mt-2 divide-y divide-ivory-200 text-sm">
              {memory.map((m) => (
                <li key={m.id} className="flex flex-wrap items-start gap-2 py-1.5" data-testid="memory-note">
                  <span className={clsx("rounded px-1.5 py-0.5 text-xs font-semibold", m.kind === "HOLD" ? "bg-amber-100 text-amber-900" : m.kind === "DECISION" ? "bg-emerald-100 text-emerald-900" : "bg-ivory-200 text-navy-900")}>{m.label}</span>
                  <span className="min-w-0 flex-1 text-navy-900">{m.text}</span>
                  <span className="text-xs text-slate-600">{fmtDateTime(m.createdAt)}</span>
                  {apply.canApprove && (
                    <ActionForm action={forgetMemoryAction.bind(null, clientId, m.id)} showSuccess={false}>
                      <button type="submit" className="text-xs font-semibold text-navy-900 underline" data-testid="memory-remove">Remove</button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>

      {/* What Coetha posted on her own (routine items and Tabitha's stated decisions), reversible */}
      {apply.autoPosted.length > 0 && (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="auto-posted">
          <details>
            <summary className="flex cursor-pointer items-center gap-2 font-serif text-lg font-bold text-navy-900"><ClipboardCheck className="size-5 text-emerald-600" aria-hidden /> Posted automatically (last 14 days) <span className="rounded-full bg-emerald-700 px-2 py-0.5 font-sans text-xs font-bold text-white">{apply.autoPosted.length}</span></summary>
            <p className="mt-1 text-xs text-slate-600">Routine items and decisions you stated, posted by Coetha through the ledger (open months only, never twice). Reverse any of them; the bank row goes back to review.</p>
            <ul className="mt-2 divide-y divide-ivory-200 text-sm">
              {apply.autoPosted.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5" data-testid="auto-posted-entry">
                  <span className="whitespace-nowrap text-xs text-slate-600">{a.date}</span>
                  <span className="min-w-0 flex-1 text-navy-900">{a.memo}</span>
                  <span className="tabular-nums">{usd(a.amountCents)}</span>
                  <span className="rounded bg-ivory-200 px-1.5 py-0.5 text-xs">{a.basis === "rule" ? "a rule" : a.basis === "history" ? "same as before" : a.basis}</span>
                  {a.reversed ? <span className="text-xs font-semibold text-slate-600">Reversed</span> : apply.canApprove && (
                    <ActionForm action={reverseAutoPostedAction.bind(null, clientId, a.id)} showSuccess={false} confirm="Reverse this posting? The bank row goes back to review.">
                      <button type="submit" className="text-xs font-semibold text-navy-900 underline" data-testid="auto-posted-reverse">Reverse</button>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {/* Apply These Decisions: the entries Coetha prepared from Tabitha's decisions, for Approve & Post */}
      {apply.entries.length > 0 && (
        <section className={clsx(card, "border-2 border-gold-400 p-4 sm:p-5")} data-testid="apply-decisions">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><ClipboardCheck className="size-5 text-gold-600" aria-hidden /> Apply These Decisions <span className="rounded-full bg-navy-900 px-2 py-0.5 font-sans text-xs font-bold text-white">{apply.entries.length}</span></h2>
          <p className="mt-1 text-xs text-slate-600">Coetha prepared these entries from your decisions. Nothing is posted until you tick it and click Approve &amp; Post; anything you leave unticked stays on hold. Waiting bank rows are posted as they are (no new bank transaction), each entry posts once, and closed months are refused.</p>
          {apply.impact.length > 0 && (
            <div className="mt-3 rounded-lg bg-navy-900 p-3 text-sm text-white" data-testid="apply-impact">
              <p className="font-semibold text-gold-200">Effect on the books if every entry below is approved</p>
              <ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1">{apply.impact.map((i) => <li key={i.type}>{i.label}: <strong>{i.cents >= 0 ? "+" : "−"}{usd(Math.abs(i.cents))}</strong></li>)}</ul>
            </div>
          )}
          <ActionForm action={applyDecisionsAction.bind(null, clientId)} className="mt-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-xs">
                <thead><tr className="text-left text-slate-600"><th className="py-1 pr-2">{apply.canApprove ? "Approve" : ""}</th><th className="pr-2">Date</th><th className="pr-2">Entry</th><th className="pr-2">Debit</th><th className="pr-2">Credit</th><th className="pr-2 text-right">Amount</th><th>Why</th></tr></thead>
                <tbody>
                  {apply.entries.map((e) => (
                    <tr key={e.id} className={clsx("border-t border-ivory-200 align-top", e.stale && "opacity-60")} data-testid="apply-entry" data-kind={e.kind}>
                      <td className="py-1.5 pr-2">{apply.canApprove && !e.stale && <input type="checkbox" name="decision" value={e.id} aria-label={`Approve ${e.title}`} className="size-4" />}</td>
                      <td className="pr-2 whitespace-nowrap">{e.date}</td>
                      <td className="pr-2">
                        {e.newAccount ? (
                          <>
                            <span className="font-semibold text-navy-900">New account for the chart of accounts</span>
                            <span className="mt-1 flex flex-wrap items-center gap-1">
                              <input className="input w-20 py-0.5 text-xs" name={`code:${e.id}`} defaultValue={e.newAccount.code} aria-label="New account code" disabled={!apply.canApprove} />
                              <input className="input w-56 py-0.5 text-xs" name={`name:${e.id}`} defaultValue={e.newAccount.name} aria-label="New account name" disabled={!apply.canApprove} />
                              <span className="rounded bg-ivory-200 px-1.5 py-0.5">{e.newAccount.type}</span>
                            </span>
                            <span className="block text-slate-600">Created only when you approve it · tick it with the entries that use it · {e.source}</span>
                          </>
                        ) : (
                          <><span className="font-semibold text-navy-900">{e.title}</span><span className="block text-slate-600">{e.bankRow ? "Waiting bank row" : "Journal entry (reclassification)"} · {e.source}{e.needs.length ? " · uses a new account: tick it too" : ""}{e.stale ? " · this row was already posted or excluded; it will be skipped" : ""}</span></>
                        )}
                      </td>
                      <td className="pr-2">{e.lines.filter((l) => l.debitCents).map((l, i) => <span key={i} className="block">{l.account} {usd(l.debitCents)}</span>)}</td>
                      <td className="pr-2">{e.lines.filter((l) => l.creditCents).map((l, i) => <span key={i} className="block">{l.account} {usd(l.creditCents)}</span>)}</td>
                      <td className="pr-2 text-right tabular-nums">{e.newAccount ? "" : usd(e.amountCents)}</td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {apply.canApprove ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="submit" name="do" value="approve" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800" data-testid="apply-approve">Approve &amp; Post selected</button>
                <button type="submit" name="do" value="remove" className="rounded-lg border-2 border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900" data-testid="apply-remove">Remove selected (don&apos;t post)</button>
              </div>
            ) : <p className="mt-2 text-xs font-semibold text-navy-900">Only Tabitha can approve and post these.</p>}
          </ActionForm>
        </section>
      )}

      {reading.jobs.some((j) => j.findings.length > 0) && (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="coetha-findings">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><FileSearch className="size-5 text-gold-600" aria-hidden /> What Coetha read from the documents</h2>
            <a href={`/api/coetha/findings?clientId=${encodeURIComponent(clientId)}`} className="inline-flex items-center gap-1 rounded-lg border-2 border-navy-900 bg-white px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-ivory-100" data-testid="findings-download-all"><Download className="size-3.5" aria-hidden /> Download as Spreadsheet</a>
          </div>
          <p className="mt-1 text-xs text-slate-600">Every check is saved here in one of five groups, with its bank match, the account Coetha proposes, why, and the evidence that would settle it. These are proposals only: nothing is posted, approved or changed until you decide. Account and routing numbers are never kept (last 4 digits at most).</p>
          {reading.jobs.filter((j) => j.findings.length > 0).map((j) => (
            <details key={j.id} className="mt-3 text-sm" open={reading.jobs.filter((x) => x.findings.length > 0).length === 1} data-testid="findings-doc">
              <summary className="cursor-pointer font-semibold text-navy-900">{j.name}: {j.checks} check{j.checks === 1 ? "" : "s"}{j.findings.length > j.checks ? `, ${j.findings.length - j.checks} other item${j.findings.length - j.checks === 1 ? "" : "s"}` : ""}</summary>
              <p className="mt-1 text-xs text-slate-700" data-testid="findings-totals">
                {j.groups.map((g) => `${g.label}: ${g.items.length}`).join(" · ")}
                {" "}<a className="ml-1 font-semibold text-navy-900 underline" href={`/api/coetha/findings?clientId=${encodeURIComponent(clientId)}&jobId=${encodeURIComponent(j.id)}`} data-testid="findings-download">Download this document as a spreadsheet</a>
              </p>
              {j.groups.some((g) => g.key === "ROUTINE") && (
                <ActionForm action={prepareFromDocumentAction.bind(null, clientId, j.id)} className="mt-2">
                  <button type="submit" className="rounded-lg border-2 border-navy-900 bg-white px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-ivory-100" data-testid="findings-prepare">Prepare the routine checks for Approve &amp; Post</button>
                  <span className="ml-2 text-xs text-slate-600">Checks needing documents or your judgment stay on hold; answer Coetha about them and she prepares those too.</span>
                </ActionForm>
              )}
              {j.groups.map((g) => (
                <details key={g.key} className="mt-2 rounded-lg bg-ivory-100 p-2 ring-1 ring-ivory-200" data-testid="findings-group" data-group={g.key}>
                  <summary className="cursor-pointer text-sm font-semibold text-navy-900">{g.label} ({g.items.length})</summary>
                  <div className="mt-1 overflow-x-auto">
                    <table className="w-full min-w-[980px] text-xs">
                      <thead><tr className="text-left text-slate-600"><th className="py-1 pr-2">Page</th><th className="pr-2">{g.key === "OTHER" ? "Item" : "Check #"}</th><th className="pr-2">Date</th><th className="pr-2">Payee / from</th><th className="pr-2 text-right">Amount</th><th className="pr-2">Memo / details</th><th className="pr-2">Bank match</th><th className="pr-2">Proposed account</th><th className="pr-2">Why</th><th>Evidence needed</th></tr></thead>
                      <tbody>
                        {g.items.map((f) => (
                          <tr key={f.id} className="border-t border-ivory-200 align-top" data-testid="finding">
                            <td className="py-1 pr-2">{f.page}</td>
                            <td className="pr-2">{g.key === "OTHER" ? f.kind.toLowerCase() : (f.checkNumber ?? "")}</td>
                            <td className="pr-2 whitespace-nowrap">{f.date ?? ""}</td>
                            <td className="pr-2">{f.payee ?? ""}</td>
                            <td className="pr-2 text-right tabular-nums">{usd(f.amountCents)}</td>
                            <td className="pr-2">{[f.memo, f.details].filter(Boolean).join(" · ")}</td>
                            <td className={clsx("pr-2", f.bankTransactionId ? "text-emerald-700" : "text-slate-600")}>{f.matchNote ?? ""}</td>
                            <td className="pr-2">{f.proposedAccount ?? ""}</td>
                            <td className="pr-2">{f.reason ?? ""}{f.confidence != null ? ` (confidence ${Math.round(f.confidence * 100)}%)` : ""}</td>
                            <td>{f.evidenceNeeded ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </details>
          ))}
        </section>
      )}
      <CoethaReadingPoller clientId={clientId} active={waiting || reading.active} />


      <p className="flex items-start gap-2 rounded-xl bg-ivory-100 p-3 text-xs text-navy-800 ring-1 ring-ivory-200" data-testid="coetha-chat-privacy"><ShieldCheck className="size-4 shrink-0 text-gold-600" aria-hidden /> {COETHA_CHAT_PRIVACY}</p>
    </div>
  );
}
