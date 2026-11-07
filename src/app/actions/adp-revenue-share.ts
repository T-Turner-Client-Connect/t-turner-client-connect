"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { assertOwner } from "@/lib/auth/owner";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { parseCents, type CsvMapping, type LineType } from "@/lib/adp-revenue-share";
import {
  addLine,
  archivePayment,
  archiveReferral,
  archiveStatement,
  attachStatementFile,
  changeReferralStatus,
  createPayment,
  createReferral,
  createStatement,
  finalizeStatement,
  importLines,
  matchPayment,
  previewLineImport,
  removeLine,
  saveFiscalNote,
  unmatchPayment,
  updateLine,
  updatePayment,
  updateReferral,
  updateStatement,
} from "@/lib/services/adp-revenue-share";

// Owner's Office → ADP Revenue Share. Every action is owner-only: it checks the owner binding
// (assertOwner) before reading the form, and the service checks it again on every call, so a
// direct POST from anyone else — staff, an Admin who isn't the owner — gets "Not found." and
// changes nothing. Ids passed in are never trusted:
// the service loads each record and refuses archived or missing ones.

const BASE = "/owner/adp-revenue-share";
const refresh = (...paths: string[]) => {
  revalidatePath(BASE, "layout");
  paths.forEach((p) => revalidatePath(p));
};

function money(fd: FormData, key: string, label: string, opts: { allowNegative?: boolean } = {}) {
  const v = parseCents(str(fd, key), opts);
  if (v === null) throw new ValidationError(`Enter ${label} as dollars and cents, e.g. 125.00${opts.allowNegative ? " (or -125.00 for a negative adjustment)" : ""}.`);
  return v;
}

function file(fd: FormData, key: string) {
  const f = fd.get(key);
  return f instanceof File && f.size > 0 ? f : null;
}
const upload = async (f: File | null) => (f ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null);

// --- Referrals ----------------------------------------------------------------------------------

const referralInput = (fd: FormData) => ({
  clientId: str(fd, "clientId") || null,
  prospectName: str(fd, "prospectName"),
  referredOn: str(fd, "referredOn"),
  product: str(fd, "product"),
  productOther: str(fd, "productOther"),
  adpReference: str(fd, "adpReference"),
  notes: str(fd, "notes"),
});

export async function createReferralAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    const r = await createReferral(actor, { ...referralInput(fd), status: str(fd, "status") || "REFERRED" });
    refresh();
    return { ok: "Referral saved.", next: { href: `${BASE}/referrals/${r.id}`, label: "Open the referral" } };
  });
}

export async function updateReferralAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await updateReferral(actor, id, referralInput(fd));
    refresh(`${BASE}/referrals/${id}`);
    return "Referral updated.";
  });
}

export async function referralStatusAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await changeReferralStatus(actor, id, { status: str(fd, "status"), effectiveOn: str(fd, "effectiveOn") || null, note: str(fd, "note") });
    refresh(`${BASE}/referrals/${id}`);
    return "Status changed and added to the history.";
  });
}

export async function archiveReferralAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await archiveReferral(actor, id, str(fd, "reason"));
    refresh(`${BASE}/referrals/${id}`);
    return "Referral deleted. It stays in your private history (with your reason) but is no longer listed.";
  });
}

// --- Statements ---------------------------------------------------------------------------------

const headerInput = (fd: FormData) => ({
  periodLabel: str(fd, "periodLabel"),
  periodStart: str(fd, "periodStart"),
  periodEnd: str(fd, "periodEnd"),
  statementDate: str(fd, "statementDate"),
  reportedTotalCents: money(fd, "reportedTotal", "the statement total", { allowNegative: true }),
  notes: str(fd, "notes"),
});

export async function createStatementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    const s = await createStatement(actor, { ...headerInput(fd), file: await upload(file(fd, "file")) });
    refresh();
    return { ok: "Statement saved as a draft. Add its lines next.", next: { href: `${BASE}/statements/${s.id}`, label: "Enter the statement's lines" } };
  });
}

export async function updateStatementAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await updateStatement(actor, id, { ...headerInput(fd), reason: str(fd, "reason") });
    refresh(`${BASE}/statements/${id}`);
    return "Statement updated.";
  });
}

export async function attachStatementFileAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    const f = await upload(file(fd, "file"));
    if (!f) throw new ValidationError("Choose the statement file.");
    await attachStatementFile(actor, id, f, str(fd, "reason"));
    refresh(`${BASE}/statements/${id}`);
    return "Statement file saved in your private store.";
  });
}

const lineInput = (fd: FormData) => ({
  type: str(fd, "type") as LineType,
  amountCents: money(fd, "amount", "the amount", { allowNegative: true }),
  referralId: str(fd, "referralId") || null,
  clientId: str(fd, "clientId") || null,
  adpName: str(fd, "adpName"),
  note: str(fd, "note"),
  reason: str(fd, "reason"),
});

export async function addLineAction(statementId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await addLine(actor, statementId, lineInput(fd));
    refresh(`${BASE}/statements/${statementId}`);
    return "Line added.";
  });
}

export async function updateLineAction(statementId: string, lineId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await updateLine(actor, lineId, lineInput(fd));
    refresh(`${BASE}/statements/${statementId}`);
    return "Line updated.";
  });
}

export async function removeLineAction(statementId: string, lineId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await removeLine(actor, lineId, str(fd, "reason"));
    refresh(`${BASE}/statements/${statementId}`);
    return "Line removed. It stays on the statement's record, marked removed, and no longer counts.";
  });
}

export async function finalizeStatementAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await finalizeStatement(actor, id, { acknowledgeMismatch: fd.get("acknowledgeMismatch") === "on", note: str(fd, "note") });
    refresh(`${BASE}/statements/${id}`);
    return "Statement marked Final. Later changes need a revision note and are kept in its history.";
  });
}

export async function archiveStatementAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await archiveStatement(actor, id, str(fd, "reason"));
    refresh(`${BASE}/statements/${id}`);
    return "Statement deleted. It stays in your private history (with your reason) but no longer counts.";
  });
}

// --- CSV import (browser sends the CSV text and the owner's mapping; the server re-reads it) ---

export type ImportPreview = Awaited<ReturnType<typeof previewLineImport>>;
export type ImportPreviewResult = { ok: true; preview: ImportPreview } | { ok: false; error: string };

function mappingOf(raw: unknown): CsvMapping | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const col = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  const amount = col(m.amount);
  if (amount === null) return null;
  return { headerRow: m.headerRow !== false, amount, type: col(m.type), fixedType: typeof m.fixedType === "string" && m.fixedType ? (m.fixedType as LineType) : null, name: col(m.name), note: col(m.note) };
}

export async function previewImportAction(input: { csvText: string; mapping?: unknown; excluded?: number[] }): Promise<ImportPreviewResult> {
  const actor = await requireUser();
  let preview: ImportPreview | undefined;
  const r = await run(async () => {
    await assertOwner(actor);
    preview =await previewLineImport(actor, { csvText: String(input.csvText ?? ""), mapping: mappingOf(input.mapping), excluded: (input.excluded ?? []).map(Number).filter(Number.isInteger) });
  });
  return r?.error || !preview ? { ok: false, error: r?.error ?? "Nothing to preview." } : { ok: true, preview };
}

export async function importLinesAction(statementId: string, input: { csvText: string; mapping: unknown; excluded?: number[]; links?: Record<string, string>; reason?: string; fileName?: string }): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    const mapping = mappingOf(input.mapping);
    if (!mapping) throw new ValidationError("Choose the column that holds the amount.");
    const links = Object.fromEntries(Object.entries(input.links ?? {}).filter(([k, v]) => typeof k === "string" && typeof v === "string").slice(0, 2000));
    const r = await importLines(actor, statementId, { csvText: String(input.csvText ?? ""), mapping, excluded: (input.excluded ?? []).map(Number).filter(Number.isInteger), links, reason: input.reason, fileName: input.fileName });
    refresh(`${BASE}/statements/${statementId}`);
    return `${r.count} line${r.count === 1 ? "" : "s"} imported.`;
  });
}

// --- Payments -----------------------------------------------------------------------------------

const paymentInput = (fd: FormData) => ({
  receivedOn: str(fd, "receivedOn"),
  amountCents: money(fd, "amount", "the amount"),
  method: str(fd, "method"),
  methodOther: str(fd, "methodOther"),
  periodsCovered: str(fd, "periodsCovered"),
  reference: str(fd, "reference"),
  note: str(fd, "note"),
});

export async function createPaymentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    const p = await createPayment(actor, { ...paymentInput(fd), statementId: str(fd, "statementId") || null });
    refresh();
    return { ok: "Payment recorded.", next: { href: `${BASE}/payments/${p.id}`, label: "Open the payment" } };
  });
}

export async function updatePaymentAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await updatePayment(actor, id, paymentInput(fd));
    refresh(`${BASE}/payments/${id}`);
    return "Payment updated.";
  });
}

export async function matchPaymentAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await matchPayment(actor, id, str(fd, "statementId"), str(fd, "note"));
    refresh(`${BASE}/payments/${id}`);
    return "Payment matched to the statement. The match is in the payment's history.";
  });
}

export async function unmatchPaymentAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await unmatchPayment(actor, id, str(fd, "reason"));
    refresh(`${BASE}/payments/${id}`);
    return "Payment unmatched. The change is in the payment's history.";
  });
}

export async function archivePaymentAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await archivePayment(actor, id, str(fd, "reason"));
    refresh(`${BASE}/payments/${id}`);
    return "Payment deleted. It stays in your private history (with your reason) but no longer counts.";
  });
}

// --- Settings -----------------------------------------------------------------------------------

export async function saveFiscalNoteAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await assertOwner(actor);
    await saveFiscalNote(actor, str(fd, "fiscalNote"));
    refresh();
    return "Fiscal-quarter note saved.";
  });
}
