"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { discardPayrollRun, editPayrollRun, importPayrollRegister, postPayrollRun, previewPayrollImport, savePayrollSetup } from "@/lib/services/payroll";
import { requestPayrollApproval, setNotifyChannel, setPayrollApprover, submitPayrollRun } from "@/lib/services/payroll-approval";
import { deliveryOf } from "@/lib/payroll/queue";
import { AMOUNT_KEYS, type Mapping } from "@/lib/payroll/register";
import { isPayrollField } from "@/lib/payroll/fields";
import { parseCents, usd } from "@/lib/services/ledger";

const refresh = () => {
  revalidatePath("/bookkeeping", "layout");
  revalidatePath("/owner/payroll-approvers");
};

export async function payrollSetupAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await savePayrollSetup(actor, clientId, { system: str(fd, "system"), providerName: str(fd, "providerName"), frequency: str(fd, "frequency") || null, connection: str(fd, "connection") || null, accessStatus: str(fd, "accessStatus") || null });
    refresh();
    return "Payroll setup saved.";
  });
}

async function fileOf(fd: FormData) {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the payroll register file (PDF, CSV or .xlsx).");
  return { bytes: new Uint8Array(await f.arrayBuffer()), fileName: f.name };
}
function mappingOf(fd: FormData): Mapping | null {
  const raw = str(fd, "mapping");
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError("The column mapping couldn't be read. Preview the file again.");
  }
  const m: Mapping = {};
  for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
    if (!/^\d{1,3}$/.test(k)) continue;
    m[Number(k)] = typeof v === "string" && isPayrollField(v) ? v : "";
  }
  return m;
}
const headerRowOf = (fd: FormData) => (str(fd, "headerRow") ? Number(str(fd, "headerRow")) : null);

export type PreviewResult = { error?: string; data?: Awaited<ReturnType<typeof previewPayrollImport>> };

/** Preview only: nothing is saved. */
export async function previewPayrollAction(clientId: string, fd: FormData): Promise<PreviewResult> {
  const actor = await requireUser();
  let preview: PreviewResult["data"];
  const r = await run(async () => {
    const file = await fileOf(fd);
    const data = await previewPayrollImport(actor, clientId, { ...file, preset: str(fd, "preset"), mapping: mappingOf(fd), defaultCheckDate: str(fd, "defaultCheckDate") || null, headerRow: headerRowOf(fd) });
    preview = data;
  });
  return r?.error ? { error: r.error } : { data: preview };
}

export async function importPayrollAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = await fileOf(fd);
    const r = await importPayrollRegister(actor, clientId, { ...file, preset: str(fd, "preset"), mapping: mappingOf(fd), defaultCheckDate: str(fd, "defaultCheckDate") || null, headerRow: headerRowOf(fd), cashAccountId: str(fd, "cashAccountId") || null, alreadyProcessed: str(fd, "alreadyProcessed") === "on" });
    refresh();
    const parts = [`${r.created.length} pay run${r.created.length === 1 ? "" : "s"} created as drafts for review`];
    if (r.duplicates.length) parts.push(`${r.duplicates.length} already imported (skipped)`);
    if (r.unbalanced.length) parts.push(`${r.unbalanced.length} not imported because the totals don't tie out (${r.unbalanced.map((u) => `${u.checkDate}: off by ${usd(u.differenceCents)}`).join(", ")})`);
    return `${parts.join("; ")}. The file is saved in the client's documents.`;
  });
}

export async function postPayrollRunAction(clientId: string, runId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await postPayrollRun(actor, clientId, runId, { cashAccountId: str(fd, "cashAccountId") || null });
    refresh();
    return "Payroll journal entry posted.";
  });
}

export async function discardPayrollRunAction(clientId: string, runId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await discardPayrollRun(actor, clientId, runId, str(fd, "reason"));
    refresh();
    return "Pay run discarded (kept in the history).";
  });
}

const HOURS = "hoursHundredths";
/** Line fields come in as l{i}.{key}: hours as "40.25", money as "1,234.56". */
export async function editPayrollRunAction(clientId: string, runId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const count = Number(str(fd, "lineCount"));
    const lines = [];
    for (let i = 0; i < count; i++) {
      const name = str(fd, `l${i}.employeeName`).trim();
      if (!name) continue;
      const l: Record<string, number | string> = { employeeName: name };
      for (const k of AMOUNT_KEYS) {
        const raw = str(fd, `l${i}.${k}`).trim() || "0";
        l[k] = k === HOURS ? Math.round(Number(raw.replace(/,/g, "")) * 100) : parseCents(raw, k === "grossCents" ? "gross" : "amount");
        if (!Number.isFinite(l[k] as number)) throw new ValidationError(`Check the hours for ${name}.`);
      }
      lines.push(l as { employeeName: string });
    }
    const v = await editPayrollRun(actor, clientId, runId, { lines, reason: str(fd, "reason"), periodStart: str(fd, "periodStart") || null, periodEnd: str(fd, "periodEnd") || null, checkDate: str(fd, "checkDate") || undefined });
    refresh();
    return `Saved as version ${v.number}. Earlier approvals no longer count — send it for approval again.`;
  });
}

export async function requestApprovalAction(clientId: string, runId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { notices } = await requestPayrollApproval(actor, clientId, runId);
    refresh();
    const sent = notices.filter((n) => n.status === "SENT").length;
    const other = notices.filter((n) => n.status !== "SENT");
    const delivery = deliveryOf(notices);
    if (delivery === "NOT_SENT") return "Approval Prepared — Not Sent. Email isn't turned on for Client Connect on the server, so nothing went out. Send it again once email is on.";
    if (delivery === "FAILED") return "Delivery Failed — Needs Attention. An approval email wasn't accepted, so no text was sent for it. Check the approver's email address, then send it again.";
    return `Sent for approval. ${sent} notice${sent === 1 ? "" : "s"} sent${other.length ? `; ${other.length} not sent (see the timeline for why)` : ""}.`;
  });
}

export async function submitRunAction(clientId: string, runId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await submitPayrollRun(actor, clientId, runId, { note: str(fd, "note") });
    refresh();
    return "Recorded as submitted for processing. The run is now locked.";
  });
}

export async function setApproverAction(clientId: string, portalUserId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const role = str(fd, "role"); // NONE | OPTIONAL | REQUIRED
    await setPayrollApprover(actor, clientId, portalUserId, { approver: role === "OPTIONAL" || role === "REQUIRED", required: role === "REQUIRED", showEmployeeDetail: str(fd, "showEmployeeDetail") === "on" });
    refresh();
    return "Saved.";
  });
}

export async function staffNotifyChannelAction(clientId: string, portalUserId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setNotifyChannel({ staff: actor }, clientId, portalUserId, str(fd, "channel"));
    refresh();
    return "Saved at the client's request.";
  });
}
