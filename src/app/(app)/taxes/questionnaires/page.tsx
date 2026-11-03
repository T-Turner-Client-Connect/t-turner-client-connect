import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, buttonClass, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { jotformConfig } from "@/lib/services/contracts";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { INBOX_REASON, INBOX_STATE, inboxState, jotformAutoFileOn, type InboxState } from "@/lib/services/questionnaire-intake";
import { importRecentAction, setJotformAutoFileAction, testJotformAction } from "@/app/actions/questionnaire-intake";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Questionnaire Inbox" };

const TABS: { key: string; label: string; states: InboxState[] }[] = [
  { key: "open", label: "To do", states: ["NEW", "REVIEWED"] },
  { key: "assigned", label: "Assigned", states: ["ASSIGNED"] },
  { key: "completed", label: "Completed", states: ["COMPLETED"] },
  { key: "dismissed", label: "Dismissed", states: ["DISMISSED"] },
];

export default async function QuestionnaireInboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const [items, autoFile, owner] = await Promise.all([
    prisma.jotformInbox.findMany({ orderBy: { receivedAt: "desc" }, take: 500 }),
    jotformAutoFileOn(),
    isReportApprover(user),
  ]);
  const filed = new Map((await prisma.questionnaireSubmission.findMany({ where: { submissionId: { in: items.filter((i) => i.status === "FILED").map((i) => i.submissionId) } }, select: { submissionId: true, reviewStatus: true } })).map((s) => [s.submissionId, s]));
  const withState = items.map((i) => ({ ...i, state: inboxState(i, filed.get(i.submissionId)) }));
  const count = (t: (typeof TABS)[number]) => withState.filter((i) => t.states.includes(i.state)).length;
  const shown = withState.filter((i) => tab.states.includes(i.state));
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: shown.flatMap((i) => [i.filedClientId, i.suggestedClientId]).filter((v): v is string => !!v) } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
  const c = jotformConfig();

  return (
    <>
      <PageHeader title="Questionnaire Inbox" subtitle="Every Jotform tax questionnaire arrives here first. Review it, choose or create the client, confirm the tax year, and assign it." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <nav aria-label="Inbox filter" className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link key={t.key} href={`/taxes/questionnaires?tab=${t.key}`} className={buttonClass(t.key === tab.key ? "primary" : "secondary")} aria-current={t.key === tab.key ? "page" : undefined}>
                {t.label} ({count(t)})
              </Link>
            ))}
          </nav>
          {shown.length === 0 && <EmptyState title={tab.key === "open" ? "Nothing waiting" : "Nothing here yet"}>{tab.key === "open" ? "New questionnaire submissions will appear here." : ""}</EmptyState>}
          <ul className="space-y-2" data-testid="inbox-list">
            {shown.map((i) => {
              const st = INBOX_STATE[i.state];
              const who = i.names[0] ?? i.emails[0] ?? "Name not given";
              return (
                <li key={i.id}>
                  <Link href={`/taxes/questionnaires/${i.id}`} className="block rounded-xl border border-ivory-200 bg-white p-3 hover:border-gold-500 sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-navy-900">{who}</p>
                        <p className="text-xs text-slate-600">
                          {i.taxYear ? `${i.taxYear} questionnaire · ` : ""}{i.submittedAt ? `Submitted ${fmtDateTime(i.submittedAt)}` : `Received ${fmtDateTime(i.receivedAt)}`} · {INBOX_REASON[i.reason] ?? i.reason}
                        </p>
                        {i.filedClientId && <p className="text-xs">Assigned to <strong>{clients.get(i.filedClientId) ?? "client"}</strong></p>}
                        {!i.filedClientId && i.reason === "HELD" && i.suggestedClientId && <p className="text-xs">Coetha suggests <strong>{clients.get(i.suggestedClientId) ?? "client"}</strong> (verified link)</p>}
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-4">
          <Card title="Missed any submissions?">
            <p className="text-sm text-slate-600">Brings recent submissions of your questionnaire forms into this inbox (for example, ones sent before the webhook was connected). Nothing is filed and duplicates are skipped.</p>
            <ActionForm action={importRecentAction} className="mt-2"><Button type="submit" variant="secondary">Check Jotform for new submissions</Button></ActionForm>
          </Card>
          <Card title="Automatic filing">
            <p className="text-sm"><Badge tone={autoFile ? "green" : "gray"}>{autoFile ? "On" : "Off"}</Badge> {autoFile ? "Verified personal-link submissions are filed automatically and listed here as Assigned." : "Nothing is filed until staff assign it here."}</p>
            {owner && (
              <ActionForm action={setJotformAutoFileAction.bind(null, !autoFile)} className="mt-2" confirm={autoFile ? "Turn automatic filing off?" : "Turn automatic filing on? Verified personal-link submissions will be filed without staff approval."}>
                <Button type="submit" variant="secondary">{autoFile ? "Turn off" : "Turn on"}</Button>
              </ActionForm>
            )}
          </Card>
          <Card title="Jotform connection">
            <Notice tone={c.apiKey && c.webhookSecret && c.webhookSecret.length >= 32 ? "success" : "warn"}>
              API key: {c.apiKey ? "set" : "not set"} · Webhook secret: {c.webhookSecret ? (c.webhookSecret.length >= 32 ? "set" : "too short (32+ characters)") : "not set"}
            </Notice>
            <p className="mt-2 text-xs text-slate-600">Webhook address for each questionnaire form (Jotform → Settings → Integrations → WebHooks): <code className="break-all">https://client.tturnerassociates.com/api/webhooks/jotform?secret=…</code> — the secret is the value saved in Netlify and is never shown here.</p>
            {user.role === "ADMIN" && <ActionForm action={testJotformAction} className="mt-2"><Button type="submit" variant="secondary">Test Jotform connection</Button></ActionForm>}
          </Card>
        </div>
      </div>
    </>
  );
}
