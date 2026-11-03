import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { jotformConfig } from "@/lib/services/contracts";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { INBOX_REASON, inboxCandidates, jotformAutoFileOn } from "@/lib/services/questionnaire-intake";
import { dismissInboxAction, fileInboxAction, setJotformAutoFileAction, testJotformAction } from "@/app/actions/questionnaire-intake";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Questionnaire review inbox" };

export default async function QuestionnaireInboxPage() {
  const user = await requireUser();
  const [items, autoFile, owner] = await Promise.all([
    prisma.jotformInbox.findMany({ where: { status: "PENDING" }, orderBy: { receivedAt: "asc" }, take: 100 }),
    jotformAutoFileOn(),
    isReportApprover(user),
  ]);
  const suggested = new Map((await prisma.client.findMany({ where: { id: { in: items.map((i) => i.suggestedClientId).filter((v): v is string => !!v) } }, select: { id: true, displayName: true } })).map((c) => [c.id, c]));
  const candidates = await Promise.all(items.map((i) => inboxCandidates(i.emails)));
  const c = jotformConfig();
  const thisYear = new Date().getFullYear();

  return (
    <>
      <PageHeader title="Questionnaire review inbox" subtitle="Jotform tax questionnaires waiting for staff — unmatched submissions, and every submission while automatic filing is off." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2" data-testid="inbox">
          {items.length === 0 && <EmptyState title="Nothing waiting">New questionnaire submissions that need a person will appear here.</EmptyState>}
          {items.map((i, n) => {
            const s = i.suggestedClientId ? suggested.get(i.suggestedClientId) : null;
            const options = [...(s ? [s] : []), ...candidates[n].filter((x) => x.id !== s?.id)];
            return (
              <Card key={i.id} title={`Submission ${i.submissionId}`} actions={<Badge tone={i.reason === "HELD" ? "navy" : "amber"}>{i.reason === "HELD" ? "Verified link" : "Unmatched"}</Badge>}>
                <p className="text-sm">{INBOX_REASON[i.reason] ?? i.reason}</p>
                <p className="text-xs text-slate-600">Received {fmtDateTime(i.receivedAt)} · form {i.formId}{i.taxYear ? ` · ${i.taxYear} questionnaire` : ""}{i.emails.length ? ` · email on form: ${i.emails.join(", ")}` : ""}</p>
                {s && <p className="mt-1 text-sm">Signed link is for <Link className="font-semibold underline" href={`/clients/${s.id}/questionnaires?year=${i.taxYear}`}>{s.displayName}</Link></p>}
                <ActionForm action={fileInboxAction.bind(null, i.id)} className="mt-3 grid gap-2 sm:grid-cols-3" confirm="File this submission to the chosen client and tax year? Answers are read from Jotform and attachments saved to their vault (staff only).">
                  <Field label="Client">
                    <select className="input" name="clientId" defaultValue={options[0]?.id ?? ""} required>
                      <option value="" disabled>Choose…</option>
                      {options.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
                    </select>
                  </Field>
                  <Field label="Tax year">
                    <select className="input" name="taxYear" defaultValue={i.taxYear ?? thisYear - 1}>{Array.from({ length: thisYear - 2021 }, (_, k) => thisYear - k).map((y) => <option key={y} value={y}>{y}</option>)}</select>
                  </Field>
                  <div className="flex items-end"><Button type="submit">File to client</Button></div>
                  {i.reason !== "HELD" && (
                    <>
                      <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="confirmed" /> I confirmed it belongs to this client (needed when the email doesn&apos;t match)</label>
                      <Field label="How you confirmed it" className="sm:col-span-3"><input className="input" name="matchNote" /></Field>
                    </>
                  )}
                </ActionForm>
                {options.length === 0 && <p className="mt-1 text-xs text-slate-600">No client has this email. Find the client on the Clients page; you can also link it from their Questionnaires page by submission ID.</p>}
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm underline">Dismiss (test, duplicate, not ours)</summary>
                  <ActionForm action={dismissInboxAction.bind(null, i.id)} className="mt-2 flex flex-wrap items-end gap-2">
                    <input className="input w-72" name="note" placeholder="Reason" aria-label="Reason" required />
                    <Button type="submit" variant="secondary">Dismiss</Button>
                  </ActionForm>
                </details>
              </Card>
            );
          })}
        </div>
        <div className="space-y-4">
          <Card title="Automatic filing">
            <p className="text-sm"><Badge tone={autoFile ? "green" : "gray"}>{autoFile ? "On" : "Off"}</Badge> {autoFile ? "Submissions from a client's signed questionnaire link are filed to that client and year automatically. Everything else waits here." : "Every questionnaire submission waits here until staff file it."}</p>
            {owner && (
              <ActionForm action={setJotformAutoFileAction.bind(null, !autoFile)} className="mt-2" confirm={autoFile ? "Turn automatic filing off?" : "Turn automatic filing on? Verified, signed submissions will be filed to client records without waiting here."}>
                <Button type="submit" variant={autoFile ? "secondary" : "gold"}>{autoFile ? "Turn off" : "Turn on"}</Button>
              </ActionForm>
            )}
            {!owner && <p className="mt-1 text-xs text-slate-600">Only Tabitha can change this.</p>}
          </Card>
          <Card title="Webhook setup">
            <Notice tone={c.apiKey && c.webhookSecret ? "success" : "warn"}>
              API key: {c.apiKey ? "set" : "not set"} · Webhook secret: {c.webhookSecret ? (c.webhookSecret.length >= 32 ? "set" : "too short (32+ characters)") : "not set"}
            </Notice>
            <p className="mt-2 text-sm">In Jotform → each questionnaire form → Settings → Integrations → WebHooks, enter:</p>
            <code className="mt-1 block break-all rounded bg-ivory-50 p-2 text-xs">https://client.tturnerassociates.com/api/webhooks/jotform?secret=&lt;JOTFORM_WEBHOOK_SECRET&gt;</code>
            <p className="mt-1 text-xs text-slate-600">Replace the placeholder with the secret saved in Netlify. It&apos;s never shown here.</p>
            {user.role === "ADMIN" && <ActionForm action={testJotformAction} className="mt-2"><Button type="submit" variant="secondary">Test Jotform connection</Button></ActionForm>}
          </Card>
        </div>
      </div>
    </>
  );
}
