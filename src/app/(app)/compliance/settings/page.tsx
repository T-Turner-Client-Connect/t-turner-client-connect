import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { ComplianceNav } from "@/components/compliance/bits";
import { requireCompliancePage } from "@/lib/compliance/page-gate";
import { complianceSettings, SWITCH_LABELS, type SwitchKey } from "@/lib/services/compliance/settings";
import { PORTAL_KINDS, ACCESS_METHODS } from "@/lib/services/compliance/entities";
import { prisma } from "@/lib/prisma";
import * as A from "@/app/actions/compliance";

export const metadata = { title: "Compliance switches" };

export default async function ComplianceSettingsPage() {
  const { access } = await requireCompliancePage({ owner: true });
  const s = await complianceSettings();
  const firm = await prisma.complianceFilingAccount.findMany({ where: { firmLevel: true } });
  return (
    <>
      <PageHeader title="Tax & Compliance — switches & reminders" subtitle="Owner only. Every change is audited. Both switches start OFF." />
      <ComplianceNav current="/compliance/settings" isOwner={access.isOwner} />
      <div className="grid gap-5 lg:grid-cols-2">
        {(Object.keys(SWITCH_LABELS) as SwitchKey[]).map((k) => (
          <Card key={k} title={<span className="flex items-center gap-2">{SWITCH_LABELS[k].label} <Badge tone={s[k] ? "green" : "red"}>{s[k] ? "ON" : "OFF"}</Badge></span>}>
            <p className="mb-3 text-sm text-slate-700">{s[k] ? (k === "clientNotificationsAuthorized" ? "Client notices go out for entities that also have their own switch on: email and texts follow each login's preferences and the existing consent rules; the portal shows pending approvals." : "Staff reminders are also emailed (link only, no amounts).") : SWITCH_LABELS[k].off}</p>
            <ActionForm action={A.switchAction.bind(null, k, !s[k])} confirm={s[k] ? undefined : `Turn ON “${SWITCH_LABELS[k].label}”?`}><Button variant={s[k] ? "danger" : "primary"} data-testid={`switch-${k}`}>{s[k] ? "Turn OFF" : "Turn ON"}</Button></ActionForm>
          </Card>
        ))}
        <Card title="Reminder rules">
          <ActionForm action={A.reminderSettingsAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Staff reminder days before due"><input name="reminderDays" defaultValue={s.reminderDays.join(", ")} className="input" /></Field>
            <Field label="Prep task created (days before due)"><input name="prepTaskDays" type="number" defaultValue={s.prepTaskDays} className="input" /></Field>
            <Field label="Default internal prep deadline (days before)"><input name="defaultPrepLeadDays" type="number" defaultValue={s.defaultPrepLeadDays} className="input" /></Field>
            <Field label="Escalate pending approval within (days of due)"><input name="approvalEscalationDays" type="number" defaultValue={s.approvalEscalationDays} className="input" /></Field>
            <Field label="Client approval reminder every (days)"><input name="approvalReminderEveryDays" type="number" defaultValue={s.approvalReminderEveryDays} className="input" /></Field>
            <div className="self-end"><Button>Save</Button></div>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-600">Overdue items escalate daily to the assigned staff member and Tabitha until resolved.</p>
        </Card>
        <Card title="Firm-level accounts (reused for every client)">
          <ul className="mb-3 text-sm">{firm.map((f) => <li key={f.id}><strong>{f.name}</strong> · {f.accessMethod ?? "—"} · ref {f.accessReference ?? "—"}</li>)}{!firm.length && <li className="text-slate-600">None yet (e.g. the firm&apos;s MAT third-party agent account).</li>}</ul>
          <ActionForm action={A.saveFirmAccountAction} className="grid gap-2"><select name="portalKind" className="input" aria-label="Portal">{Object.entries(PORTAL_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select><input name="name" required placeholder="Name (Firm MAT agent account)" className="input" /><input name="portalUrl" placeholder="https:// (blank = standard)" className="input" /><select name="accessMethod" className="input" aria-label="Access method">{ACCESS_METHODS.map((m) => <option key={m}>{m}</option>)}</select><input name="accessReference" placeholder="Password-manager item name (never the password)" className="input" /><Button variant="secondary">Save firm account</Button></ActionForm>
        </Card>
      </div>
    </>
  );
}
