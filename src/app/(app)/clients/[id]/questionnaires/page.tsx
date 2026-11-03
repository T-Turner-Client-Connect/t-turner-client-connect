import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { questionnaireFor, submissionAnswers } from "@/lib/services/tax-center";
import { intakeSummary, proposedUpdates } from "@/lib/services/questionnaire-intake";
import { downloadToken } from "@/lib/services/documents";
import { buildFollowUpAction, linkFoundSubmissionAction, reassignSubmissionAction, requestMissingAction, reviewSubmissionAction, sendQuestionnaireAction } from "@/app/actions/questionnaire-intake";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Tax Questionnaires & Intake" };

const SOURCE: Record<string, string> = { jotform_webhook: "Client submitted (verified with Jotform)", staff_import: "Linked by staff (read from Jotform)", staff_verified: "Linked by staff (Jotform not connected)" };

export default async function QuestionnairesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ year?: string; find?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, displayName: true, email: true, clientType: true, archivedAt: true, emailNormalized: true, phone: true, addressLine1: true, city: true, state: true, postalCode: true } });
  if (!client) notFound();
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 2021 }, (_, i) => thisYear - i);
  const year = years.includes(Number(sp.year)) ? Number(sp.year) : thisYear - 1;

  const [summary, form, subs] = await Promise.all([
    intakeSummary(id, year),
    questionnaireFor(client.clientType, year),
    prisma.questionnaireSubmission.findMany({ where: { clientId: id, taxYear: year }, orderBy: { createdAt: "desc" } }),
  ]);
  const docs = new Map((await prisma.document.findMany({ where: { id: { in: subs.flatMap((s) => s.documentIds) }, deletedAt: null }, select: { id: true, title: true, scanStatus: true } })).map((d) => [d.id, d]));
  const names = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const clientOptions = subs.some((x) => x.reviewStatus !== "REVIEWED")
    ? await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 2000 })
    : [];

  return (
    <>
      <PageHeader title="Tax Questionnaires & Intake" subtitle={<span><Link className="underline" href={`/clients/${id}?tab=taxes`}>{client.displayName}</Link> · Tax Preparation</span>} />
      <nav aria-label="Tax year" className="mb-4 flex flex-wrap gap-2">
        {years.map((y) => (
          <Link key={y} href={`/clients/${id}/questionnaires?year=${y}`} aria-current={y === year ? "page" : undefined} className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${y === year ? "border-gold-500 bg-gold-500 text-navy-950" : "border-ivory-200 bg-white text-navy-900"}`}>{y}</Link>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`${year} questionnaire`} actions={<Badge tone={summary.tone}>{summary.label}</Badge>}>
            <dl className="grid gap-2 text-sm sm:grid-cols-3" data-testid="intake-summary">
              <div><dt className="text-xs uppercase text-slate-500">Form</dt><dd>{form?.jotformFormId ? form.title : <span className="text-amber-800">No {year} form set up</span>}</dd></div>
              <div><dt className="text-xs uppercase text-slate-500">Sent</dt><dd>{summary.request?.sentAt ? `${fmtDateTime(summary.request.sentAt)}${summary.request.sendCount > 1 ? ` (${summary.request.sendCount}×)` : ""}` : "Not sent"}</dd></div>
              <div><dt className="text-xs uppercase text-slate-500">Opened by client</dt><dd>{summary.request?.openedAt ? fmtDateTime(summary.request.openedAt) : "—"}</dd></div>
            </dl>
            {subs.length === 0 && !client.archivedAt && (
              <ActionForm action={sendQuestionnaireAction.bind(null, id, year)} className="mt-3" confirm={`Email the ${year} questionnaire link to ${client.email ?? "the client"}?`}>
                <Button type="submit" disabled={!form?.jotformFormId || !client.emailNormalized}>{summary.request?.sentAt ? "Resend questionnaire" : "Send questionnaire"}</Button>
                {!client.emailNormalized && <span className="ml-2 text-xs text-slate-600">Add the client&apos;s email first.</span>}
              </ActionForm>
            )}
          </Card>

          {subs.map((s) => {
            const answers = submissionAnswers(s);
            const proposals = proposedUpdates(answers, client as unknown as Record<string, string | null>);
            const follow = (s.followUp as { items?: { key: string; label: string; reason: string; status: string }[]; preparedAt?: string } | null) ?? null;
            const missing = follow?.items?.filter((i) => i.status === "MISSING") ?? [];
            return (
              <Card key={s.id} title={`Submission ${s.submissionId}`} actions={<Badge tone={s.reviewStatus === "REVIEWED" ? "green" : "amber"}>{s.reviewStatus === "REVIEWED" ? "Reviewed" : "Needs Review"}</Badge>}>
                <div className="space-y-4" data-testid="submission">
                  <p className="text-sm text-slate-700">
                    {s.submittedAt ? `Submitted ${fmtDateTime(s.submittedAt)}` : "Submission date not available"} · {SOURCE[s.source] ?? s.source} · Linked {fmtDateTime(s.createdAt)}{s.linkedById && ` by ${names.get(s.linkedById) ?? "staff"}`}
                    <span className="block text-xs text-slate-600">Match: {s.matchNote}{s.reviewedAt && ` · Reviewed ${fmtDateTime(s.reviewedAt)} by ${names.get(s.reviewedById ?? "") ?? "staff"}${s.appliedFields.length ? ` (updated ${s.appliedFields.join(", ")})` : ""}`}</span>
                  </p>

                  <section>
                    <h3 className="text-sm font-semibold text-navy-900">Attachments ({s.documentIds.length}) — saved to the {s.taxYear} vault</h3>
                    {s.documentIds.length ? (
                      <ul className="mt-1 text-sm">
                        {s.documentIds.map((d) => docs.get(d)).filter(Boolean).map((d) => (
                          <li key={d!.id}><a className="underline" target="_blank" rel="noopener" href={`/api/documents/${downloadToken(d!.id, { staffId: user.id })}`}>{d!.title}</a> {d!.scanStatus !== "CLEAN" && <Badge tone="gray">{d!.scanStatus.toLowerCase()}</Badge>}</li>
                        ))}
                      </ul>
                    ) : <p className="text-sm text-slate-600">No files attached.</p>}
                  </section>

                  <details>
                    <summary className="cursor-pointer text-sm font-semibold underline">View answers ({answers.length}) — staff only</summary>
                    <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                      {answers.map((a, i) => <div key={i}><dt className="text-xs text-slate-500">{a.q}</dt><dd className="whitespace-pre-wrap">{a.a}</dd></div>)}
                    </dl>
                  </details>

                  {s.reviewStatus !== "REVIEWED" && (
                    <ActionForm action={reviewSubmissionAction.bind(null, id, s.id)} className="rounded-xl border border-gold-300 bg-gold-100/30 p-3 text-sm">
                      <p className="font-semibold text-navy-900">Staff review — nothing changes on the client record until you approve it</p>
                      {proposals.length ? (
                        <ul className="mt-2 space-y-1">
                          {proposals.map((p) => (
                            <li key={p.field}><label className="flex items-start gap-2"><input type="checkbox" name="apply" value={p.field} className="mt-1 accent-navy-900" /> <span><strong>{p.label}</strong>: “{p.from ?? "blank"}” → <strong>{p.to}</strong></span></label></li>
                          ))}
                        </ul>
                      ) : <p className="mt-1 text-slate-600">The answers don&apos;t change any contact details on file.</p>}
                      <Button type="submit" className="mt-2">Mark reviewed{proposals.length ? " & apply ticked changes" : ""}</Button>
                    </ActionForm>
                  )}

                  {s.reviewStatus !== "REVIEWED" && (
                    <details>
                      <summary className="cursor-pointer text-sm underline">Wrong client or tax year? Move it</summary>
                      <ActionForm action={reassignSubmissionAction.bind(null, id, s.id)} className="mt-2 grid gap-2 sm:grid-cols-3" confirm="Move this questionnaire and its files to the chosen client and tax year?">
                        <Field label="Client">
                          <select className="input" name="clientId" defaultValue={id}>{clientOptions.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}</select>
                        </Field>
                        <Field label="Tax year">
                          <select className="input" name="taxYear" defaultValue={s.taxYear}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
                        </Field>
                        <Field label="Reason"><input className="input" name="note" required /></Field>
                        <div><Button type="submit" variant="secondary">Move questionnaire</Button></div>
                      </ActionForm>
                    </details>
                  )}

                  <section className="rounded-xl border border-ivory-200 p-3" data-testid="followup">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-navy-900">Coetha&apos;s follow-up checklist</h3>
                      <ActionForm action={buildFollowUpAction.bind(null, id, s.id)}><Button type="submit" variant="secondary">{follow ? "Re-check" : "Prepare checklist"}</Button></ActionForm>
                    </div>
                    <p className="text-xs text-slate-600">Compares the answers with the documents already in the {s.taxYear} vault. A draft for you to review — nothing is sent to the client until you choose.</p>
                    {follow?.items && (
                      follow.items.length === 0 ? <p className="mt-2 text-sm">Nothing missing found from the answers.</p> : (
                        <ActionForm action={requestMissingAction.bind(null, id, s.id)} className="mt-2 space-y-1 text-sm" confirm="Create a document request in the client's portal for the ticked items?">
                          {follow.items.map((i) => (
                            <label key={i.key} className="flex items-start gap-2">
                              {i.status === "MISSING" ? <input type="checkbox" name="item" value={i.key} defaultChecked className="mt-1 accent-navy-900" /> : <span className="mt-0.5 text-emerald-700">✓</span>}
                              <span><strong>{i.label}</strong> <Badge tone={i.status === "MISSING" ? "amber" : "green"}>{i.status === "MISSING" ? "Missing" : "In vault"}</Badge><span className="block text-xs text-slate-600">{i.reason}</span></span>
                            </label>
                          ))}
                          {missing.length > 0 && <Button type="submit" variant="gold" className="mt-2">Request ticked items from client</Button>}
                        </ActionForm>
                      )
                    )}
                  </section>
                </div>
              </Card>
            );
          })}
        </div>

        <div className="space-y-4">
          <Card title="Where new questionnaires come from">
            <p className="text-sm">Questionnaires the client completes from their Client Connect account are linked here automatically. Submissions from old public Jotform links are matched in the <Link className="underline" href="/taxes/questionnaires">Questionnaire Inbox</Link>.</p>
            {user.role === "ADMIN" && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-slate-600 underline">Fallback: link a submission by its Jotform ID (rarely needed)</summary>
                <ActionForm action={linkFoundSubmissionAction.bind(null, id, year)} className="mt-2 space-y-2" resetOnSuccess>
                  <Field label={`Submission ID (links to ${year})`}><input className="input" name="submissionId" inputMode="numeric" required /></Field>
                  <label className="flex items-center gap-2"><input type="checkbox" name="confirmed" /> I confirmed this submission belongs to this client</label>
                  <Field label="How you confirmed it"><input className="input" name="matchNote" /></Field>
                  <Button type="submit" variant="secondary">Link to this client</Button>
                </ActionForm>
              </details>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
