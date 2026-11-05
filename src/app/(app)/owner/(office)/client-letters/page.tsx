import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { FileText, Mail, MailX, Send } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { clientLettersView, LETTER_STATUS, SEND_CONFIRM_WORD, type LetterStatus } from "@/lib/services/client-letters";
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
              <Button type="submit" disabled={!included.length} data-testid="send-letters">Send letters</Button>
            </div>
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
                <div className="overflow-x-auto rounded-xl border border-ivory-200">
                  <table className="w-full min-w-[820px] text-sm" data-testid="sent-letters">
                    <thead className="bg-ivory-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5">Client</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-3 py-2.5">Details</th>
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
                          <td className="px-3 py-2.5">{l.excluded ? <Badge tone="gray">Excluded</Badge> : <StatusBadge status={l.status} />}</td>
                          <td className="px-3 py-2.5 text-xs text-slate-700">
                            {l.sentAt && <span className="block">Sent {fmtDateTime(l.sentAt)}{l.letterDate ? ` · dated ${letterDateText(l.letterDate)}` : ""}</span>}
                            {l.emailedAt && <span className="flex items-center gap-1"><Mail className="size-3.5" aria-hidden /> Emailed to {l.email}</span>}
                            {l.emailError && <span className="flex items-center gap-1 text-red-800"><MailX className="size-3.5" aria-hidden /> {l.emailError}</span>}
                            {l.mailedOn && <span className="block">Mailed / handed on {letterDateText(l.mailedOn)}</span>}
                            {l.messageId && <span className="block">Posted to the portal</span>}
                            {l.documentId && <span className="block">Filed in Documents</span>}
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
                                <details className="text-right">
                                  <summary className="cursor-pointer text-sm text-navy-800 underline">Send again…</summary>
                                  <ActionForm action={resendLetterAction.bind(null, l.id)} className="mt-2 flex flex-wrap items-end justify-end gap-2" confirm={`Send this letter to ${l.businessName} again? A new copy is filed and a new record is kept.`}>
                                    <input name="confirm" placeholder={`Type ${SEND_CONFIRM_WORD}`} aria-label={`Type ${SEND_CONFIRM_WORD} to confirm`} className="input w-28 py-1" autoComplete="off" required />
                                    <Button type="submit" variant="secondary" className="min-h-9 px-3">Send again</Button>
                                  </ActionForm>
                                </details>
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
