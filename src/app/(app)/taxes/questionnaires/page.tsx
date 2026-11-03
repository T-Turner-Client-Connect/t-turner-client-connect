import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, buttonClass, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { jotformConfig } from "@/lib/services/contracts";
import { INBOX_KIND, INBOX_REASON, INBOX_STATE, inboxKind, inboxState, type InboxState } from "@/lib/services/questionnaire-intake";
import { importRecentAction, testJotformAction } from "@/app/actions/questionnaire-intake";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Questionnaire Inbox" };

const TABS: { key: string; label: string; states: InboxState[] }[] = [
  { key: "open", label: "Needs matching", states: ["NEW", "REVIEWED"] },
  { key: "assigned", label: "Answers to review", states: ["ASSIGNED"] },
  { key: "completed", label: "Completed", states: ["COMPLETED"] },
  { key: "dismissed", label: "Dismissed", states: ["DISMISSED"] },
];

export default async function QuestionnaireInboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const items = await prisma.jotformInbox.findMany({ orderBy: { receivedAt: "desc" }, take: 500 });
  const filedRows = await prisma.questionnaireSubmission.findMany({ where: { submissionId: { in: items.filter((i) => i.status === "FILED").map((i) => i.submissionId) } }, select: { submissionId: true, reviewStatus: true, clientId: true, taxYear: true } });
  const filed = new Map(filedRows.map((s) => [s.submissionId, s]));
  const clientIds = items.flatMap((i) => [i.filedClientId, i.suggestedClientId]).filter((v): v is string => !!v);
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, displayName: true, source: true, createdAt: true } })).map((c) => [c.id, c]));
  const withState = items.map((i) => ({ ...i, state: inboxState(i, filed.get(i.submissionId)), kind: inboxKind(i, clients.get(i.suggestedClientId ?? "")) }));
  const count = (t: (typeof TABS)[number]) => withState.filter((i) => t.states.includes(i.state)).length;
  const shown = withState.filter((i) => tab.states.includes(i.state));
  const c = jotformConfig();

  return (
    <>
      <PageHeader title="Questionnaire Inbox" subtitle="Every tax questionnaire is listed here. Verified clients are linked automatically; anything else waits for staff to match it." />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <nav aria-label="Inbox filter" className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Link key={t.key} href={`/taxes/questionnaires?tab=${t.key}`} className={buttonClass(t.key === tab.key ? "primary" : "secondary")} aria-current={t.key === tab.key ? "page" : undefined}>
                {t.label} ({count(t)})
              </Link>
            ))}
          </nav>
          {shown.length === 0 && <EmptyState title="Nothing here">{tab.key === "open" ? "Submissions that need a person to match them will appear here." : "Nothing in this list yet."}</EmptyState>}
          <ul className="space-y-2" data-testid="inbox-list">
            {shown.map((i) => {
              const st = INBOX_STATE[i.state];
              const k = INBOX_KIND[i.kind];
              const f = filed.get(i.submissionId);
              const who = (i.filedClientId && clients.get(i.filedClientId)?.displayName) || i.names[0] || i.emails[0] || "Name not given";
              const href = f ? `/clients/${f.clientId}/questionnaires?year=${f.taxYear}` : `/taxes/questionnaires/${i.id}`;
              return (
                <li key={i.id}>
                  <Link href={href} className="block rounded-xl border border-ivory-200 bg-white p-3 hover:border-gold-500 sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-navy-900">{who}</p>
                        <p className="text-xs text-slate-600">
                          {i.taxYear ? `${f?.taxYear ?? i.taxYear} questionnaire · ` : ""}{i.submittedAt ? `Submitted ${fmtDateTime(i.submittedAt)}` : `Received ${fmtDateTime(i.receivedAt)}`} · {INBOX_REASON[i.reason] ?? i.reason}
                        </p>
                      </div>
                      <span className="flex flex-wrap gap-1"><Badge tone={k.tone}>{k.label}</Badge><Badge tone={st.tone}>{st.label}</Badge></span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="space-y-4">
          <Card title="How submissions are handled">
            <ul className="space-y-1 text-sm">
              <li><Badge tone="green">Verified Client</Badge> / <Badge tone="navy">New Client</Badge> — sent from the client&apos;s own Client Connect account. Linked to that client and tax year automatically; staff review the answers and documents.</li>
              <li><Badge tone="amber">Needs Matching</Badge> — from an old public Jotform link. Staff choose or create the client and confirm the tax year.</li>
            </ul>
            <p className="mt-2 text-xs text-slate-600">Nothing in a questionnaire changes a client record, and no document is approved, until staff review it.</p>
          </Card>
          <Card title="Missed any submissions?">
            <p className="text-sm text-slate-600">Brings recent submissions of your questionnaire forms into this inbox (for example, ones sent before the webhook was connected). Duplicates are skipped.</p>
            <ActionForm action={importRecentAction} className="mt-2"><Button type="submit" variant="secondary">Check Jotform for new submissions</Button></ActionForm>
          </Card>
          <Card title="Jotform connection">
            <Notice tone={c.apiKey && c.webhookSecret && c.webhookSecret.length >= 32 ? "success" : "warn"}>
              API key: {c.apiKey ? "set" : "not set"} · Webhook secret: {c.webhookSecret ? (c.webhookSecret.length >= 32 ? "set" : "too short (32+ characters)") : "not set"}
            </Notice>
            {user.role === "ADMIN" && <ActionForm action={testJotformAction} className="mt-2"><Button type="submit" variant="secondary">Test Jotform connection</Button></ActionForm>}
          </Card>
        </div>
      </div>
    </>
  );
}
