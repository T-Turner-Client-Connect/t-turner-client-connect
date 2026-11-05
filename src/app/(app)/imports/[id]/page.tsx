import Link from "next/link";
import { notFound } from "next/navigation";
import type { ImportMatch } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { DecisionSelect } from "@/components/decision-select";
import { ImportRowEditor, type EditorField } from "@/components/import-row-editor";
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
import { joinName, RETURN_TYPES, returnTypeLabel } from "@/lib/tax/return-types";
import { ADDRESS_FIELDS, applyEdits, CONTACT_FIELDS, EDIT_LABELS, EDITOR_FIELDS, MAILING_FIELDS, type RowEdits } from "@/lib/import/edits";
import { batchWantsCase } from "@/lib/services/imports";

export const metadata = { title: "Review import" };

const MATCH_LABEL: Record<ImportMatch, { text: string; tone: "green" | "navy" | "gold" | "red" }> = {
  NEW: { text: "New client", tone: "green" },
  MATCH: { text: "Matches existing", tone: "navy" },
  AMBIGUOUS: { text: "Needs review", tone: "gold" },
  ERROR: { text: "Error", tone: "red" },
};
const PAGE = 100;

const EDITOR = new Set<string>(EDITOR_FIELDS);
const RT_OPTIONS = Object.entries(RETURN_TYPES).filter(([k]) => k !== "OTHER") as [string, string][];
const FIELD_LAYOUT: Record<string, Pick<EditorField, "span" | "optional" | "inputMode" | "maxLength">> = {
  addressLine1: { span: 6 },
  addressLine2: { span: 6, optional: true },
  city: { span: 3 },
  state: { span: 1, maxLength: 2 },
  postalCode: { span: 2, inputMode: "numeric", maxLength: 10 },
  mailingAddressLine1: { span: 6 },
  mailingAddressLine2: { span: 6, optional: true },
  mailingCity: { span: 3 },
  mailingState: { span: 1, maxLength: 2 },
  mailingPostalCode: { span: 2, inputMode: "numeric", maxLength: 10 },
  phone: { span: 3, inputMode: "tel" },
  email: { span: 3, inputMode: "email" },
};

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string; page?: string; missing?: string; open?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const batch = await prisma.importBatch.findUnique({ where: { id }, include: { importedBy: { select: { name: true } } } });
  if (!batch) notFound();
  const show = (["NEW", "MATCH", "AMBIGUOUS", "ERROR"] as const).find((m) => m === sp.show);
  const page = Math.max(1, Number(sp.page) || 1);
  const onlyMissing = sp.missing === "1";
  // Rows that will be imported (not skipped) and still lack something.
  const notSkipped = { OR: [{ decision: null }, { decision: { not: "skip" } }] };
  const lacking = (what?: string) => ({ batchId: id, ...notSkipped, ...(what ? { missingInfo: { has: what } } : { missingInfo: { isEmpty: false } }) });
  const rowWhere = { batchId: id, ...(show ? { match: show } : {}), ...(onlyMissing ? { AND: [lacking()] } : {}) };
  const [counts, rows, undecided, missingCount, noAddress, noFiling, filteredCount] = await Promise.all([
    prisma.importRow.groupBy({ by: ["match"], where: { batchId: id }, _count: true }),
    prisma.importRow.findMany({ where: rowWhere, orderBy: { rowNumber: "asc" }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.importRow.count({ where: { batchId: id, decision: null } }),
    prisma.importRow.count({ where: lacking() }),
    prisma.importRow.count({ where: lacking("Address") }),
    prisma.importRow.count({ where: lacking("Filing status") }),
    prisma.importRow.count({ where: rowWhere }),
  ]);
  const wantsCase = batchWantsCase(batch);
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
  const filtered = filteredCount;
  const targetIds = Array.from(new Set(rows.map((r) => (r.decision?.startsWith("update:") ? r.decision.slice(7) : null)).filter((v): v is string => !!v)));
  const existingCases = wantsCase && targetIds.length ? await prisma.taxPrepCase.findMany({ where: { clientId: { in: targetIds }, returnType: { not: null } }, select: { clientId: true, taxYear: true, returnType: true, otherReturnForm: true } }) : [];
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ show, missing: onlyMissing ? "1" : undefined, ...patch }).filter(([, v]) => v) as [string, string][]).toString();
    return `/imports/${id}${q ? `?${q}` : ""}`;
  };

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
            permissions until you record them. No messages were sent. The staged contact data has been cleared.{" "}
            <Link className="underline" href={`/clients/invitations?import=${batch.id}`}>Prepare portal invitations for these clients</Link> (nothing is sent until Tabitha approves).
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
                  {res && <li>{res.created} created · {res.updated} updated · {res.unchanged} already complete · {res.skipped} skipped{res.duplicatesPrevented ? ` · ${res.duplicatesPrevented} duplicate(s) prevented` : ""}</li>}
                  {summary.mappedColumns.map((m) => <li key={m.header}>{m.header} → {m.field}</li>)}
                  {batch.batchServices.length > 0 && <li>Service for every client: <strong>{batch.batchServices.join(", ")}</strong></li>}
                  {batch.taxYear && <li>Tax year: <strong>{batch.taxYear}</strong></li>}
                  {res && (res.casesCreated > 0 || res.casesFilled > 0) && <li>{res.casesCreated} tax-preparation case(s) opened, {res.casesFilled} filled in · {res.returnTypesPrefilled} return type(s) prefilled from the file</li>}
                  {res && !!res.completedInPreview && <li>{res.completedInPreview} row(s) completed by staff in the preview</li>}
                  {res && !!res.addressNeeded && <li className="text-amber-800">{res.addressNeeded} imported with an incomplete address — <Link className="underline" href="/clients?tag=Address+Needed">Address Needed</Link></li>}
                  {res && !!res.filingStatusNeeded && <li className="text-amber-800">{res.filingStatusNeeded} imported without a filing status — <Link className="underline" href="/clients?tag=Filing+Status+Needed">Filing Status Needed</Link></li>}
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={href({ show: undefined, page: undefined })} className={buttonClass(!show ? "primary" : "secondary")}>All ({total})</Link>
        {(["AMBIGUOUS", "ERROR", "NEW", "MATCH"] as const).map((m) => (
          <Link key={m} href={href({ show: m, page: undefined })} className={buttonClass(show === m ? "primary" : "secondary")}>
            {MATCH_LABEL[m].text} ({countOf(m)})
          </Link>
        ))}
        {open && (
          <Link href={href({ missing: onlyMissing ? undefined : "1", page: undefined })} className={buttonClass(onlyMissing ? "gold" : "ghost")} aria-pressed={onlyMissing} data-testid="filter-missing">
            <span aria-hidden className="mr-1">{onlyMissing ? "☑" : "☐"}</span> Only rows missing info ({missingCount})
          </Link>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {rows.map((r) => {
            const d = r.data as CleanRow | null;
            // Updating a possible match comes first; creating is last and labelled,
            // so a duplicate is never one careless click away.
            const opts = [
              ...r.candidateIds.map((cid) => ({ value: `update:${cid}`, label: `Update ${candidates.get(cid)?.displayName ?? "existing client"}` })),
              { value: "skip", label: "Skip this row" },
              ...(r.match === "ERROR" ? [] : [{ value: "create", label: r.candidateIds.length ? "Create a NEW client (I checked — not a duplicate)" : "Create a new client" }]),
            ];
            const result = r.resultClientId ? candidates.get(r.resultClientId) : null;
            const target = r.decision?.startsWith("update:") ? candidates.get(r.decision.slice(7)) ?? null : null;
            const edits = (r.edits as RowEdits | null) ?? {};
            const eff = d ? applyEdits(d, edits, target) : null;
            const field = (key: string, label?: string): EditorField => ({
              key,
              label: label ?? EDIT_LABELS[key] ?? key,
              imported: (d?.[key as keyof CleanRow] as string | null | undefined) ?? null,
              entered: (edits[key as keyof RowEdits] as string | undefined) ?? null,
              existing: target ? ((target[key as keyof typeof target] as string | null) ?? null) : null,
              useImported: r.approvedFields.includes(key),
              ...FIELD_LAYOUT[key],
            });
            const year = d?.taxYear ?? batch.taxYear;
            const caseNow = target ? existingCases.find((c) => c.clientId === target.id && c.taxYear === year) : null;
            const existingMailing = target
              ? target.mailingSameAsAddress
                ? "Same as street address"
                : [target.mailingAddressLine1, target.mailingAddressLine2, [target.mailingCity, target.mailingState].filter(Boolean).join(", "), target.mailingPostalCode].filter(Boolean).join(" · ") || null
              : null;
            const editable = !!d && r.match !== "ERROR" && r.decision !== "skip";
            const missing = r.decision === "skip" ? [] : r.missingInfo;
            return (
              <div key={r.id} className="rounded-xl border border-navy-100 bg-white p-3 sm:p-4" data-testid="import-row">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-slate-500">Row {r.rowNumber}</p>
                    {d ? (
                      <>
                        <p className="font-semibold text-navy-900">{d.displayName}{d.businessName && d.businessName !== d.displayName ? ` · ${d.businessName}` : ""}</p>
                        <p className="text-sm text-slate-700">{[eff?.email, eff?.phoneNormalized && formatPhone(eff.phoneNormalized), [eff?.city, eff?.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No contact details"}</p>
                      </>
                    ) : result ? (
                      <Link href={`/clients/${result.id}`} className="font-semibold underline">{result.displayName}</Link>
                    ) : (
                      <p className="text-sm text-slate-600">{r.decision === "skip" ? "Skipped" : "—"}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {open && missing.length > 0 && <Badge tone="amber">Missing: {missing.join(", ").toLowerCase()}</Badge>}
                    {open && d && missing.length === 0 && Object.keys(edits).length > 0 && <Badge tone="green">Completed in preview</Badge>}
                    <Badge tone={MATCH_LABEL[r.match].tone}>{MATCH_LABEL[r.match].text}</Badge>
                  </div>
                </div>
                {d && eff && (d.spouse || eff.returnType || d.returnTypeText || wantsCase) && (
                  <p className="mt-1 text-sm text-slate-700" data-testid="row-tax">
                    {d.spouse ? <>Taxpayer: <strong>{joinName(d.primary ?? null)}</strong> · Spouse: <strong>{joinName(d.spouse)}</strong> · </> : null}
                    Return type: <strong>{eff?.returnType ? returnTypeLabel(eff.returnType, eff.otherReturnForm) : "Not set"}</strong>
                  </p>
                )}
                {d && <p className="mt-1 text-xs"><Badge tone="navy">{classification(d)}</Badge></p>}
                {d && eff && (open || target) && (
                <details className="group mt-2 rounded-md border border-navy-100" open={sp.open === r.id} data-testid="row-details">
                  <summary className="cursor-pointer list-none rounded-md bg-ivory-50 px-2 py-1.5 text-sm font-semibold text-navy-900 marker:hidden">
                    <span aria-hidden className="mr-1 inline-block transition group-open:rotate-90">▸</span>
                    {open && editable ? (missing.length ? `Complete missing info (${missing.join(", ").toLowerCase()})` : "Address & contact") : "Details"}
                  </summary>
                  <div className="space-y-3 p-2">
                {open && editable && (
                  <ImportRowEditor
                    rowId={r.id}
                    matched={!!target}
                    address={ADDRESS_FIELDS.map((k) => field(k))}
                    mailing={MAILING_FIELDS.map((k) => field(k))}
                    contact={CONTACT_FIELDS.map((k) => field(k))}
                    mailingSame={eff.mailingSameAsAddress ?? true}
                    existingMailing={existingMailing}
                    returnType={wantsCase ? { imported: d.returnType ?? null, entered: edits.returnType ?? null, existing: caseNow?.returnType ? returnTypeLabel(caseNow.returnType, caseNow.otherReturnForm) : null, options: RT_OPTIONS } : null}
                  />
                )}
                {r.decision?.startsWith("update:") && target && (() => {
                  const cur = target;
                  const rows = compareFields(cur, eff, { approved: r.approvedFields, assignedToId: batch.batchAssignedToId, labelFor: (f, v) => (f === "assignedToId" ? staffNames.get(v ?? "") ?? v : v) }).filter((x) => !(open && editable && EDITOR.has(x.field)));
                  const plan = plannedChanges(cur, eff, "fill_blanks", batch.batchServices, { approved: r.approvedFields, assignedToId: batch.batchAssignedToId });
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
                          {differs.map((x) => <input key={`s${x.field}`} type="hidden" name="scope" value={x.field} />)}
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
                  </div>
                </details>
                )}
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
              {page > 1 ? <Link className={buttonClass("secondary")} href={href({ page: String(page - 1) })}>Previous</Link> : <span />}
              <span>Page {page} of {Math.ceil(filtered / PAGE)}</span>
              {page * PAGE < filtered ? <Link className={buttonClass("secondary")} href={href({ page: String(page + 1) })}>Next</Link> : <span />}
            </nav>
          )}
        </div>

        {open && (
          <div className="space-y-4">
            <Card title="Confirm import">
              <ul className="mb-3 space-y-1 text-sm">
                <li>{countOf("NEW")} new · {countOf("MATCH")} matched · {countOf("AMBIGUOUS")} need review · {countOf("ERROR")} errors</li>
                {undecided > 0 && <li className="font-semibold text-amber-800">{undecided} row(s) still need a decision.</li>}
                {noAddress > 0 && <li className="text-amber-800">{noAddress} row(s) missing an address</li>}
                {noFiling > 0 && <li className="text-amber-800">{noFiling} row(s) with no return type / filing status</li>}
                {onlyMissing && filtered === 0 && <li className="text-emerald-700">Every row to import is complete.</li>}
              </ul>
              <ActionForm action={commitImportAction.bind(null, id)} className="space-y-3" showSuccess={false}>
                <fieldset className="space-y-2 text-sm">
                  <legend className="mb-1 font-semibold text-navy-900">When updating existing clients</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" value="fill_blanks" defaultChecked className="mt-1 accent-navy-900" /> Fill in blank fields, and replace only the fields you approved in the comparison</label>
                </fieldset>
                {(noAddress > 0 || noFiling > 0) && <p className="pt-1 text-sm font-semibold text-navy-900">Rows still incomplete</p>}
                {noAddress > 0 && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="addressNeeded" value="1" className="mt-1 accent-navy-900" />
                    <span>Import clients with incomplete addresses and mark them <strong>Address Needed</strong></span>
                  </label>
                )}
                {noFiling > 0 && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" name="filingStatusNeeded" value="1" className="mt-1 accent-navy-900" />
                    <span>Import without a filing status and mark them <strong>Filing Status Needed</strong> (never assumed)</span>
                  </label>
                )}
                <p className="text-xs text-slate-600">Addresses and contact details entered in the preview are saved to the client record. Existing values are kept unless you chose “Use imported value”, and a blank never replaces a value on file. Tags, services and groups are added, never removed. Opt-outs and permission history are never changed by an import. The preview on each matched row shows exactly what “Only fill in blank fields” will change.</p>
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
