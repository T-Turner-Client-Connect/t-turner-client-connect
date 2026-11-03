import Link from "next/link";
import { notFound } from "next/navigation";
import type { ImportMatch } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { DecisionSelect } from "@/components/decision-select";
import { Badge, Button, buttonClass, Card, Notice, PageHeader } from "@/components/ui";
import { commitImportAction, discardImportAction, setRowApprovalsAction } from "@/app/actions/imports";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import type { CleanRow } from "@/lib/import/rows";
import { formatPhone } from "@/lib/normalize";
import { fmtDateTime } from "@/lib/format";
import { compareFields, FIELD_LABELS, plannedChanges } from "@/lib/import/plan";
import { classification } from "@/lib/import/rows";
import type { ImportSummary } from "@/lib/services/imports";
import { joinName, returnTypeLabel } from "@/lib/tax/return-types";

export const metadata = { title: "Review import" };

const MATCH_LABEL: Record<ImportMatch, { text: string; tone: "green" | "navy" | "gold" | "red" }> = {
  NEW: { text: "New client", tone: "green" },
  MATCH: { text: "Matches existing", tone: "navy" },
  AMBIGUOUS: { text: "Needs review", tone: "gold" },
  ERROR: { text: "Error", tone: "red" },
};
const PAGE = 100;

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string; page?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const batch = await prisma.importBatch.findUnique({ where: { id }, include: { importedBy: { select: { name: true } } } });
  if (!batch) notFound();
  const show = (["NEW", "MATCH", "AMBIGUOUS", "ERROR"] as const).find((m) => m === sp.show);
  const page = Math.max(1, Number(sp.page) || 1);
  const [counts, rows, undecided] = await Promise.all([
    prisma.importRow.groupBy({ by: ["match"], where: { batchId: id }, _count: true }),
    prisma.importRow.findMany({ where: { batchId: id, ...(show ? { match: show } : {}) }, orderBy: { rowNumber: "asc" }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.importRow.count({ where: { batchId: id, decision: null } }),
  ]);
  const countOf = (m: ImportMatch) => counts.find((c) => c.match === m)?._count ?? 0;
  const total = counts.reduce((n, c) => n + c._count, 0);
  const candidateIds = Array.from(new Set(rows.flatMap((r) => [...r.candidateIds, ...(r.resultClientId ? [r.resultClientId] : [])])));
  const candidates = new Map(
    (await prisma.client.findMany({ where: { id: { in: candidateIds } } })).map((c) => [c.id, c]),
  );
  const summary = batch.summary as unknown as ImportSummary | null;
  const staffNames = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const res = summary?.result;
  const attentionIds = res ? Array.from(new Set([...res.needsReturnType, ...res.needsConfirmation, ...res.namesRepaired])) : [];
  const attentionNames = new Map((await prisma.client.findMany({ where: { id: { in: attentionIds } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
  const missing = summary ? Object.entries(summary.missing).filter(([, n]) => n > 0) : [];
  const open = batch.status === "REVIEW";
  const filtered = show ? countOf(show) : total;

  return (
    <>
      <PageHeader
        title={open ? "Review import" : "Import results"}
        subtitle={`${batch.fileName} · ${batch.source} · ${batch.importedBy.name} · ${fmtDateTime(batch.createdAt)}`}
      />
      {batch.status === "COMMITTED" && (
        <div className="mb-4">
          <Notice tone="success" title="Import complete">
            {batch.createdCount} created, {batch.updatedCount} updated, {batch.skippedCount} skipped on {fmtDateTime(batch.committedAt)}. Imported contacts have no messaging
            permissions until you record them. No messages were sent. The staged contact data has been cleared.
          </Notice>
        </div>
      )}
      {summary && (
        <div className="mb-4">
          <Card title={batch.status === "COMMITTED" ? "Import completion summary" : "What this file contains"}>
            <div className="grid gap-4 text-sm md:grid-cols-3" data-testid="import-summary">
              <div>
                <p className="font-semibold text-navy-900">{batch.status === "COMMITTED" ? "Imported" : "Will be imported"}</p>
                <ul className="mt-1 space-y-0.5 text-slate-700">
                  {res && <li>{res.created} created · {res.updated} updated · {res.unchanged} already complete · {res.skipped} skipped</li>}
                  {summary.mappedColumns.map((m) => <li key={m.header}>{m.header} → {m.field}</li>)}
                  {batch.batchServices.length > 0 && <li>Service for every client: <strong>{batch.batchServices.join(", ")}</strong></li>}
                  {batch.taxYear && <li>Tax year: <strong>{batch.taxYear}</strong></li>}
                  {res && (res.casesCreated > 0 || res.casesFilled > 0) && <li>{res.casesCreated} tax-preparation case(s) opened, {res.casesFilled} filled in · {res.returnTypesPrefilled} return type(s) prefilled from the file</li>}
                </ul>
              </div>
              <div>
                <p className="font-semibold text-navy-900">Missing from the source file</p>
                <ul className="mt-1 space-y-0.5 text-slate-700">
                  {missing.length === 0 && <li>Nothing — every row had these fields.</li>}
                  {missing.map(([k, n]) => <li key={k}>{k}: missing on {n} of {summary.rows} row(s)</li>)}
                  {summary.unmappedColumns.length > 0 && <li>Columns not imported: {summary.unmappedColumns.join(", ")}</li>}
                  {summary.blockedColumns.length > 0 && <li>Blocked as sensitive (never imported): {summary.blockedColumns.join(", ")}</li>}
                </ul>
              </div>
              <div>
                <p className="font-semibold text-navy-900">Needs attention</p>
                <ul className="mt-1 space-y-0.5 text-slate-700">
                  {summary.attention.joint.length > 0 && <li>Joint taxpayers (kept on one record): row {summary.attention.joint.join(", ")}</li>}
                  {summary.attention.returnTypeUnrecognized.length > 0 && <li className="text-amber-800">Return type incomplete or not recognized (staff will select): row {summary.attention.returnTypeUnrecognized.join(", ")}</li>}
                  {summary.attention.phoneInvalid.length > 0 && <li className="text-amber-800">Phone couldn’t be read: row {summary.attention.phoneInvalid.join(", ")}</li>}
                  {summary.attention.emailInvalid.length > 0 && <li className="text-amber-800">Email not valid: row {summary.attention.emailInvalid.join(", ")}</li>}
                  {summary.attention.noContact.length > 0 && <li className="text-amber-800">No email or phone: row {summary.attention.noContact.join(", ")}</li>}
                  {res?.needsReturnType.map((cid) => <li key={`rt${cid}`} className="text-red-800">Select Tax Return Type: <Link className="underline" href={`/clients/${cid}?tab=taxes`}>{attentionNames.get(cid) ?? "client"}</Link></li>)}
                  {res?.needsConfirmation.map((cid) => <li key={`cf${cid}`} className="text-amber-800">Confirm prefilled return type: <Link className="underline" href={`/clients/${cid}?tab=taxes`}>{attentionNames.get(cid) ?? "client"}</Link></li>)}
                  {res?.namesRepaired.map((cid) => <li key={`nr${cid}`}>Joint name split into taxpayer + spouse: <Link className="underline" href={`/clients/${cid}?tab=taxes`}>{attentionNames.get(cid) ?? "client"}</Link></li>)}
                  {!res && summary.attention.returnTypeNeeded.length > 0 && <li>Return type not in the file for row {summary.attention.returnTypeNeeded.join(", ")} — staff will select it after import</li>}
                </ul>
              </div>
            </div>
          </Card>
        </div>
      )}
      {batch.status === "DISCARDED" && <div className="mb-4"><Notice tone="info">This import was discarded. Nothing was changed.</Notice></div>}

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/imports/${id}`} className={buttonClass(!show ? "primary" : "secondary")}>All ({total})</Link>
        {(["AMBIGUOUS", "ERROR", "NEW", "MATCH"] as const).map((m) => (
          <Link key={m} href={`/imports/${id}?show=${m}`} className={buttonClass(show === m ? "primary" : "secondary")}>
            {MATCH_LABEL[m].text} ({countOf(m)})
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {rows.map((r) => {
            const d = r.data as CleanRow | null;
            const opts = [
              ...(r.match === "ERROR" ? [] : [{ value: "create", label: "Create a new client" }]),
              ...r.candidateIds.map((cid) => ({ value: `update:${cid}`, label: `Update ${candidates.get(cid)?.displayName ?? "existing client"}` })),
              { value: "skip", label: "Skip this row" },
            ];
            const result = r.resultClientId ? candidates.get(r.resultClientId) : null;
            return (
              <div key={r.id} className="rounded-xl border border-navy-100 bg-white p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-slate-500">Row {r.rowNumber}</p>
                    {d ? (
                      <>
                        <p className="font-semibold text-navy-900">{d.displayName}{d.businessName && d.businessName !== d.displayName ? ` · ${d.businessName}` : ""}</p>
                        <p className="text-sm text-slate-700">{[d.email, d.phoneNormalized && formatPhone(d.phoneNormalized), [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No contact details"}</p>
                      </>
                    ) : result ? (
                      <Link href={`/clients/${result.id}`} className="font-semibold underline">{result.displayName}</Link>
                    ) : (
                      <p className="text-sm text-slate-600">{r.decision === "skip" ? "Skipped" : "—"}</p>
                    )}
                  </div>
                  <Badge tone={MATCH_LABEL[r.match].tone}>{MATCH_LABEL[r.match].text}</Badge>
                </div>
                {d && (d.spouse || d.returnType || d.returnTypeText) && (
                  <p className="mt-1 text-sm text-slate-700" data-testid="row-tax">
                    {d.spouse ? <>Taxpayer: <strong>{joinName(d.primary ?? null)}</strong> · Spouse: <strong>{joinName(d.spouse)}</strong> · </> : null}
                    Return type: <strong>{d.returnType ? returnTypeLabel(d.returnType, d.otherReturnForm) : "to be selected by staff"}</strong>
                  </p>
                )}
                {d && <p className="mt-1 text-xs"><Badge tone="navy">{classification(d)}</Badge></p>}
                {d && r.decision?.startsWith("update:") && candidates.get(r.decision.slice(7)) && (() => {
                  const cur = candidates.get(r.decision!.slice(7))!;
                  const rows = compareFields(cur, d, { approved: r.approvedFields, assignedToId: batch.batchAssignedToId, labelFor: (f, v) => (f === "assignedToId" ? staffNames.get(v ?? "") ?? v : v) });
                  const plan = plannedChanges(cur, d, "fill_blanks", batch.batchServices, { approved: r.approvedFields, assignedToId: batch.batchAssignedToId });
                  const differs = rows.filter((x) => x.outcome === "differs" || x.outcome === "approved");
                  const OUT = { same: ["Same", "green"], fill: ["Will fill blank", "navy"], differs: ["Different — kept", "amber"], approved: ["Approved to replace", "gold"], not_in_file: ["Not in file", "gray"] } as const;
                  return (
                    <div className="mt-2 rounded-md border border-navy-100 bg-ivory-50 p-2 text-sm" data-testid="row-compare">
                      <p className="font-semibold text-navy-900">TaxAct vs Client Connect — {cur.displayName}</p>
                      <div className="mt-1 overflow-x-auto">
                        <table className="w-full min-w-[520px] text-xs">
                          <thead><tr className="text-left text-slate-600"><th className="py-1 pr-2">Field</th><th className="py-1 pr-2">TaxAct file</th><th className="py-1 pr-2">Client Connect now</th><th className="py-1">Result</th></tr></thead>
                          <tbody className="divide-y divide-navy-100">
                            {rows.filter((x) => x.outcome !== "not_in_file" || x.connect).map((x) => (
                              <tr key={x.field}>
                                <td className="py-1 pr-2 font-medium">{x.label}</td>
                                <td className="py-1 pr-2">{x.taxact ?? "—"}</td>
                                <td className="py-1 pr-2">{x.connect ?? "—"}</td>
                                <td className="py-1"><Badge tone={OUT[x.outcome][1]}>{OUT[x.outcome][0]}</Badge></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {plan.some((c) => c.kind === "repair") && <p className="mt-1"><Badge tone="gold">joint-name repair</Badge> The name holds two people; it will be split into taxpayer and spouse.</p>}
                      {plan.filter((c) => c.kind === "add").map((c) => <p key={c.field} className="mt-1">{FIELD_LABELS[c.field] ?? c.field}: add <strong>{c.to}</strong></p>)}
                      {open && differs.length > 0 && (
                        <ActionForm action={setRowApprovalsAction.bind(null, r.id)} className="mt-2 rounded border border-gold-300 bg-white p-2">
                          <p className="font-semibold text-navy-900">Approve corrections (optional)</p>
                          <p className="text-xs text-slate-600">Client Connect keeps its value unless you tick the field.</p>
                          {differs.map((x) => (
                            <label key={x.field} className="mt-1 flex items-start gap-2">
                              <input type="checkbox" name="field" value={x.field} defaultChecked={x.outcome === "approved"} className="mt-0.5 accent-navy-900" />
                              <span>Replace <strong>{x.label}</strong> “{x.connect}” with “{x.taxact}”</span>
                            </label>
                          ))}
                          <Button type="submit" variant="secondary" className="mt-2">Save approvals</Button>
                        </ActionForm>
                      )}
                    </div>
                  );
                })()}
                {(r.errors.length > 0 || r.warnings.length > 0) && (
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {r.errors.map((e) => <li key={e} className="text-red-800">✕ {e}</li>)}
                    {r.warnings.map((w) => <li key={w} className="text-amber-800">! {w}</li>)}
                  </ul>
                )}
                {r.candidateIds.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {r.candidateIds.map((cid) => {
                      const c = candidates.get(cid);
                      return c ? (
                        <li key={cid} className="rounded-md bg-navy-50 px-2 py-1">
                          Existing: <Link className="font-medium underline" href={`/clients/${cid}`} target="_blank">{c.displayName}</Link>
                          <span className="text-slate-600"> · {[c.email, c.phoneNormalized && formatPhone(c.phoneNormalized)].filter(Boolean).join(" · ")}</span>
                          {c.archivedAt && <Badge tone="gray" className="ml-1">Archived</Badge>}
                        </li>
                      ) : null;
                    })}
                  </ul>
                )}
                {open && (
                  <div className="mt-3 max-w-xs">
                    <DecisionSelect rowId={r.id} value={r.decision} options={opts} />
                  </div>
                )}
              </div>
            );
          })}
          {filtered > PAGE && (
            <nav className="flex justify-between pt-2 text-sm" aria-label="Pages">
              {page > 1 ? <Link className={buttonClass("secondary")} href={`/imports/${id}?${show ? `show=${show}&` : ""}page=${page - 1}`}>Previous</Link> : <span />}
              <span>Page {page} of {Math.ceil(filtered / PAGE)}</span>
              {page * PAGE < filtered ? <Link className={buttonClass("secondary")} href={`/imports/${id}?${show ? `show=${show}&` : ""}page=${page + 1}`}>Next</Link> : <span />}
            </nav>
          )}
        </div>

        {open && (
          <div className="space-y-4">
            <Card title="Confirm import">
              <ul className="mb-3 space-y-1 text-sm">
                <li>{countOf("NEW")} new · {countOf("MATCH")} matched · {countOf("AMBIGUOUS")} need review · {countOf("ERROR")} errors</li>
                {undecided > 0 && <li className="font-semibold text-amber-800">{undecided} row(s) still need a decision.</li>}
              </ul>
              <ActionForm action={commitImportAction.bind(null, id)} className="space-y-3" showSuccess={false}>
                <fieldset className="space-y-2 text-sm">
                  <legend className="mb-1 font-semibold text-navy-900">When updating existing clients</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" value="fill_blanks" defaultChecked className="mt-1 accent-navy-900" /> Fill in blank fields, and replace only the fields you approved in the comparison</label>
                </fieldset>
                <p className="text-xs text-slate-600">Tags, services and groups are added, never removed. Opt-outs and permission history are never changed by an import. The preview on each matched row shows exactly what “Only fill in blank fields” will change.</p>
                <Button type="submit" disabled={undecided > 0} className="w-full">Import {total - countOf("ERROR")} rows</Button>
              </ActionForm>
            </Card>
            <ActionForm action={discardImportAction.bind(null, id)} confirm="Discard this import? Nothing will be changed." showSuccess={false}>
              <Button variant="danger" className="w-full">Discard import</Button>
            </ActionForm>
          </div>
        )}
      </div>
    </>
  );
}
