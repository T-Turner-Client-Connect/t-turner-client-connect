import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { saveClassificationAction, saveStateTemplateAction } from "@/app/actions/nonprofit-portfolio";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { classifications, stateTemplate } from "@/lib/services/nonprofit-portfolio";
import { STATES } from "@/lib/resources/catalog";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Nonprofit settings" };

/** Admins: the federal classification list and each state's requirement template, with verification. */
export default async function NonprofitSettings({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await connection();
  const user = await requireUser();
  if (user.role !== "ADMIN") return <Notice tone="warn">Only Admins can edit nonprofit settings.</Notice>;
  const state = (await searchParams).state ?? "AL";
  const [cls, tpl, saved] = await Promise.all([classifications(true), stateTemplate(state), prisma.nonprofitStateTemplate.findMany({ select: { state: true, verifiedAt: true } })]);
  const lines = tpl.items.map((i) => [i.key, i.label, i.category, i.required ? "yes" : "no", i.note ?? "", i.sourceUrl ?? ""].join(" | ")).join("\n");

  return (
    <>
      <PageHeader title="Nonprofit settings" subtitle="Federal exemption categories and state formation requirements. Nothing shows as verified until it's checked against the official source." />
      <Card title="Federal tax-exempt classifications" className="mb-4">
        <div className="space-y-2" data-testid="classification-list">
          {cls.map((c) => (
            <details key={c.key} className="rounded-xl bg-ivory-50 p-3 text-sm">
              <summary className="cursor-pointer font-semibold">{c.label} {c.form && <span className="font-normal text-slate-600">· {c.form}</span>} {c.verifiedAt ? <Badge tone="green">Verified {fmtDate(c.verifiedAt)}</Badge> : <Badge tone="amber">Not verified</Badge>} {!c.active && <Badge tone="gray">Hidden</Badge>}</summary>
              <ActionForm action={saveClassificationAction.bind(null, c.key)} className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Name"><input className="input" name="label" defaultValue={c.label} /></Field>
                <Field label="IRS form(s)"><input className="input" name="form" defaultValue={c.form ?? ""} /></Field>
                <Field label="IRS process" className="sm:col-span-2"><textarea className="input" name="process" rows={2} defaultValue={c.process} /></Field>
                <Field label="Official source"><input className="input" name="sourceUrl" defaultValue={c.sourceUrl ?? ""} /></Field>
                <Field label="Verification note"><input className="input" name="verifiedNote" defaultValue={c.verifiedNote ?? ""} placeholder="Which IRS page, checked when" /></Field>
                <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={c.active} /> Offered</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="markVerified" defaultChecked={!!c.verifiedAt} /> Verified against the official source</label>
                <div><Button type="submit" variant="secondary">Save</Button></div>
              </ActionForm>
            </details>
          ))}
          <details className="rounded-xl border border-dashed border-ivory-300 p-3 text-sm">
            <summary className="cursor-pointer font-semibold">Add a classification</summary>
            <ActionForm action={saveClassificationAction.bind(null, "")} className="mt-2 grid gap-2 sm:grid-cols-2" resetOnSuccess>
              <Field label="Key (e.g. 501C9)"><input className="input" name="key" required /></Field>
              <Field label="Name"><input className="input" name="label" required /></Field>
              <Field label="IRS form(s)"><input className="input" name="form" /></Field>
              <Field label="Official source"><input className="input" name="sourceUrl" /></Field>
              <Field label="IRS process" className="sm:col-span-2"><textarea className="input" name="process" rows={2} required /></Field>
              <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked /> Offered</label>
              <div><Button type="submit" variant="secondary">Add</Button></div>
            </ActionForm>
          </details>
        </div>
      </Card>

      <Card title="State formation requirements">
        <form method="get" className="mb-3 flex items-end gap-2 text-sm">
          <Field label="State"><select className="input" name="state" defaultValue={state}>{STATES.map((s) => { const r = saved.find((x) => x.state === s.code); return <option key={s.code} value={s.code}>{s.name}{r ? (r.verifiedAt ? " — verified" : " — draft") : " — baseline"}</option>; })}</select></Field>
          <Button type="submit" variant="ghost">Open</Button>
        </form>
        <p className="mb-2 text-sm">{tpl.name}: {tpl.verifiedAt ? <Badge tone="green">Verified {fmtDate(tpl.verifiedAt)}</Badge> : <Badge tone="amber">{tpl.saved ? "Draft — not verified" : "General baseline — not specific to this state"}</Badge>}{tpl.verifiedNote ? ` · ${tpl.verifiedNote}` : ""}</p>
        <ActionForm action={saveStateTemplateAction.bind(null, state)} className="space-y-2 text-sm">
          <Field label="Requirements — one per line: key | description | category (STATE, FEDERAL, GOVERNANCE, GRANT, OTHER) | required (yes/no) | note | official source URL">
            <textarea className="input font-mono text-xs" name="items" rows={14} defaultValue={lines} />
          </Field>
          <Field label="Verification note"><input className="input" name="verifiedNote" defaultValue={tpl.verifiedNote ?? ""} placeholder="Which official pages you checked, and when" /></Field>
          <label className="flex items-center gap-2"><input type="checkbox" name="markVerified" defaultChecked={!!tpl.verifiedAt} /> Verified against official government sources</label>
          <Button type="submit" variant="secondary">Save template</Button>
        </ActionForm>
      </Card>
    </>
  );
}
