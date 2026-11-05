import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AlertTriangle, FileText, Lock, Send, Unlock } from "lucide-react";
import type { ClientLetter } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { clientLettersView, FLAG_LABEL, LETTER_STATUS, letterFacts, NOT_VIEWED_DAYS, ROLLOUT_ON_HOLD, SEND_CONFIRM_WORD, type LetterStatus } from "@/lib/services/client-letters";
import { ownerSwitchAction } from "@/app/actions/coetha";
import { letterDateText, officeDay } from "@/lib/client-letters/templates";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { discardBatchAction, excludeLetterAction, markMailedAction, prepareLettersAction, resendLetterAction, sendBatchAction } from "@/app/actions/client-letters";

export const metadata = { title: "Client Letters" };

const TONE: Record<LetterStatus, "navy" | "gold" | "green" | "red" | "gray" | "amber"> = {
  DRAFT: "navy",
  SENDING: "gold",
  SENT: "green",
  EMAIL_FAILED: "red",
  NO_EMAIL: "amber",
  MAILED_MANUALLY: "green",
  FAILED: "red",
};

const preview = (id: string) => `/api/owner/client-letters/${id}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function StatusBadge({ status }: { status: string }) {
  const s = (status in LETTER_STATUS ? status : "DRAFT") as LetterStatus;
  return <Badge tone={TONE[s]}>{LETTER_STATUS[s]}</Badge>;
}

const when = (d: Date | null | undefined) => (d ? fmtDateTime(d) : null);
const Dash = () => <span className="text-slate-400">—</span>;

/** One letter's steps, each with what actually happened (nothing reads as "delivered" unless the provider said so). */
function Steps({ l, superseded }: { l: ClientLetter; superseded: boolean }) {
  const f = letterFacts(l, { superseded });
  const email =
    f.email === "BOUNCED" ? <span className="text-red-800">Bounced {when(f.emailBouncedAt)}{l.emailBounceReason ? ` (${l.emailBounceReason})` : ""}</span>
    : f.email === "DELIVERED" ? <>Delivered to the recipient&apos;s mail server {when(f.emailDeliveredAt)}</>
    : f.email === "ACCEPTED" ? <>Accepted by email service {when(f.emailAcceptedAt)} <span className="text-slate-500">(no delivery report yet)</span></>
    : f.email === "NOT_SENT" ? <span className="text-red-800">Not sent{l.emailError ? `: ${l.emailError}` : ""}</span>
    : <span className="text-amber-800">No email on file</span>;
  const rows: [string, React.ReactNode][] = [
    ["Filed", f.filedAt ? when(f.filedAt) : <Dash />],
    ["Portal posted", f.portalPostedAt ? when(f.portalPostedAt) : <span className="text-slate-500">No portal login</span>],
    ["Email", email],
    ["First viewed", f.firstViewedAt ? when(f.firstViewedAt) : <span className="text-slate-500">Not yet (client&apos;s own login)</span>],
    ["Acknowledged (optional)", f.acknowledgedAt ? when(f.acknowledgedAt) : <Dash />],
    ["Mailed manually", f.mailedOn ? letterDateText(f.mailedOn) : <Dash />],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-slate-700">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold text-navy-900">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}
    </dl>
  );
}

function Flags({ l, superseded }: { l: ClientLetter; superseded: boolean }) {
  const { flags } = letterFacts(l, { superseded });
  if (!flags.length) return null;
  return <span className="flex flex-wrap gap-1" data-testid="letter-flags">{flags.map((x) => <Badge key={x} tone={x === "NOT_VIEWED" || x === "NEEDS_PHYSICAL_DELIVERY" ? "amber" : "red"}>{FLAG_LABEL[x]}</Badge>)}</span>;
}

export default async function ClientLettersPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await connection();
  // Owner only: the letters go out in the firm's name and only Tabitha sends them.
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const sp = await searchParams;
  const v = await clientLettersView(actor, { clientId: sp.client || null });
  const draft = v.draft;
  const included = draft ? draft.letters.filter((l) => !l.excluded) : [];
  const noEmail = included.filter((l) => !l.email).length;
  const today = letterDateText(officeDay());

  return (
    <>
      <PageHeader
        title="Client Letters"
        subtitle={<>Prepare the approved letter for every client on the Bookkeeping list, review it, and send it. Every letter is filed in the client&apos;s Documents for your records.</>}
      />

      <section className={`mb-5 rounded-2xl border p-4 sm:p-5 ${v.rolloutAuthorized ? "border-emerald-200 bg-emerald-50" : "border-gold-300 bg-gold-50"}`} data-testid="rollout-lock" data-on={v.rolloutAuthorized ? "true" : "false"}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[16rem] flex-1">
            <p className="flex items-center gap-2 font-semibold text-navy-900">
              {v.rolloutAuthorized ? <Unlock className="size-5 text-emerald-700" aria-hidden /> : <Lock className="size-5 text-gold-700" aria-hidden />}
              Client rollout authorized: {v.rolloutAuthorized ? "On" : "Off"}
            </p>
            <p className="mt-1 text-sm text-navy-800">
              {v.rolloutAuthorized
                ? "Letters can be sent and re-sent when you choose. Nothing is ever sent automatically."
                : `${ROLLOUT_ON_HOLD} You can still prepare batches, review them and preview each letter. Nothing is ever sent automatically.`}
            </p>
          </div>
          <ActionForm action={ownerSwitchAction.bind(null, "clientRollout", !v.rolloutAuthorized)} confirm={v.rolloutAuthorized ? "Put client letters on hold? Send and Send again will be refused until you authorize the rollout again." : "Authorize the client rollout? Send and Send again will be allowed. Nothing is sent until you send a batch yourself."}>
            <Button type="submit" variant={v.rolloutAuthorized ? "secondary" : "primary"} data-testid="toggle-rollout">{v.rolloutAuthorized ? "Put on hold" : "Authorize client rollout"}</Button>
          </ActionForm>
        </div>
      </section>

      {v.flagged.length > 0 && (
        <Card className="mb-5" title={<span className="flex items-center gap-2"><AlertTriangle className="size-5 text-red-700" aria-hidden /> Needs follow-up · {v.flagged.length}</span>}>
          <p className="mb-2 text-xs text-slate-600">Letters that may not have reached the client: no email (needs physical delivery), email bounced or marked as spam, or not opened by the client&apos;s own login after {NOT_VIEWED_DAYS} days. A letter leaves this list once you record it as mailed or send it again.</p>
          <ul className="divide-y divide-navy-100 text-sm" data-testid="flagged-letters">
            {v.flagged.map(({ l }) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/owner/client-letters?client=${l.clientId}#client-record`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{l.businessName}</Link>
                <Flags l={l} superseded={false} />
                <span className="text-xs text-slate-500">{l.letterDate ? `dated ${letterDateText(l.letterDate)}` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-5" title={<span className="flex items-center gap-2"><FileText className="size-5 text-gold-600" aria-hidden /> {v.current.label}</span>}>
        <p className="text-sm text-navy-800">
          Approved wording, version <code className="rounded bg-ivory-100 px-1.5 py-0.5 text-xs" data-testid="letter-version">{v.current.version}</code>. Only the date, business name and owner&apos;s name change for each client. Each letter is emailed to the owner (a short notice with a secure sign-in link; documents are never attached to email), posted to the client&apos;s Message Center with the PDF when they have a portal login, and filed in their Documents as “{v.current.documentTitle}”.
        </p>
        {!draft && (
          <ActionForm action={prepareLettersAction} className="mt-4">
            <Button type="submit" data-testid="prepare-letters">Prepare letters for all bookkeeping clients</Button>
          </ActionForm>
        )}
      </Card>

      {draft && (
        <Card
          className="mb-5"
          title={`Prepared ${fmtDateTime(draft.createdAt)} · ${draft.letters.length} client${draft.letters.length === 1 ? "" : "s"}`}
          actions={
            <ActionForm action={discardBatchAction.bind(null, draft.id)} confirm="Discard this prepared batch? Nothing has been sent from it.">
              <Button type="submit" variant="ghost">Discard batch</Button>
            </ActionForm>
          }
        >
          <p className="mb-3 text-sm text-slate-700" data-testid="batch-summary">
            {included.length} to send · {draft.letters.length - included.length} excluded · {noEmail} with no email (mail or hand deliver; they still get the portal copy and the filed copy). Letters will be dated {today}.
          </p>
          {/* Phones: one card per client. */}
          <ul className="space-y-3 sm:hidden" data-testid="draft-letters-mobile">
            {draft.letters.map((l) => (
              <li key={l.id} className={`rounded-xl border border-ivory-200 p-3 text-sm ${l.excluded ? "bg-slate-50 text-slate-500" : "bg-white"}`}>
                <Link href={`/owner/client-letters?client=${l.clientId}#client-record`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{l.businessName}</Link>
                <p className="mt-1">{l.ownerName === l.businessName ? <Badge tone="amber">No owner name on file</Badge> : l.ownerName} <span className="text-xs text-slate-500">· Dear {l.ownerFirstName},</span></p>
                <p className="mt-1 [overflow-wrap:anywhere]">{l.email ?? <Badge tone="amber">No email: mail or hand deliver</Badge>}</p>
                <p className="mt-1 text-xs text-slate-600">Portal: {v.hasPortal.has(l.clientId) ? "yes" : "no login yet"}</p>
                {l.excluded && <p className="mt-1"><Badge tone="gray">Excluded{l.excludedReason ? `: ${l.excludedReason}` : ""}</Badge></p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <a href={preview(l.id)} target="_blank" rel="noopener" className="inline-flex min-h-9 items-center rounded-lg border border-ivory-200 bg-white px-3 text-sm font-semibold text-navy-900 shadow-sm">Preview</a>
                  <ActionForm action={excludeLetterAction.bind(null, l.id, !l.excluded)} showSuccess={false}>
                    <Button type="submit" variant="secondary" className="min-h-9 px-3">{l.excluded ? "Include" : "Exclude"}</Button>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-ivory-200 sm:block">
            <table className="w-full min-w-[720px] text-sm" data-testid="draft-letters">
              <thead className="bg-ivory-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Client</th>
                  <th className="px-3 py-2.5">Owner</th>
                  <th className="px-3 py-2.5">Email</th>
                  <th className="px-3 py-2.5">Portal</th>
                  <th className="px-3 py-2.5 text-right">Letter</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {draft.letters.map((l) => (
                  <tr key={l.id} className={l.excluded ? "bg-slate-50 text-slate-500" : undefined} data-client={l.businessName}>
                    <td className="px-3 py-2.5">
                      <Link href={`/owner/client-letters?client=${l.clientId}#client-record`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{l.businessName}</Link>
                      {l.excluded && <span className="mt-1 block"><Badge tone="gray">Excluded{l.excludedReason ? `: ${l.excludedReason}` : ""}</Badge></span>}
                    </td>
                    <td className="px-3 py-2.5">
                      {l.ownerName === l.businessName ? <span data-testid="no-owner-name"><Badge tone="amber">No owner name on file</Badge></span> : l.ownerName}
                      <span className="block text-xs text-slate-500">Dear {l.ownerFirstName},</span>
                    </td>
                    <td className="px-3 py-2.5">{l.email ? <span className="[overflow-wrap:anywhere]">{l.email}</span> : <span data-testid="no-email"><Badge tone="amber">No email: mail or hand deliver</Badge></span>}</td>
                    <td className="px-3 py-2.5">{v.hasPortal.has(l.clientId) ? "Yes" : <span className="text-slate-500">No login yet</span>}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap justify-end gap-2">
                        <a href={preview(l.id)} target="_blank" rel="noopener" className="inline-flex min-h-9 items-center rounded-lg border border-ivory-200 bg-white px-3 text-sm font-semibold text-navy-900 shadow-sm hover:border-navy-700" data-testid="preview-letter">Preview</a>
                        <ActionForm action={excludeLetterAction.bind(null, l.id, !l.excluded)} showSuccess={false}>
                          <Button type="submit" variant={l.excluded ? "secondary" : "ghost"} className="min-h-9 px-3">{l.excluded ? "Include" : "Exclude"}</Button>
                        </ActionForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ActionForm action={sendBatchAction.bind(null, draft.id)} className="mt-5 rounded-xl border border-gold-200 bg-ivory-50 p-4" confirm={`Send ${included.length} letter${included.length === 1 ? "" : "s"} now? Each owner is emailed, the letter is posted to their portal, and a copy is filed in their Documents. This can't be undone.`}>
            <p className="flex items-center gap-2 font-semibold text-navy-900"><Send className="size-4 text-gold-600" aria-hidden /> Send {included.length} letter{included.length === 1 ? "" : "s"}</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Field label={`Type ${SEND_CONFIRM_WORD} to confirm`} className="w-full sm:w-56">
                <input name="confirm" className="input" autoComplete="off" required data-testid="send-confirm" />
              </Field>
              <Button type="submit" disabled={!included.length || !v.rolloutAuthorized} data-testid="send-letters">Send letters</Button>
            </div>
            {!v.rolloutAuthorized && <p className="mt-2 text-sm text-gold-800" data-testid="send-on-hold">{ROLLOUT_ON_HOLD}</p>}
          </ActionForm>
        </Card>
      )}

      {v.clientRecord && (
        <Card className="mb-5" title={<span id="client-record">Letters to {v.clientRecord[0]?.client.displayName ?? "this client"}</span>} actions={<Link href="/owner/client-letters" className="text-sm underline">Close</Link>}>
          {v.clientRecord.length === 0 ? <p className="text-sm text-slate-600">No letters yet.</p> : (
            <ul className="divide-y divide-navy-100 text-sm" data-testid="client-record">
              {v.clientRecord.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><StatusBadge status={l.status} /> <span className="ml-1">{l.letterDate ? letterDateText(l.letterDate) : `prepared ${fmtDate(l.createdAt)}`}</span> · <code className="text-xs">{l.templateVersion}</code>{l.resendOfId && " · re-send"}{l.excluded && " · excluded"}</span>
                  <a href={preview(l.id)} target="_blank" rel="noopener" className="font-semibold underline">{l.documentId ? "Filed copy" : "Preview"}</a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <h2 className="mb-3 mt-8 font-serif text-xl font-bold text-navy-900">History</h2>
      {v.history.length === 0 ? (
        <EmptyState title="No letters sent yet">Prepared batches appear here once they are sent.</EmptyState>
      ) : (
        <div className="space-y-5">
          {v.history.map((b) => {
            const sent = b.letters.filter((l) => !l.excluded);
            const count = (s: LetterStatus) => sent.filter((l) => l.status === s).length;
            return (
              <Card key={b.id} title={`Sent ${b.sentAt ? fmtDateTime(b.sentAt) : ""}${b.sentById ? ` by ${v.nameOf.get(b.sentById) ?? "the owner"}` : ""}`}>
                <p className="mb-3 flex flex-wrap gap-2 text-sm">
                  <code className="rounded bg-ivory-100 px-1.5 py-0.5 text-xs">{b.templateVersion}</code>
                  {(["SENT", "EMAIL_FAILED", "NO_EMAIL", "MAILED_MANUALLY", "FAILED"] as LetterStatus[]).filter((s) => count(s)).map((s) => <span key={s}><Badge tone={TONE[s]}>{count(s)} {LETTER_STATUS[s]}</Badge></span>)}
                  {b.letters.length - sent.length > 0 && <Badge tone="gray">{b.letters.length - sent.length} excluded</Badge>}
                </p>
                {/* Phones: one card per client. */}
                <ul className="space-y-3 sm:hidden" data-testid="sent-letters-mobile">
                  {b.letters.map((l) => (
                    <li key={l.id} className={`rounded-xl border border-ivory-200 p-3 text-sm ${l.excluded ? "bg-slate-50 text-slate-500" : "bg-white"}`}>
                      <Link href={`/owner/client-letters?client=${l.clientId}#client-record`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{l.businessName}</Link>
                      <p className="mt-1">{l.excluded ? <Badge tone="gray">Excluded</Badge> : <StatusBadge status={l.status} />}</p>
                      {!l.excluded && (
                        <>
                          <div className="mt-1"><Flags l={l} superseded={v.resentIds.has(l.id)} /></div>
                          <div className="mt-2"><Steps l={l} superseded={v.resentIds.has(l.id)} /></div>
                          <a href={preview(l.id)} target="_blank" rel="noopener" className="mt-2 inline-block font-semibold underline">{l.documentId ? "Filed copy" : "Preview"}</a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto rounded-xl border border-ivory-200 sm:block">
                  <table className="w-full min-w-[900px] text-sm" data-testid="sent-letters">
                    <thead className="bg-ivory-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5">Client</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-3 py-2.5">What happened</th>
                        <th className="px-3 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-navy-100">
                      {b.letters.map((l) => (
                        <tr key={l.id} className={l.excluded ? "text-slate-500" : undefined}>
                          <td className="px-3 py-2.5">
                            <Link href={`/owner/client-letters?client=${l.clientId}#client-record`} className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">{l.businessName}</Link>
                            <span className="block text-xs text-slate-500">{l.ownerName}{l.resendOfId ? " · re-send" : ""}</span>
                          </td>
                          <td className="px-3 py-2.5 align-top">
                            {l.excluded ? <Badge tone="gray">Excluded</Badge> : <StatusBadge status={l.status} />}
                            {!l.excluded && <span className="mt-1 block"><Flags l={l} superseded={v.resentIds.has(l.id)} /></span>}
                            {v.resentIds.has(l.id) && <span className="mt-1 block text-xs text-slate-500">Sent again later</span>}
                          </td>
                          <td className="px-3 py-2.5 align-top">
                            {l.excluded ? <span className="text-xs text-slate-500">Not sent{l.excludedReason ? `: ${l.excludedReason}` : ""}</span> : (
                              <>
                                {l.letterDate && <p className="mb-1 text-xs text-slate-600">Dated {letterDateText(l.letterDate)}{l.email ? ` · ${l.email}` : ""}</p>}
                                <Steps l={l} superseded={v.resentIds.has(l.id)} />
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            {!l.excluded && l.status !== "DRAFT" && (
                              <div className="flex flex-col items-end gap-2">
                                <a href={preview(l.id)} target="_blank" rel="noopener" className="text-sm font-semibold underline">{l.documentId ? "Filed copy" : "Preview"}</a>
                                {(l.status === "NO_EMAIL" || l.status === "EMAIL_FAILED") && (
                                  <ActionForm action={markMailedAction.bind(null, l.id)} className="flex flex-wrap items-end justify-end gap-2">
                                    <label className="text-xs text-slate-600">Mailed / handed on <input type="date" name="on" required defaultValue={ymd(officeDay())} className="input mt-0.5 w-auto py-1" /></label>
                                    <Button type="submit" variant="secondary" className="min-h-9 px-3">Record</Button>
                                  </ActionForm>
                                )}
                                {v.rolloutAuthorized ? <details className="text-right">
                                  <summary className="cursor-pointer text-sm text-navy-800 underline">Send again…</summary>
                                  <ActionForm action={resendLetterAction.bind(null, l.id)} className="mt-2 flex flex-wrap items-end justify-end gap-2" confirm={`Send this letter to ${l.businessName} again? A new copy is filed and a new record is kept.`}>
                                    <input name="confirm" placeholder={`Type ${SEND_CONFIRM_WORD}`} aria-label={`Type ${SEND_CONFIRM_WORD} to confirm`} className="input w-28 py-1" autoComplete="off" required />
                                    <Button type="submit" variant="secondary" className="min-h-9 px-3">Send again</Button>
                                  </ActionForm>
                                </details> : <span className="text-xs text-slate-500">Send again: on hold</span>}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
