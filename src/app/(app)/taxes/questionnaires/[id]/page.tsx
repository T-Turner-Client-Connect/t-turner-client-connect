import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { fetchSubmission, summarize } from "@/lib/services/tax-center";
import { INBOX_KIND, INBOX_REASON, INBOX_STATE, inboxKind, inboxState, markPreviewed, suggestClients } from "@/lib/services/questionnaire-intake";
import { dismissInboxAction, fileInboxAction } from "@/app/actions/questionnaire-intake";
import { formatPhone } from "@/lib/normalize";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Questionnaire" };

export default async function InboxItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const item = await prisma.jotformInbox.findUnique({ where: { id } });
  if (!item) notFound();
  if (item.status === "FILED" && item.filedClientId) {
    const s = await prisma.questionnaireSubmission.findUnique({ where: { submissionId: item.submissionId }, select: { clientId: true, taxYear: true } });
    if (s) redirect(`/clients/${s.clientId}/questionnaires?year=${s.taxYear}`);
  }
  await markPreviewed(user, item.id);

  let sum: ReturnType<typeof summarize> | null = null;
  let loadError: string | null = null;
  try {
    sum = summarize(await fetchSubmission(item.submissionId));
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Couldn't load the submission from Jotform.";
  }
  const suggested = await suggestClients(item);
  const q = sp.q?.trim() ?? "";
  const found = q.length >= 2
    ? await prisma.client.findMany({
        where: { archivedAt: null, OR: [{ displayName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] },
        select: { id: true, displayName: true, email: true, phone: true },
        take: 10,
        orderBy: { displayName: "asc" },
      })
    : [];
  const options = [...suggested.map((s) => ({ ...s, label: `${s.displayName} — ${s.why.join(", ")}` })), ...found.filter((f) => !suggested.some((s) => s.id === f.id)).map((f) => ({ ...f, why: ["Search result"], verified: false, label: `${f.displayName}${f.email ? ` · ${f.email}` : ""}` }))];
  const preselect = suggested.find((s) => s.verified)?.id ?? "";
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - 2019 }, (_, k) => thisYear - k);
  const [first, ...rest] = (item.names[0] ?? "").split(/\s+/);
  const state = inboxState(item, null);
  const kind = INBOX_KIND[inboxKind(item, null)];
  const open = item.status === "PENDING";

  return (
    <>
      <PageHeader
        title={item.names[0] ?? item.emails[0] ?? "Questionnaire submission"}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Link className="underline" href="/taxes/questionnaires">Questionnaire Inbox</Link> · {item.submittedAt ? `Submitted ${fmtDateTime(item.submittedAt)}` : `Received ${fmtDateTime(item.receivedAt)}`} <Badge tone={kind.tone}>{kind.label}</Badge><Badge tone={INBOX_STATE[state].tone}>{INBOX_STATE[state].label}</Badge></span>}
      />
      <p className="mb-4 text-sm text-slate-600">{INBOX_REASON[item.reason] ?? item.reason}{item.taxYear ? ` · form for ${item.taxYear}` : ""}</p>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Card title="Answers (staff only)">
            {loadError ? <Notice tone="error">{loadError}</Notice> : (
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2" data-testid="answers">
                {sum!.pairs.map((a, n) => <div key={n}><dt className="text-xs text-slate-500">{a.q}</dt><dd className="whitespace-pre-wrap">{a.a}</dd></div>)}
              </dl>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-2">
          {open ? (
            <Card title="Assign to a client">
              <form className="mb-3 flex gap-2" action={`/taxes/questionnaires/${item.id}`}>
                <input className="input" name="q" defaultValue={q} placeholder="Search clients by name, email or phone" aria-label="Search clients" />
                <Button type="submit" variant="secondary">Search</Button>
              </form>
              <ActionForm action={fileInboxAction.bind(null, item.id)} className="space-y-3" confirm="Assign this questionnaire to the chosen client and tax year? The ticked attachments go to that year's vault for review.">
                <fieldset className="space-y-1 text-sm" data-testid="client-choices">
                  <legend className="mb-1 font-semibold text-navy-900">Client</legend>
                  {options.length === 0 && <p className="text-slate-600">No suggestions. Search above, or create a new client.</p>}
                  {options.map((o) => (
                    <label key={o.id} className="flex items-start gap-2">
                      <input type="radio" name="clientId" value={o.id} defaultChecked={o.id === preselect} className="mt-1 accent-navy-900" required />
                      <span>{o.label}{o.verified ? <Badge tone="green" className="ml-1">Coetha: verified match</Badge> : o.why.some((w) => w.startsWith("Name only")) ? <Badge tone="amber" className="ml-1">Name only — verify</Badge> : null}</span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2"><input type="radio" name="clientId" value="__new" className="mt-1 accent-navy-900" /> <span>Create a new client (no portal login is created)</span></label>
                  <div className="ml-6 grid gap-2 sm:grid-cols-2">
                    <input className="input" name="newFirstName" defaultValue={first ?? ""} placeholder="First name" aria-label="New client first name" />
                    <input className="input" name="newLastName" defaultValue={rest.join(" ")} placeholder="Last name" aria-label="New client last name" />
                    <input className="input" name="newEmail" defaultValue={item.emails[0] ?? ""} placeholder="Email" aria-label="New client email" />
                    <input className="input" name="newPhone" defaultValue={item.phones[0] ? formatPhone(item.phones[0]) : ""} placeholder="Phone" aria-label="New client phone" />
                  </div>
                </fieldset>
                <Field label="Tax year">
                  <select className="input" name="taxYear" defaultValue={item.taxYear ?? thisYear - 1}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
                </Field>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="yearConfirmed" className="mt-1 accent-navy-900" required /> I confirm this is the correct client and tax year.</label>
                {sum && sum.files.length > 0 && (
                  <fieldset className="space-y-1 text-sm">
                    <legend className="mb-1 font-semibold text-navy-900">Attachments to save in the vault</legend>
                    {sum.files.map((u, n) => (
                      <label key={n} className="flex items-start gap-2">
                        <input type="checkbox" name="file" value={n} defaultChecked className="mt-1 accent-navy-900" />
                        <span className="min-w-0 break-all">{decodeURIComponent(u.split("/").pop() ?? `File ${n + 1}`)} · <a className="underline" href={`/api/jotform/file?inbox=${item.id}&n=${n}`} target="_blank" rel="noopener">Preview</a></span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <Field label="Note (optional)"><input className="input" name="note" placeholder="e.g. confirmed by phone" /></Field>
                <Button type="submit" className="w-full">Assign questionnaire</Button>
              </ActionForm>
            </Card>
          ) : (
            <Notice tone="info">This submission was {item.status === "DISMISSED" ? "dismissed" : "assigned"}.</Notice>
          )}
          {open && (
            <Card title="Not a client questionnaire?">
              <ActionForm action={dismissInboxAction.bind(null, item.id)} className="flex flex-wrap items-end gap-2">
                <input className="input" name="note" placeholder="Reason (test, duplicate…)" aria-label="Reason" required />
                <Button type="submit" variant="secondary">Dismiss</Button>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
