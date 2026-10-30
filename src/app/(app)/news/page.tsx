import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { NewsAndCountdowns } from "@/components/portal/news-countdowns";
import { announcementStepAction, deadlineStepAction, saveAnnouncementAction, saveDeadlineAction, saveQuestionnaireAction } from "@/app/actions/tax-center";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { AUDIENCES, countdownsFor, listDeadlines, missingSuggestions, staffAnnouncements, TOPICS } from "@/lib/services/news";
import { DEADLINE_KIND_LABELS, fmtIso, officeToday } from "@/lib/tax/deadlines";
import { STATES } from "@/lib/resources/catalog";
import { jotformStatus } from "@/lib/services/contracts";
import { utcToChicagoLocal, fmtChicago } from "@/lib/tz";

export const metadata = { title: "News & Countdowns" };

const STALE_DAYS = 180;

type Ann = Awaited<ReturnType<typeof staffAnnouncements>>[number];
function AnnouncementFields({ a }: { a?: Ann }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Title" className="sm:col-span-2"><input className="input" name="title" defaultValue={a?.title} required /></Field>
      <Field label="Message" className="sm:col-span-2"><textarea className="input min-h-24" name="body" defaultValue={a?.body} required /></Field>
      <Field label="Who sees it">
        <select className="input" name="audience" defaultValue={a?.audience ?? "ALL"}>{Object.entries(AUDIENCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Field>
      <Field label="Topic">
        <select className="input" name="topic" defaultValue={a?.topic ?? "GENERAL"}>{Object.entries(TOPICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Field>
      <Field label="Start showing (Central time)" hint="Leave empty to publish now; a future time schedules it."><input className="input" type="datetime-local" name="publishAt" defaultValue={a?.publishedAt ? utcToChicagoLocal(a.publishedAt) : ""} /></Field>
      <Field label="Stop showing (Central time, optional)"><input className="input" type="datetime-local" name="expiresAt" defaultValue={a?.expiresAt ? utcToChicagoLocal(a.expiresAt) : ""} /></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="pinned" defaultChecked={a?.pinned} /> Pin to the top</label>
    </div>
  );
}

type Dl = Awaited<ReturnType<typeof listDeadlines>>[number];
function DeadlineFields({ d, preset }: { d?: Dl; preset?: { kind: string; taxYear: number; dueDate: string } }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Deadline" className="sm:col-span-2">
        <select className="input" name="kind" defaultValue={d?.kind ?? preset?.kind ?? "INDIVIDUAL"}>{Object.entries(DEADLINE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </Field>
      <Field label="Tax year the return covers"><input className="input" name="taxYear" inputMode="numeric" defaultValue={d?.taxYear ?? preset?.taxYear ?? new Date().getFullYear()} required /></Field>
      <Field label="Date"><input className="input" type="date" name="dueDate" defaultValue={d?.dueDate ?? preset?.dueDate} required /></Field>
      <Field label="Agency">
        <select className="input" name="jurisdiction" defaultValue={d?.jurisdiction ?? "US"}>
          <option value="US">IRS (federal)</option>
          {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Disaster relief for one state (IRS dates only)" hint="Replaces the general IRS date for clients in that state.">
        <select className="input" name="reliefState" defaultValue={d?.reliefState ?? ""}>
          <option value="">— applies everywhere —</option>
          {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Official source you checked (https://)" className="sm:col-span-2"><input className="input" name="sourceUrl" defaultValue={d?.sourceUrl ?? ""} placeholder="https://www.irs.gov/…" required /></Field>
      <Field label="Timing note (optional)" hint="e.g. “IRS begins accepting e-filed returns at 9 a.m. Eastern”"><input className="input" name="timeNote" defaultValue={d?.timeNote ?? ""} /></Field>
      <Field label="Note shown to clients (optional)"><input className="input" name="notes" defaultValue={d?.notes ?? ""} /></Field>
    </div>
  );
}

export default async function NewsPage() {
  await connection();
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const [announcements, deadlines, suggestions, preview, questionnaires] = await Promise.all([
    staffAnnouncements(),
    listDeadlines(),
    missingSuggestions(),
    countdownsFor(null),
    prisma.taxQuestionnaire.findMany({ orderBy: [{ taxYear: "desc" }, { audience: "asc" }], include: { _count: { select: { submissions: true } } } }),
  ]);
  const today = officeToday();
  const now = new Date();
  const jf = jotformStatus();

  return (
    <>
      <PageHeader title="News & Countdowns" subtitle="Client dashboard announcements, verified tax dates, and yearly tax questionnaires." />
      {!admin && <Notice>Only an Admin can change these. You can see what clients see.</Notice>}

      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-xl font-semibold">What clients see (general version)</h2>
          <NewsAndCountdowns cards={preview.cards} news={announcements.filter((a) => a.publishedAt && a.publishedAt <= now && (!a.expiresAt || a.expiresAt > now) && a.audience === "ALL")} personalized={false} />
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Announcements">
            <p className="mb-3 text-sm text-slate-600">Shown read-only on client dashboards. Publishing never sends a text or email.</p>
            {admin && (
              <details className="mb-4 rounded-lg bg-ivory-50 p-3" open>
                <summary className="cursor-pointer font-semibold">New announcement</summary>
                <ActionForm action={saveAnnouncementAction.bind(null, null)} className="mt-2 space-y-2" resetOnSuccess>
                  <AnnouncementFields />
                  <Button type="submit">Save announcement</Button>
                </ActionForm>
              </details>
            )}
            <ul className="divide-y divide-navy-100" data-testid="staff-announcements">
              {announcements.map((a) => {
                const state = !a.publishedAt ? "Draft" : a.publishedAt > now ? "Scheduled" : a.expiresAt && a.expiresAt <= now ? "Ended" : "Live";
                return (
                  <li key={a.id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-navy-900">
                        {a.pinned && "📌 "}{a.title}{" "}
                        <Badge tone={state === "Live" ? "green" : state === "Scheduled" ? "gold" : "gray"}>{state}</Badge>{" "}
                        <Badge tone="navy">{a.audience ? AUDIENCES[a.audience as keyof typeof AUDIENCES] : `Groups: ${a.groups.map((g) => g.group.name).join(", ") || "—"}`}</Badge>
                      </p>
                      {admin && (
                        <span className="flex gap-1">
                          <form action={announcementStepAction.bind(null, a.id, a.pinned ? "unpin" : "pin")}><Button variant="ghost">{a.pinned ? "Unpin" : "Pin"}</Button></form>
                          {state !== "Ended" && <form action={announcementStepAction.bind(null, a.id, "expire")}><Button variant="ghost">End now</Button></form>}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-600">
                      {a.publishedAt && `From ${fmtChicago(a.publishedAt)}`}{a.expiresAt && ` · until ${fmtChicago(a.expiresAt)}`}
                    </p>
                    {admin && a.audience && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-sm underline">Edit</summary>
                        <ActionForm action={saveAnnouncementAction.bind(null, a.id)} className="mt-2 space-y-2">
                          <AnnouncementFields a={a} />
                          <Button type="submit">Save changes</Button>
                        </ActionForm>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Tax dates for countdowns">
            <p className="mb-3 text-sm text-slate-600">
              Clients see a date only after an Admin saves it with the official source. Saving marks it reviewed by you today. Re-check dates when the IRS publishes the new Publication 509, and add disaster relief as it&apos;s announced.
            </p>
            {suggestions.length > 0 && admin && (
              <details className="mb-4 rounded-lg border border-gold-500 bg-gold-100/50 p-3" data-testid="suggestions">
                <summary className="cursor-pointer font-semibold">{suggestions.length} upcoming date{suggestions.length === 1 ? "" : "s"} to review (calculated from IRS rules)</summary>
                <ul className="mt-2 space-y-3">
                  {suggestions.map((s) => (
                    <li key={`${s.kind}${s.taxYear}`}>
                      <p className="text-sm font-semibold">{DEADLINE_KIND_LABELS[s.kind]} · {s.taxYear} returns · calculated {fmtIso(s.dueDate)}</p>
                      <ActionForm action={saveDeadlineAction.bind(null, null)} className="mt-1 space-y-2" resetOnSuccess>
                        <DeadlineFields preset={s} />
                        <Button type="submit" variant="secondary">Confirm against the source and publish</Button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <table className="w-full text-sm" data-testid="deadline-table">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1">Date</th><th>Deadline</th><th>Reviewed</th><th /></tr></thead>
              <tbody className="divide-y divide-navy-100">
                {deadlines.map((d) => {
                  const stale = !d.lastReviewedAt || now.getTime() - d.lastReviewedAt.getTime() > STALE_DAYS * 86400_000;
                  return (
                    <tr key={d.id} className={d.dueDate < today || d.hidden ? "opacity-60" : ""}>
                      <td className="py-2 align-top font-semibold">{fmtIso(d.dueDate, { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td className="align-top">
                        {DEADLINE_KIND_LABELS[d.kind] ?? d.kind} · {d.taxYear}
                        <span className="block text-xs text-slate-600">
                          {d.jurisdiction === "US" ? "IRS" : d.jurisdiction}{d.reliefState && ` · relief for ${d.reliefState}`}
                          {d.sourceUrl && <> · <a className="underline" href={d.sourceUrl} target="_blank" rel="noopener noreferrer">source ↗</a></>}
                          {d.hidden && " · hidden"}{d.dueDate < today && " · passed"}
                        </span>
                        {admin && (
                          <details>
                            <summary className="cursor-pointer text-xs underline">Edit</summary>
                            <ActionForm action={saveDeadlineAction.bind(null, d.id)} className="mt-2 space-y-2">
                              <DeadlineFields d={d} />
                              <Button type="submit">Save</Button>
                            </ActionForm>
                          </details>
                        )}
                      </td>
                      <td className="align-top text-xs">
                        {d.lastReviewedAt ? fmtChicago(d.lastReviewedAt, { month: "short", day: "numeric", year: "numeric" }) : "—"}
                        {!d.reviewedById && d.lastReviewedAt && <span className="block text-slate-500">initial research — please confirm</span>}
                        {stale && <Badge tone="amber">Re-check</Badge>}
                      </td>
                      <td className="align-top">
                        {admin && (
                          <span className="flex flex-col gap-1">
                            <form action={deadlineStepAction.bind(null, d.id, "reviewed")}><Button variant="ghost">Mark reviewed</Button></form>
                            <form action={deadlineStepAction.bind(null, d.id, d.hidden ? "show" : "hide")}><Button variant="ghost">{d.hidden ? "Show" : "Hide"}</Button></form>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {admin && (
              <details className="mt-4 rounded-lg bg-ivory-50 p-3">
                <summary className="cursor-pointer font-semibold">Add a date (tax season opening, state deadline, disaster relief…)</summary>
                <ActionForm action={saveDeadlineAction.bind(null, null)} className="mt-2 space-y-2" resetOnSuccess>
                  <DeadlineFields />
                  <Button type="submit">Save date</Button>
                </ActionForm>
              </details>
            )}
          </Card>
        </div>

        <Card title="Tax questionnaires (Jotform)">
          <p className="mb-3 text-sm text-slate-600">
            One questionnaire per tax year (optionally separate ones for individuals and businesses). Paste the form ID or jotform.com link exactly as Jotform shows it. Until a form is set, clients see “not available yet”. Jotform: <strong>{jf.label}</strong>.
          </p>
          <ul className="divide-y divide-navy-100" data-testid="questionnaires">
            {questionnaires.map((q) => (
              <li key={q.id} className="py-3">
                <p className="font-semibold">
                  {q.title} <Badge tone={q.jotformFormId ? "green" : "amber"}>{q.jotformFormId ? `Form ${q.jotformFormId}` : "Form ID needed"}</Badge>{" "}
                  <Badge tone="gray">{q.audience === "ALL" ? "All clients" : q.audience === "INDIVIDUAL" ? "Individuals" : "Businesses"}</Badge>{" "}
                  {!q.active && <Badge tone="gray">Off</Badge>} <span className="text-xs font-normal text-slate-600">{q._count.submissions} linked submission{q._count.submissions === 1 ? "" : "s"}</span>
                </p>
                {admin && (
                  <ActionForm action={saveQuestionnaireAction.bind(null, q.id)} className="mt-2 grid gap-2 sm:grid-cols-5">
                    <input type="hidden" name="taxYear" value={q.taxYear} />
                    <input type="hidden" name="audience" value={q.audience} />
                    <Field label="Title" className="sm:col-span-2"><input className="input" name="title" defaultValue={q.title} /></Field>
                    <Field label="Jotform form ID or link" className="sm:col-span-2"><input className="input" name="jotformFormId" defaultValue={q.jotformFormId ?? ""} /></Field>
                    <div className="flex items-end gap-2">
                      <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="active" defaultChecked={q.active} /> On</label>
                      <Button type="submit" variant="secondary">Save</Button>
                    </div>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
          {admin && (
            <details className="mt-3 rounded-lg bg-ivory-50 p-3">
              <summary className="cursor-pointer font-semibold">Add a year or audience</summary>
              <ActionForm action={saveQuestionnaireAction.bind(null, null)} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
                <Field label="Tax year"><input className="input" name="taxYear" inputMode="numeric" defaultValue={new Date().getFullYear()} required /></Field>
                <Field label="For">
                  <select className="input" name="audience" defaultValue="ALL"><option value="ALL">All clients</option><option value="INDIVIDUAL">Individuals</option><option value="BUSINESS">Businesses</option></select>
                </Field>
                <Field label="Title"><input className="input" name="title" /></Field>
                <Field label="Jotform form ID or link"><input className="input" name="jotformFormId" /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked /> On</label>
                <div><Button type="submit">Add questionnaire</Button></div>
              </ActionForm>
            </details>
          )}
        </Card>
      </div>
    </>
  );
}
