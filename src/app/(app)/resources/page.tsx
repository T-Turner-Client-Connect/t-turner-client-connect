import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { checkLinksAction, faqStepAction, resourceStepAction, saveFaqAction, saveResourceAction } from "@/app/actions/resources";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { CATEGORIES, EXPECTED_STATE_CATEGORIES, hostOf, isStateCode, STATES, stateName } from "@/lib/resources/catalog";
import { coverage } from "@/lib/services/resources";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Resource Center" };

const STATUS_TONE = { VERIFIED: "green", NEEDS_VERIFICATION: "amber", NOT_APPLICABLE: "gray", UNAVAILABLE: "red" } as const;

function ResourceFields({ r, jurisdiction }: { r?: { jurisdiction: string; county: string | null; city: string | null; category: string; title: string; purpose: string; agency: string; url: string | null; phone: string | null; status: string; notes: string | null }; jurisdiction: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="State / Federal">
        <select className="input" name="jurisdiction" defaultValue={r?.jurisdiction ?? jurisdiction}>
          <option value="US">Federal</option>
          {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </Field>
      <Field label="Category">
        <select className="input" name="category" defaultValue={r?.category ?? "TAX_PORTAL"}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
      </Field>
      <Field label="Title"><input className="input" name="title" defaultValue={r?.title} required /></Field>
      <Field label="Agency"><input className="input" name="agency" defaultValue={r?.agency} required /></Field>
      <Field label="What this link handles" className="sm:col-span-2"><input className="input" name="purpose" defaultValue={r?.purpose} required /></Field>
      <Field label="Official https:// link"><input className="input" name="url" defaultValue={r?.url ?? ""} /></Field>
      <Field label="Phone (exactly as the agency publishes it)"><input className="input" name="phone" defaultValue={r?.phone ?? ""} /></Field>
      <Field label="County (local only)"><input className="input" name="county" defaultValue={r?.county ?? ""} /></Field>
      <Field label="City (local only)"><input className="input" name="city" defaultValue={r?.city ?? ""} /></Field>
      <Field label="Status">
        <select className="input" name="status" defaultValue={r?.status ?? "NEEDS_VERIFICATION"}>
          <option value="VERIFIED">Verified (I checked it on the official site)</option>
          <option value="NEEDS_VERIFICATION">Needs verification</option>
          <option value="NOT_APPLICABLE">Doesn&apos;t apply in this state</option>
          <option value="UNAVAILABLE">Currently unavailable</option>
        </select>
      </Field>
      <Field label="Notes (required for “doesn't apply”)"><input className="input" name="notes" defaultValue={r?.notes ?? ""} /></Field>
    </div>
  );
}

export default async function StaffResourcesPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const sp = await searchParams;
  const jurisdiction = sp.state === "US" || isStateCode(sp.state) ? sp.state! : "AL";
  const [all, rows, faqs] = await Promise.all([
    prisma.resource.findMany({ select: { jurisdiction: true, category: true, status: true, hidden: true, linkCheckOk: true } }),
    prisma.resource.findMany({ where: { jurisdiction }, orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { title: "asc" }] }),
    prisma.resourceFaq.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
  ]);
  const summary = STATES.map((s) => ({ ...s, ...coverage(s.code, all) }));
  const complete = summary.filter((s) => s.complete).length;
  const broken = all.filter((r) => r.linkCheckOk === false).length;
  return (
    <>
      <PageHeader title="Resource Center" subtitle="Official links clients see in their portal. Only Admins can edit." />
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="Coverage">
          <p className="text-sm">{complete} of {STATES.length} jurisdictions have every expected resource listed and confirmed.</p>
          <p className="mt-1 text-sm">{all.filter((r) => r.status === "VERIFIED").length} verified links · {all.filter((r) => r.status === "NEEDS_VERIFICATION").length} need verification · {broken} failed the last link check.</p>
          {isAdmin && (
            <ActionForm action={checkLinksAction} className="mt-3">
              <Button type="submit" variant="secondary">Check links now</Button>
              <p className="mt-1 text-xs text-slate-600">Runs from the live site (up to 60 links per click; also weekly automatically). A failed check flags the link — it isn&apos;t deleted.</p>
            </ActionForm>
          )}
        </Card>
        <Card title="Jurisdictions" className="lg:col-span-2">
          <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto" data-testid="coverage-grid">
            <a href="/resources?state=US" className={`rounded-md px-2 py-1 text-xs font-semibold ${jurisdiction === "US" ? "bg-navy-900 text-white" : "bg-navy-50"}`}>Federal</a>
            {summary.map((s) => (
              <a key={s.code} href={`/resources?state=${s.code}`} title={s.complete ? "Complete" : `Missing ${s.missing.length}, unconfirmed ${s.unconfirmed.length}`} className={`rounded-md px-2 py-1 text-xs font-semibold ${jurisdiction === s.code ? "bg-navy-900 text-white" : s.complete ? "bg-emerald-50 text-emerald-900" : s.missing.length === EXPECTED_STATE_CATEGORIES.length ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-900"}`}>
                {s.code}
              </a>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-600">Green = complete · amber = partly listed or unconfirmed · red = nothing listed yet.</p>
        </Card>
      </div>

      <Card title={`${jurisdiction === "US" ? "Federal" : stateName(jurisdiction)} — ${rows.length} resources`}>
        {jurisdiction !== "US" && (() => {
          const c = coverage(jurisdiction, rows);
          return !c.complete ? <div className="mb-3"><Notice tone="warn">Not listed yet: {c.missing.map((m) => CATEGORIES[m].label).join(", ") || "none"}. Unconfirmed: {c.unconfirmed.map((m) => CATEGORIES[m].label).join(", ") || "none"}.</Notice></div> : null;
        })()}
        <ul className="divide-y divide-navy-100">
          {rows.map((r) => (
            <li key={r.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.title} <span className="font-normal text-slate-600">· {CATEGORIES[r.category]?.label} · {r.agency}{r.county ? ` · ${r.county}` : ""}{r.city ? ` · ${r.city}` : ""}</span></p>
                  <p className="text-slate-700">{r.purpose}</p>
                  {r.url && <a className="break-all text-xs underline" href={r.url} target="_blank" rel="noopener noreferrer">{hostOf(r.url)}{new URL(r.url).pathname} ↗</a>}
                  {r.notes && <p className="text-xs text-slate-600">Note: {r.notes}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "gray"}>{r.status.replace("_", " ").toLowerCase()}</Badge>
                  {r.hidden && <Badge tone="gray">Hidden</Badge>}
                  {r.linkCheckOk === false && <Badge tone="red">Link check failed ({r.linkCheckStatus || "no response"})</Badge>}
                  {r.linkCheckOk && <Badge tone="green">Reachable {fmtDateTime(r.linkCheckedAt)}</Badge>}
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {r.lastVerifiedAt ? `Verified ${fmtDateTime(r.lastVerifiedAt)}` : "Not yet verified"}{r.verificationMethod ? ` (${r.verificationMethod === "official-result" ? "found on the agency's official site" : r.verificationMethod === "in-text" ? "named on the agency's official site" : r.verificationMethod})` : ""}
              </p>
              {isAdmin && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <ActionForm action={resourceStepAction.bind(null, r.id, "up")}><Button variant="ghost" aria-label="Move up">↑</Button></ActionForm>
                  <ActionForm action={resourceStepAction.bind(null, r.id, "down")}><Button variant="ghost" aria-label="Move down">↓</Button></ActionForm>
                  <ActionForm action={resourceStepAction.bind(null, r.id, r.hidden ? "show" : "hide")}><Button variant="ghost">{r.hidden ? "Show" : "Hide"}</Button></ActionForm>
                  <details className="w-full">
                    <summary className="cursor-pointer text-xs underline">Edit</summary>
                    <ActionForm action={saveResourceAction.bind(null, r.id)} className="mt-2 space-y-2">
                      <ResourceFields r={r} jurisdiction={jurisdiction} />
                      <Button type="submit">Save</Button>
                    </ActionForm>
                  </details>
                </div>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <details className="mt-4 rounded-lg bg-navy-50 p-3">
            <summary className="cursor-pointer font-semibold">Add a resource</summary>
            <ActionForm action={saveResourceAction.bind(null, null)} className="mt-2 space-y-2" resetOnSuccess>
              <ResourceFields jurisdiction={jurisdiction} />
              <Button type="submit">Add</Button>
            </ActionForm>
          </details>
        )}
      </Card>

      <Card title="Common Questions" className="mt-4">
        <ul className="divide-y divide-navy-100">
          {faqs.map((f) => (
            <li key={f.id} className="py-2 text-sm">
              <p className="font-semibold">{f.question} {f.hidden && <Badge tone="gray">Hidden</Badge>}</p>
              <p className="whitespace-pre-line text-slate-700">{f.answer}</p>
              {isAdmin && (
                <div className="mt-1 flex flex-wrap gap-1">
                  <ActionForm action={faqStepAction.bind(null, f.id, !f.hidden)}><Button variant="ghost">{f.hidden ? "Show" : "Hide"}</Button></ActionForm>
                  <details>
                    <summary className="cursor-pointer text-xs underline">Edit</summary>
                    <ActionForm action={saveFaqAction.bind(null, f.id)} className="mt-2 space-y-2">
                      <Field label="Question"><input className="input" name="question" defaultValue={f.question} /></Field>
                      <Field label="Answer"><textarea className="input" name="answer" rows={4} defaultValue={f.answer} /></Field>
                      <Field label="Search words (comma separated)"><input className="input" name="tags" defaultValue={f.tags.join(", ")} /></Field>
                      <Button type="submit">Save</Button>
                    </ActionForm>
                  </details>
                </div>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <ActionForm action={saveFaqAction.bind(null, null)} className="mt-3 space-y-2 rounded-lg bg-navy-50 p-3" resetOnSuccess>
            <p className="font-semibold">Add a question</p>
            <Field label="Question"><input className="input" name="question" required /></Field>
            <Field label="Answer"><textarea className="input" name="answer" rows={3} required /></Field>
            <Field label="Search words (comma separated)"><input className="input" name="tags" /></Field>
            <Button type="submit">Add question</Button>
          </ActionForm>
        )}
      </Card>
    </>
  );
}
