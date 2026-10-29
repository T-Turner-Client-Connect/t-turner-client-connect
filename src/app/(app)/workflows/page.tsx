import Link from "next/link";
import clsx from "clsx";
import type { PrepStatus } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { bulkPublishFilingsAction } from "@/app/actions/tax";
import { addProspectAction, cancelReminderAction, moveProspectAction, removeProspectAction, runAutomationsNowAction, saveStageAction, updateRuleAction } from "@/app/actions/workflows";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { prospectStages } from "@/lib/services/pipelines";
import { AUTOMATION_TEMPLATES, ensureAutomationRules } from "@/lib/services/automations";
import { MONTHS } from "@/lib/services/bookkeeping";
import { TAX_QUEUES } from "@/lib/services/tax";
import { filingStatusLabel, filingTitle, jurisdictionLabel } from "@/lib/tax/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Workflows" };

const TABS = [
  ["prospects", "Prospects"],
  ["bookkeeping", "Bookkeeping"],
  ["taxes", "Taxes"],
  ["automations", "Automations"],
] as const;

function Board({ columns }: { columns: { key: string; title: string; items: React.ReactNode[] }[] }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((c) => (
        <section key={c.key} className="w-72 shrink-0 rounded-2xl border border-ivory-200 bg-ivory-50 p-3">
          <h2 className="mb-2 flex items-center justify-between font-sans text-sm font-semibold text-navy-900">{c.title}<Badge tone="gray">{c.items.length}</Badge></h2>
          <div className="space-y-2">{c.items.length ? c.items : <p className="text-xs text-slate-500">Empty</p>}</div>
        </section>
      ))}
    </div>
  );
}

const cardCls = "block rounded-xl border border-ivory-200 bg-white p-3 text-sm shadow-sm";

export default async function Workflows({ searchParams }: { searchParams: Promise<{ tab?: string; queue?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.find(([k]) => k === sp.tab)?.[0] ?? "prospects";
  return (
    <>
      <PageHeader title="Workflows" subtitle="Pipelines for prospects, bookkeeping and taxes, plus reminder automations." />
      <nav className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-ivory-200 bg-white p-1" aria-label="Workflows">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/workflows?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={clsx("whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold", tab === k ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-ivory-50")}>
            {label}
          </Link>
        ))}
      </nav>
      {tab === "prospects" && <Prospects isAdmin={user.role === "ADMIN"} />}
      {tab === "bookkeeping" && <Bookkeeping />}
      {tab === "taxes" && <Taxes queue={sp.queue} />}
      {tab === "automations" && <Automations isAdmin={user.role === "ADMIN"} />}
    </>
  );
}

async function Prospects({ isAdmin }: { isAdmin: boolean }) {
  const stages = await prospectStages();
  const inPipeline = new Set(stages.flatMap((s) => s.cards.map((c) => c.clientId)));
  const candidates = await prisma.client.findMany({ where: { archivedAt: null, status: "PROSPECT" }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } });
  return (
    <div className="space-y-4">
      <Board
        columns={stages.map((s) => ({
          key: s.id,
          title: s.name,
          items: s.cards.map((c) => (
            <div key={c.id} className={cardCls}>
              <Link href={`/clients/${c.clientId}`} className="font-semibold text-navy-900 underline">{c.client.displayName}</Link>
              <p className="text-xs text-slate-500">Updated {fmtDate(c.updatedAt)}</p>
              <ActionForm action={moveProspectAction.bind(null, c.id)} className="mt-2 flex gap-1" showSuccess={false}>
                <select className="input py-1 text-sm" name="stageId" defaultValue={s.id} aria-label="Move to stage">
                  {stages.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <Button type="submit" variant="secondary" className="px-2">Move</Button>
              </ActionForm>
              <ConfirmButton action={removeProspectAction.bind(null, c.id)} variant="ghost" className="mt-1 px-2 text-xs" confirm="Remove from the pipeline? The client record stays.">Remove</ConfirmButton>
            </div>
          )),
        }))}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Add a prospect">
          <ActionForm action={addProspectAction} className="flex flex-wrap items-end gap-2" resetOnSuccess>
            <Field label="Client (status Prospect)">
              <select className="input" name="clientId" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {candidates.filter((c) => !inPipeline.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.displayName}</option>)}
              </select>
            </Field>
            <input type="hidden" name="stageId" value={stages[0]?.id} />
            <Button type="submit">Add to New Inquiry</Button>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-600">Moving a card to &quot;{stages.find((s) => s.isWon)?.name}&quot; marks the client Active.</p>
        </Card>
        {isAdmin && (
          <Card title="Stages">
            <ul className="space-y-2">
              {stages.map((s) => (
                <li key={s.id}>
                  <ActionForm action={saveStageAction.bind(null, s.id)} className="flex gap-2" showSuccess={false}>
                    <input className="input" name="name" defaultValue={s.name} aria-label="Stage name" />
                    <Button type="submit" variant="secondary">Rename</Button>
                  </ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={saveStageAction.bind(null, null)} className="mt-3 flex gap-2" resetOnSuccess>
              <input className="input" name="name" placeholder="New stage name" aria-label="New stage" />
              <Button type="submit">Add stage</Button>
            </ActionForm>
          </Card>
        )}
      </div>
    </div>
  );
}

async function Bookkeeping() {
  const periods = await prisma.bookkeepingPeriod.findMany({
    where: { client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true } }, _count: { select: { requests: { where: { status: "OPEN" } } } } },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: 400,
  });
  const col = (status: string, title: string) => ({
    key: status,
    title,
    items: periods.filter((p) => p.status === status).map((p) => (
      <Link key={p.id} href={`/clients/${p.client.id}?tab=bookkeeping`} className={cardCls}>
        <span className="font-semibold text-navy-900">{p.client.displayName}</span>
        <span className="block text-slate-600">{MONTHS[p.month - 1]} {p.year}</span>
        {p._count.requests > 0 && <Badge tone="amber" className="mt-1">{p._count.requests} document(s) owed</Badge>}
      </Link>
    )),
  });
  return (
    <>
      <Board columns={[col("AWAITING_DOCUMENTS", "Awaiting documents"), col("IN_PROGRESS", "In progress"), col("READY_FOR_REVIEW", "Review"), col("COMPLETE", "Complete")]} />
      <p className="mt-2 text-xs text-slate-600">Change a month&apos;s status from the client&apos;s Bookkeeping tab.</p>
    </>
  );
}

const TAX_COLUMNS: { key: PrepStatus | "FILED"; title: string }[] = [
  { key: "AWAITING_INFORMATION", title: "Awaiting documents" },
  { key: "IN_PROGRESS", title: "Preparation" },
  { key: "UNDER_REVIEW", title: "Review" },
  { key: "AWAITING_SIGNATURE", title: "Awaiting signature" },
  { key: "READY_TO_FILE", title: "Ready to file" },
  { key: "FILED", title: "Filed (confirmed)" },
];

async function Taxes({ queue }: { queue?: string }) {
  const q = queue && queue in TAX_QUEUES ? (queue as keyof typeof TAX_QUEUES) : null;
  const filings = await prisma.filingRecord.findMany({
    where: { ...(q ? TAX_QUEUES[q].where : { filingType: "ORIGINAL" }), client: { archivedAt: null } },
    include: { client: { select: { id: true, displayName: true } } },
    orderBy: [{ taxYear: "desc" }, { updatedAt: "desc" }],
    take: 400,
  });
  const card = (f: (typeof filings)[number]) => (
    <Link key={f.id} href={`/clients/${f.client.id}?tab=taxes`} className={cardCls}>
      <span className="font-semibold text-navy-900">{f.client.displayName}</span>
      <span className="block text-slate-600">{f.taxYear} · {f.returnType} · {jurisdictionLabel(f.jurisdiction)}</span>
      <Badge tone={f.filingStatus === "ACCEPTED" ? "green" : f.filingStatus === "REJECTED" ? "red" : "gray"} className="mt-1">{filingStatusLabel(f)}</Badge>
    </Link>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Link href="/workflows?tab=taxes" className={clsx("rounded-lg px-3 py-2 text-sm font-semibold", !q ? "bg-navy-900 text-white" : "border border-ivory-200 bg-white")}>Original returns board</Link>
        {(Object.keys(TAX_QUEUES) as (keyof typeof TAX_QUEUES)[]).map((k) => (
          <Link key={k} href={`/workflows?tab=taxes&queue=${k}`} className={clsx("rounded-lg px-3 py-2 text-sm font-semibold", q === k ? "bg-navy-900 text-white" : "border border-ivory-200 bg-white")}>{TAX_QUEUES[k].label}</Link>
        ))}
        <Link href="/imports/tax" className="ml-auto rounded-lg border border-ivory-200 bg-white px-3 py-2 text-sm font-semibold">Import TaxAct e-file status</Link>
      </div>
      {q && (q === "accepted" || q === "extensions" || q === "amended") && filings.length > 0 ? (
        <Card title={`${TAX_QUEUES[q].label} — review & publish`}>
          <ActionForm action={bulkPublishFilingsAction} className="space-y-3" confirm="Publish the selected filing updates to these clients' portals?">
            <ul className="divide-y divide-ivory-200 text-sm">
              {filings.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-3 py-2">
                  <input type="checkbox" name="filingIds" value={f.id} className="size-4 accent-navy-900" aria-label={`Select ${f.client.displayName}`} />
                  <span className="flex-1"><Link className="font-semibold underline" href={`/clients/${f.client.id}?tab=taxes`}>{f.client.displayName}</Link> · {filingTitle(f)}</span>
                  <Badge tone={f.filingStatus === "ACCEPTED" ? "green" : f.filingStatus === "REJECTED" ? "red" : "gray"}>{filingStatusLabel(f)}</Badge>
                  {f.visibleToClient ? null : <Badge tone="gray">Hidden from client</Badge>}
                </li>
              ))}
            </ul>
            <div className="rounded-lg bg-ivory-50 p-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" name="notifyClient" className="accent-navy-900" /> Notify clients (sign-in link only)</label>
              <div className="ml-6 flex gap-4">
                <label className="flex items-center gap-1"><input type="checkbox" name="notify" value="EMAIL" defaultChecked className="accent-navy-900" /> Email</label>
                <label className="flex items-center gap-1"><input type="checkbox" name="notify" value="SMS" className="accent-navy-900" /> Text</label>
              </div>
              <label className="mt-2 flex items-center gap-2 font-semibold"><input type="checkbox" name="reviewed" className="accent-navy-900" /> I reviewed each selected filing and its acknowledgment</label>
            </div>
            <Button type="submit">Publish selected</Button>
          </ActionForm>
        </Card>
      ) : q ? (
        <Card title={TAX_QUEUES[q].label}>
          {filings.length ? (
            <ul className="divide-y divide-ivory-200 text-sm">
              {filings.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><Link className="font-semibold underline" href={`/clients/${f.client.id}?tab=taxes`}>{f.client.displayName}</Link> · {filingTitle(f)}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={f.filingStatus === "ACCEPTED" ? "green" : f.filingStatus === "REJECTED" ? "red" : "gray"}>{filingStatusLabel(f)}</Badge>
                    {f.lastVerifiedAt && <span className="text-xs text-slate-500">verified {fmtDateTime(f.lastVerifiedAt)} ({f.statusSource === "TAXACT_IMPORT" ? "TaxAct import" : "staff"})</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-600">Nothing in this queue.</p>
          )}
        </Card>
      ) : (
        <Board
          columns={TAX_COLUMNS.map((c) => ({
            key: c.key,
            title: c.title,
            items: filings
              .filter((f) => {
                const filed = ["SUBMITTED", "PENDING_ACKNOWLEDGMENT", "ACCEPTED"].includes(f.filingStatus);
                return c.key === "FILED" ? filed : !filed && f.prepStatus === c.key;
              })
              .map(card),
          }))}
        />
      )}
      <p className="text-xs text-slate-600">&quot;Filed&quot; only reflects a staff-confirmed submission or a verified TaxAct import. Preparation and e-file statuses are tracked separately on each filing.</p>
    </div>
  );
}

async function Automations({ isAdmin }: { isAdmin: boolean }) {
  await ensureAutomationRules();
  const rules = await prisma.automationRule.findMany({ orderBy: { kind: "asc" }, include: { runs: { orderBy: { createdAt: "desc" }, take: 15 } } });
  const notificationsOn = process.env.NOTIFICATIONS_ENABLED === "true";
  return (
    <div className="space-y-4">
      <Notice tone={notificationsOn ? "info" : "warn"} title={notificationsOn ? "Reminders deliver through portal notifications" : "Reminders are recorded but not delivered yet"}>
        Reminders go to clients&apos; portal logins as account notices (sign-in link only), never as promotions.
        {!notificationsOn && " Set NOTIFICATIONS_ENABLED=true and configure email/text providers to deliver them."} Each reminder is logged once — reruns can&apos;t duplicate it.
      </Notice>
      {rules.map((r) => (
        <Card key={r.id} title={r.name} actions={<Badge tone={r.enabled ? "green" : "gray"}>{r.enabled ? "Running" : "Paused"}</Badge>}>
          <p className="mb-3 text-sm text-slate-600">{AUTOMATION_TEMPLATES[r.kind].describe}</p>
          <ActionForm action={updateRuleAction.bind(null, r.id)} className="grid gap-2 sm:grid-cols-5">
            <fieldset disabled={!isAdmin} className="contents">
              <Field label="State">
                <select className="input" name="enabled" defaultValue={String(r.enabled)}><option value="false">Paused</option><option value="true">Running</option></select>
              </Field>
              <Field label={r.kind === "CONTRACT_FOLLOW_UP" ? "First after (days)" : "Start (days, − = before)"}><input className="input" name="offsetDays" defaultValue={r.offsetDays} inputMode="numeric" /></Field>
              <Field label="Repeat every (days)"><input className="input" name="repeatEveryDays" defaultValue={r.repeatEveryDays ?? ""} inputMode="numeric" /></Field>
              <Field label="Max reminders"><input className="input" name="maxReminders" defaultValue={r.maxReminders} inputMode="numeric" /></Field>
              <div className="flex items-end">{isAdmin && <Button type="submit" variant="secondary">Save</Button>}</div>
            </fieldset>
          </ActionForm>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm underline">Recent activity ({r.runs.length})</summary>
            <ul className="mt-2 divide-y divide-ivory-200 text-sm">
              {r.runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>{run.targetKey} · <span className="text-slate-600">{run.outcome.toLowerCase()}</span></span>
                  <span className="flex items-center gap-2 text-xs text-slate-500">
                    {fmtDateTime(run.createdAt)}
                    {run.outcome === "QUEUED" && <ConfirmButton action={cancelReminderAction.bind(null, r.id, run.targetKey, run.clientId)} variant="ghost" className="px-2 text-xs" confirm="Stop future reminders for this item?">Stop reminders</ConfirmButton>}
                  </span>
                </li>
              ))}
              {r.runs.length === 0 && <li className="py-1.5 text-slate-600">No reminders yet.</li>}
            </ul>
          </details>
        </Card>
      ))}
      {isAdmin && (
        <ActionForm action={runAutomationsNowAction}>
          <Button type="submit" variant="secondary">Run automations now</Button>
        </ActionForm>
      )}
    </div>
  );
}
