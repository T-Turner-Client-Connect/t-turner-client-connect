"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { parseCents } from "@/lib/services/ledger";
import {
  clearCycleError, flagCycleError, markHoursRequested, markProcessed, markSubmittedInAdp, recordHoursByStaff, resetClientPlan, saveManualTotals, saveReminderPlan, saveSchedule,
  sendForClientApproval, setClientRemindersAuthorized, setCycleAssignee, uploadPreview, type UploadedFile,
} from "@/lib/services/payroll-taxes";
import { sendTestToOffice } from "@/lib/services/payroll-reminders";
import { CHANNELS, DEFAULT_PLAN, deliveryOf, type ReminderChannel } from "@/lib/payroll/queue";

/**
 * ADP Payroll & Taxes server actions. Each one signs in the staff member from the session and the
 * service re-checks the owner-granted permission (View can't change anything) and the client scope.
 */

const refresh = () => revalidatePath("/payroll-taxes", "layout");
const int = (fd: FormData, k: string) => {
  const v = str(fd, k).trim();
  return v === "" ? NaN : Number(v);
};

async function fileOf(fd: FormData, key = "file", required = true): Promise<UploadedFile | null> {
  const f = fd.get(key);
  if (!(f instanceof File) || f.size === 0) {
    if (required) throw new ValidationError("Choose the file to upload.");
    return null;
  }
  return { bytes: new Uint8Array(await f.arrayBuffer()), fileName: f.name };
}

export async function saveScheduleAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await saveSchedule(actor, clientId, {
      frequency: str(fd, "frequency"),
      anchorPayDate: str(fd, "anchorPayDate"),
      semiMonthlyDays: [int(fd, "semi1"), int(fd, "semi2")].filter((n) => Number.isFinite(n)),
      periodEndLagDays: int(fd, "periodEndLagDays"),
      hoursRequestLeadDays: int(fd, "hoursRequestLeadDays"),
      hoursDueDays: int(fd, "hoursDueDays"),
      approvalDueDays: int(fd, "approvalDueDays"),
      adpCutoffDays: int(fd, "adpCutoffDays"),
      assignedStaffId: str(fd, "assignedStaffId") || null,
      active: str(fd, "active") === "on",
      clientRemindersEnabled: str(fd, "clientRemindersEnabled") === "on",
      notes: str(fd, "notes"),
    });
    refresh();
    return { ok: `Schedule saved. ${r.created} new pay cycle${r.created === 1 ? "" : "s"} in the next 6 weeks${r.updated ? `, ${r.updated} updated` : ""}${r.removed ? `, ${r.removed} removed` : ""}. Nothing was sent.`, next: { href: "/payroll-taxes?tab=payroll&f=all", label: "Back to the workspace" } };
  });
}

export async function assignCycleAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setCycleAssignee(actor, cycleId, str(fd, "staffId") || null);
    refresh();
    return "Assignment saved for this pay cycle.";
  });
}

function hoursFrom(fd: FormData) {
  const raw = str(fd, "hours");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new ValidationError("The hours form couldn't be read. Reload the page and try again.");
  }
}

export async function recordHoursAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordHoursByStaff(actor, cycleId, hoursFrom(fd));
    refresh();
    return "Hours recorded for the client.";
  });
}

export async function markHoursRequestedAction(cycleId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markHoursRequested(actor, cycleId);
    refresh();
    return "Recorded that you asked for hours (no message was sent).";
  });
}

export async function uploadPreviewAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = (await fileOf(fd))!;
    const r = await uploadPreview(actor, cycleId, file, { preset: str(fd, "preset") || undefined });
    refresh();
    return r.kind === "PDF" ? `Preview attached — this is now v${r.version}. Earlier approvals no longer count.` : "Register imported and linked to this pay cycle. The file is saved in the client's documents.";
  });
}

const cents = (fd: FormData, k: string) => (str(fd, k).trim() ? parseCents(str(fd, k), k) : 0);

export async function manualTotalsAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    let t;
    try {
      t = { employees: int(fd, "employees"), hours: str(fd, "hours") ? Number(str(fd, "hours")) : 0, grossCents: cents(fd, "gross"), employeeTaxCents: cents(fd, "employeeTaxes"), deductionsCents: cents(fd, "deductions"), netPayCents: cents(fd, "net"), employerTaxCents: cents(fd, "employerTaxes"), reason: str(fd, "reason") };
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Check the amounts.");
    }
    const r = await saveManualTotals(actor, cycleId, t, await fileOf(fd, "file", false));
    refresh();
    return `Saved as v${r.version}.${r.version > 1 ? " Earlier approvals no longer count." : ""}`;
  });
}

export async function sendForApprovalAction(cycleId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await sendForClientApproval(actor, cycleId);
    refresh();
    const sent = r.notices.filter((n) => n.status === "SENT").length;
    const delivery = deliveryOf(r.notices.map((n) => ({ channel: n.channel, status: n.status, detail: n.detail })));
    if (delivery === "NOT_SENT") return "Approval Prepared — Not Sent. Email isn't turned on for Client Connect on the server, so nothing went out. Send it again once email is on.";
    if (delivery === "FAILED") return "Delivery Failed — Needs Attention. An approval email wasn't accepted, so no text was sent for it. Check the approver's email address, then send it again.";
    return `Sent for client approval (round ${r.run.approvalRound}). ${sent ? `${sent} notice${sent === 1 ? "" : "s"} sent.` : "Approvers see it in their portal; no email or text went out (see the notices below)."}`;
  });
}

export async function flagErrorAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await flagCycleError(actor, cycleId, str(fd, "note"));
    refresh();
    return "Flagged. The cycle is in Needs correction until a revised preview is sent.";
  });
}

export async function clearErrorAction(cycleId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await clearCycleError(actor, cycleId);
    refresh();
    return "Flag cleared.";
  });
}

export async function markSubmittedAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markSubmittedInAdp(actor, cycleId, str(fd, "note") || null);
    refresh();
    return "Recorded as Submitted in ADP (by you, now).";
  });
}

export async function markProcessedAction(cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markProcessed(actor, cycleId, await fileOf(fd, "file", false), { note: str(fd, "note") });
    refresh();
    return "Marked processed. ADP's confirmation is saved in the client file.";
  });
}

export async function saveReminderPlanAction(key: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const steps = DEFAULT_PLAN.map((d) => ({
      key: d.key,
      enabled: str(fd, `${d.key}.enabled`) === "on",
      hoursBefore: d.hoursBefore === null ? null : Number(str(fd, `${d.key}.hoursBefore`) || d.hoursBefore),
      channels: (Object.keys(CHANNELS) as ReminderChannel[]).filter((c) => str(fd, `${d.key}.${c}`) === "on"),
    }));
    await saveReminderPlan(actor, key, steps);
    refresh();
    return key === "global" ? "Reminder plan saved for every client without its own plan." : "This client's reminder plan is saved.";
  });
}

export async function resetClientPlanAction(clientId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await resetClientPlan(actor, clientId);
    refresh();
    return "This client now follows the office-wide plan.";
  });
}

export async function setRemindersAuthorizedAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const on = str(fd, "on") === "true";
    await setClientRemindersAuthorized(actor, on);
    refresh();
    return on ? "Client reminders are authorized. They still go only to clients whose own reminders switch is on." : "Client reminders are off. Automated client reminders are held and never sent.";
  });
}

export async function sendTestAction(): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await sendTestToOffice(actor);
    if (!r.ok) throw new ValidationError(`The test didn't go out: ${r.detail}`);
    return `Test sent to the office email (${r.to}) only.`;
  });
}
