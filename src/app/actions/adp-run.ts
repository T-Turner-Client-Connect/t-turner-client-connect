"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  applyIdentifierList, confirmTimeSheetFeature, createTestFile, generateCycleFile, importEarningsReport, importEmployeeReport, markFileImported, previewIdentifierList, recordTestVerified,
  saveAdpIdentifiers, saveEmployeeMap, setAdpPayFrequency, setEarningsCodes, uploadAdpTemplate,
} from "@/lib/services/adp-run";

/** ADP RUN Time Sheet Import actions. The services re-check Manage access and the client scope. */

const refresh = () => revalidatePath("/payroll-taxes", "layout");

async function bytesOf(fd: FormData, key = "file") {
  const f = fd.get(key);
  if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the .csv file to upload.");
  return new Uint8Array(await f.arrayBuffer());
}

export async function saveIdentifiersAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveAdpIdentifiers(actor, clientId, { acClientId: str(fd, "acClientId"), branch: str(fd, "branch"), code: str(fd, "code"), form: str(fd, "form") === "IID" ? "IID" : "BRANCH_CODE" });
    refresh();
    return "ADP company identifiers saved (stored encrypted).";
  });
}

export async function confirmFeatureAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const on = str(fd, "on") === "1";
    await confirmTimeSheetFeature(actor, clientId, on);
    refresh();
    return on ? "Recorded: Time Sheet Import is turned on in this client's RUN." : "Cleared.";
  });
}

export async function setFrequencyAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setAdpPayFrequency(actor, clientId, str(fd, "letter"));
    refresh();
    return "Pay frequency saved.";
  });
}

export async function uploadTemplateAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const t = await uploadAdpTemplate(actor, clientId, await bytesOf(fd));
    refresh();
    return `Template checked: ${t.version}, ADP's 11 columns in the right order, Employee ID layout.`;
  });
}

export async function employeeReportAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await importEmployeeReport(actor, clientId, await bytesOf(fd));
    refresh();
    return `Employee Codes Report read: ${r.added} added, ${r.updated} updated${r.problems.length ? `. Notes: ${r.problems.join(" ")}` : ""}. Check each name matches how hours are entered.`;
  });
}

export async function earningsReportAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const n = await importEarningsReport(actor, clientId, await bytesOf(fd));
    refresh();
    return `Earnings Codes Report read: ${n} codes. Confirm the codes for regular and overtime hours.`;
  });
}

export async function earningsCodesAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setEarningsCodes(actor, clientId, { regular: str(fd, "regular"), overtime: str(fd, "overtime"), usesDepartments: str(fd, "usesDepartments") === "on" });
    refresh();
    return "Earnings codes saved.";
  });
}

export async function employeeMapAction(clientId: string, id: string | null, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveEmployeeMap(actor, clientId, id, { name: str(fd, "name"), adpEmployeeId: str(fd, "adpEmployeeId"), departmentCode: str(fd, "departmentCode"), rateCode: str(fd, "rateCode") || "BASE", active: str(fd, "active") === "on" });
    refresh();
    return id ? "Employee saved." : "Employee added.";
  });
}

export async function testFileAction(clientId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const exp = await createTestFile(actor, clientId);
    refresh();
    return { ok: `Test file ready: ${exp.rows} rows of fictional hours (1.00 regular hour each). Import it in RUN, check for errors, then delete it there without approving.`, next: { href: `/api/payroll-taxes/adp-file/${exp.id}`, label: "Download the test file" } };
  });
}

export async function testVerifiedAction(clientId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordTestVerified(actor, clientId, str(fd, "note"));
    refresh();
    return "Test import recorded. Download ADP CSV is now available on this client's pay cycles.";
  });
}

export async function cycleFileAction(cycleId: string, _p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await generateCycleFile(actor, cycleId, str(fd, "replaceReason"));
    refresh();
    const e = r.export;
    return {
      ok: r.reused
        ? `Same hours as the file made ${e.createdAt.toLocaleDateString("en-US")}: you'll get that same file.${e.importedAt ? " It was already imported into RUN — don't import it twice." : ""}`
        : `ADP CSV ready: ${e.employees} employee${e.employees === 1 ? "" : "s"}, ${e.rows} row${e.rows === 1 ? "" : "s"}, ${(e.hoursHundredths / 100).toFixed(2)} hours.`,
      next: { href: `/api/payroll-taxes/adp-file/${e.id}`, label: "Download ADP CSV" },
    };
  });
}

export async function fileImportedAction(exportId: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markFileImported(actor, exportId);
    refresh();
    return "Recorded as imported into RUN. Review the Pay Data Approval page and submit payroll in RUN as usual.";
  });
}

export async function identifierListAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const text = str(fd, "list");
    if (!text.trim()) throw new ValidationError("Paste the list first.");
    if (str(fd, "confirm") !== "on") {
      const rows = await previewIdentifierList(actor, text);
      const ok = rows.filter((r) => !r.problem);
      const bad = rows.filter((r) => r.problem).map((r) => `Line ${r.line} (${r.business || "blank"}): ${r.problem}`);
      return `Preview only, nothing saved. ${ok.length} ready: ${ok.map((r) => `${r.business} → ${r.clientName}`).join("; ") || "none"}.${bad.length ? ` Needs attention: ${bad.join(" ")}` : ""} Tick “Save the ready rows” and submit again to save.`;
    }
    const r = await applyIdentifierList(actor, text);
    refresh();
    return `Saved ${r.saved} business${r.saved === 1 ? "" : "es"}; ${r.skipped} skipped.${r.failed.length ? ` ${r.failed.join(" ")}` : ""}`;
  });
}
