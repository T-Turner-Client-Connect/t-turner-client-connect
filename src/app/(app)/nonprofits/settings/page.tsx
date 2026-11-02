import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { saveClassificationAction, savePackageAction, saveStateTemplateAction } from "@/app/actions/nonprofit-portfolio";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { classifications, packages, stateTemplate, type PackageDeliverable } from "@/lib/services/nonprofit-portfolio";
import { STATES } from "@/lib/resources/catalog";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Nonprofit settings" };

/** Admins: the federal classification list and each state's requirement template, with verification. */
export default async function NonprofitSettings({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  await connection();
  const user = await requireUser();
  if (user.role !== "ADMIN") return <Notice tone="warn">Only Admins can edit nonprofit settings.</Notice>;
  const state = (await searchParams).state ?? "AL";
  const [cls, tpl, saved, pkgs] = await Promise.all([classifications(true), stateTemplate(state), prisma.nonprofitStateTemplate.findMany({ select: { state: true, verifiedAt: true } }), packages(true)]);
  const dollars = (c: number) => (c / 100).toFixed(2);
  const lines = tpl.items.map((i) => [i.key, i.label, i.category, i.required ? "yes" : "no", i.note ?? "", i.sourceUrl ?? ""].join(" | ")).join("\n");

  return (
    <>
      <PageHeader title="Nonprofit settings" subtitle="Federal exemption categories and state formation requirements. Nothing shows as verified until it's checked against the official source." />
      <Card title="Formation packages (owner)" className="mb-4">
        <p className="mb-2 text-sm text-slate-700">Your deliverables — the documents you provide — tracked separately from government requirements. A document stays in a package whether or not the law requires it. Only the owner can save changes.</p>
        <div className="space-y-2" data-testid="package-list">
          {[...pkgs, null].map((k) => (
            <details key={k?.key ?? "new"} className={`rounded-xl p-3 text-sm ${k ? "bg-ivory-50" : "border border-dashed border-ivory-300"}`}>
              <summary className="cursor-pointer font-semibold">{k ? <>{k.name} · {k.priceNote ? `${k.priceNote} ` : ""}${dollars(k.priceCents)} · fees {k.govFeesMode === "INCLUDED" ? "included" : "added"}{k.grantDisclaimer ? " · grant disclaimer" : ""} {!k.active && <Badge tone="gray">Hidden</Badge>}</> : "Add a package"}</summary>
              <ActionForm action={savePackageAction.bind(null, k?.key ?? "")} className="mt-2 grid gap-2 sm:grid-cols-2">
                {!k && <Field label="Key (e.g. TN_BASIC)"><input className="input" name="key" required /></Field>}
                <Field label="Name"><input className="input" name="name" defaultValue={k?.name ?? ""} required /></Field>
                <Field label="Price ($)"><input className="input" name="price" inputMode="decimal" defaultValue={k ? dollars(k.priceCents) : ""} required /></Field>
                <Field label="Price note" hint="e.g. Starting at"><input className="input" name="priceNote" defaultValue={k?.priceNote ?? ""} /></Field>
                <Field label="Government filing fees"><select className="input" name="govFeesMode" defaultValue={k?.govFeesMode ?? "ADDED"}><option value="ADDED">Added to the price</option><option value="INCLUDED">Included in the price</option></select></Field>
                <Field label="Prices by state (optional)" hint="One per line, e.g. GA=3750"><textarea className="input" name="statePrices" rows={2} defaultValue={Object.entries((k?.statePrices ?? {}) as Record<string, number>).map(([st, c]) => `${st}=${dollars(c)}`).join("\n")} /></Field>
                <Field label="Deliverables — one per line: key | description | section (FORMATION, IRS, STATE, SAM, GRANT, OTHER)" className="sm:col-span-2">
                  <textarea className="input font-mono text-xs" name="deliverables" rows={8} defaultValue={((k?.deliverables ?? []) as unknown as PackageDeliverable[]).map((d) => `${d.key} | ${d.label} | ${d.section}`).join("\n")} />
                </Field>
                <label className="flex items-center gap-2"><input type="checkbox" name="grantDisclaimer" defaultChecked={k?.grantDisclaimer ?? false} /> Agreement includes the grant assistance &amp; funding disclaimer</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={k?.active ?? true} /> Offered</label>
                <div><Button type="submit" variant="secondary">Save package</Button></div>
              </ActionForm>
            </details>
          ))}
        </div>
      </Card>

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
