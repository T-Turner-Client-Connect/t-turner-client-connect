import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { ComplianceNav, fmtD, LABEL, NeedsVerification } from "@/components/compliance/bits";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { reviewOverdue, rulesLibrary } from "@/lib/services/compliance/rules";
import { CATEGORY_LABELS } from "@/lib/compliance/rules-data";
import { WEEKEND_RULES } from "@/lib/compliance/dates";
import * as A from "@/app/actions/compliance";

export const metadata = { title: "Compliance rules library" };

export default async function RulesPage() {
  const { actor, access } = await requireCompliancePage();
  const lib = await rulesLibrary(actor);
  return (
    <>
      <PageHeader title="Compliance rules library" subtitle={`${lib.counts.total} rules · ${lib.counts.verified} verified · ${lib.counts.needsVerification} need verification. A rule is verified only after its official source page was opened and read.`} />
      <ComplianceNav current="/compliance/rules" isOwner={access.isOwner} />
      <Card title={`Annual review queue (${lib.reviewQueue.length})`} className="mb-5">
        <p className="mb-2 text-sm text-slate-600">Rules older than 12 months or marked Needs verification. A yearly review task is created for Tabitha each January.</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2" data-testid="review-queue">{lib.reviewQueue.map((r) => <li key={r.id}><a href={`#rule-${r.ruleKey}`} className="underline">{r.formName}</a> <span className="text-xs text-slate-500">({r.jurisdictionName}) · last reviewed {r.lastReviewedAt ? fmtD(r.lastReviewedAt) : "never"}</span></li>)}</ul>
      </Card>
      <Card title="Rules">
        <ul className="divide-y divide-ivory-200" data-testid="rules-list">
          {lib.rules.map((r) => (
            <li key={r.id} id={`rule-${r.ruleKey}`} className="py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><p className="font-semibold">{r.formName} <span className="font-normal text-slate-600">— {r.obligationName}</span></p><p className="text-xs text-slate-600">{r.ruleKey} v{r.version} · {r.jurisdictionLevel}: {r.jurisdictionName} · {CATEGORY_LABELS[r.category] ?? r.category} · {LABEL[r.frequency] ?? r.frequency.replace("ACCOUNT:", "From the account (assumed ") + (r.frequency.startsWith("ACCOUNT:") ? ")" : "")} · {r.dueRuleDescription} · {WEEKEND_RULES[r.weekendRule as keyof typeof WEEKEND_RULES]}</p>{r.notes && <p className="text-xs text-amber-900">{r.notes}</p>}<p className="text-xs">Sources: {r.sourceUrls.map((u) => <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 underline">{u.replace(/^https:\/\//, "")}</a>)}</p></div>
                <span className="flex items-center gap-2">{r.verificationStatus === "VERIFIED" ? <Badge tone="green">Verified {r.lastReviewedAt && fmtD(r.lastReviewedAt)}</Badge> : <NeedsVerification />}{reviewOverdue(r) && <Badge tone="gold">Review due</Badge>}</span>
              </div>
              {access.isOwner && (
                <details className="mt-1"><summary className="cursor-pointer text-xs underline">Edit (creates version {r.version + 1})</summary>
                  <ActionForm action={A.editRuleAction.bind(null, r.ruleKey)} className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input name="dueRuleCode" defaultValue={r.dueRuleCode} className="input" aria-label="Due code" /><input name="dueRuleDescription" defaultValue={r.dueRuleDescription} className="input sm:col-span-2" aria-label="Due description" />
                    <select name="weekendRule" defaultValue={r.weekendRule} className="input" aria-label="Weekend rule">{Object.entries(WEEKEND_RULES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <input name="sourceUrl" required placeholder="Official source you checked (https://…)" className="input sm:col-span-2" />
                    <input name="reason" required placeholder="What changed and why" className="input sm:col-span-2" />
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="verified" /> I opened the official page and read its due date and applicability</label>
                    <Button variant="secondary">Save new version</Button>
                  </ActionForm>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Industry templates" className="mt-5">
        <ul className="text-sm">{lib.templates.map((t) => <li key={t.id} className="py-1"><strong>{t.name}</strong>{!t.builtIn && <Badge tone="gold" className="ml-1">Custom</Badge>} — tags: {t.activityTags.join(", ")} · rules: {t.ruleKeys.join(", ")}</li>)}</ul>
        {access.isOwner && <ActionForm action={A.addTemplateAction} resetOnSuccess className="mt-3 grid gap-2 sm:grid-cols-2"><input name="key" required placeholder="Key (e.g. food_truck)" className="input" /><input name="name" required placeholder="Name" className="input" /><input name="activityTags" placeholder="Activity tags (comma separated)" className="input" /><input name="ruleKeys" placeholder="Rule keys (comma separated)" className="input" /><input name="description" placeholder="Description" className="input sm:col-span-2" /><Button variant="secondary">Add template</Button></ActionForm>}
      </Card>
      {lib.history.length > 0 && <Card title="Change history" className="mt-5"><ul className="text-xs">{lib.history.map((h) => <li key={h.id}>{h.ruleKey} v{h.version} · {h.changeReason} · {fmtD(h.createdAt)}</li>)}</ul></Card>}
    </>
  );
}
