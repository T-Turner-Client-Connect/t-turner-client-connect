"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser, clientIp } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { MAX_UPLOAD_BYTES } from "@/lib/files";
import * as E from "@/lib/services/compliance/entities";
import * as O from "@/lib/services/compliance/obligations";
import * as P from "@/lib/services/compliance/periods";
import { setComplianceSwitch, updateReminderSettings, type SwitchKey } from "@/lib/services/compliance/settings";
import { addIndustryTemplate, editRule } from "@/lib/services/compliance/rules";
import { applyProposedProfile } from "@/lib/services/compliance/proposal";

// Every action re-checks access in the service (assertComplianceView / Manage / Owner, or the
// portal gate for client decisions). The browser only names WHICH record; ownership and
// permissions are read from the database.

const lines = (v: string) => v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const intOrNull = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));
const centsOrNull = (v: string) => {
  const t = v.replace(/[$,\s]/g, "");
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new ValidationError("Enter the amount as dollars and cents.");
  return Math.round(Number(t) * 100);
};
const refresh = (...paths: string[]) => {
  for (const p of ["/compliance", ...paths]) revalidatePath(p);
};

function entityInput(fd: FormData): E.EntityInput {
  return {
    kind: str(fd, "kind"),
    legalName: str(fd, "legalName"),
    dba: str(fd, "dba"),
    stateOfFormation: str(fd, "stateOfFormation"),
    statesOfOperation: lines(str(fd, "statesOfOperation")),
    industry: str(fd, "industry"),
    naicsCode: str(fd, "naicsCode"),
    activityDescription: str(fd, "activityDescription"),
    activityTags: lines(str(fd, "activityTags")),
    legalEntityType: str(fd, "legalEntityType"),
    taxClassification: str(fd, "taxClassification") || null,
    sCorpEffectiveDate: str(fd, "sCorpEffectiveDate") || null,
    fiscalYearEndMonth: intOrNull(str(fd, "fiscalYearEndMonth")),
    payrollStatus: str(fd, "payrollStatus") || "UNKNOWN",
    employeeCount: intOrNull(str(fd, "employeeCount")),
    payrollProvider: str(fd, "payrollProvider"),
    issues1099: str(fd, "issues1099") || "UNKNOWN",
    ownerHasNonprofit: str(fd, "ownerHasNonprofit") || "UNKNOWN",
    irsExemptionStatus: str(fd, "irsExemptionStatus") || null,
    services: fd.getAll("services").filter((x): x is string => typeof x === "string"),
    portalVisible: fd.get("portalVisible") === "on",
    clientNotificationsEnabled: fd.get("clientNotificationsEnabled") === "on",
    notes: str(fd, "notes"),
  };
}

async function fileOf(fd: FormData) {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file.");
  if (f.size > MAX_UPLOAD_BYTES) throw new ValidationError("That file is too large.");
  return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
}

// --- Entities ---------------------------------------------------------------------------------

export async function createEntityAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const e = str(fd, "mode") === "prepopulate" ? await E.createEntityFromClient(actor, clientId, { kind: str(fd, "kind") || "OTHER" }) : await E.createEntity(actor, clientId, { ...entityInput(fd), ein: str(fd, "ein") });
    refresh(`/clients/${clientId}`);
    return { ok: "Entity added.", next: { href: `/compliance/entities/${e.id}`, label: "Open the entity profile" } };
  });
}

export async function updateEntityAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const changed = await E.updateEntity(actor, entityId, entityInput(fd));
    refresh(`/compliance/entities/${entityId}`);
    return changed.length ? `Saved (${changed.length} field${changed.length === 1 ? "" : "s"} changed). Run “Generate obligations” to re-check the rules.` : "No changes.";
  });
}

export async function setEinAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.setEntityEin(actor, entityId, str(fd, "ein"));
    refresh(`/compliance/entities/${entityId}`);
    return "EIN saved (encrypted). Only the last four are shown.";
  });
}

export async function revealEinAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => `EIN: ${await E.revealEntityEin(actor, entityId, str(fd, "reason"))} — this view was logged.`);
}

export async function entityStatusAction(entityId: string, status: "ACTIVE" | "INACTIVE", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.setEntityStatus(actor, entityId, status);
    refresh(`/compliance/entities/${entityId}`);
    return status === "ACTIVE" ? "Entity approved." : "Entity deactivated.";
  });
}

export async function addLocationAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.addLocation(actor, entityId, { label: str(fd, "label"), address1: str(fd, "address1"), city: str(fd, "city"), county: str(fd, "county"), state: str(fd, "state"), postalCode: str(fd, "postalCode"), isPrimary: fd.get("isPrimary") === "on" });
    refresh(`/compliance/entities/${entityId}`);
    return "Location added.";
  });
}

export async function removeLocationAction(entityId: string, locationId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.removeLocation(actor, locationId);
    refresh(`/compliance/entities/${entityId}`);
    return "Location removed.";
  });
}

export async function saveTaxAccountAction(entityId: string, accountId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.saveTaxAccount(actor, entityId, { type: str(fd, "type"), agency: str(fd, "agency"), jurisdictionLevel: str(fd, "jurisdictionLevel") || null, jurisdictionName: str(fd, "jurisdictionName"), accountNumber: str(fd, "accountNumber"), filingFrequency: str(fd, "filingFrequency") || null, effectiveDate: str(fd, "effectiveDate") || null, status: str(fd, "status") || "UNKNOWN", notes: str(fd, "notes") }, accountId ?? undefined);
    refresh(`/compliance/entities/${entityId}`);
    return "Tax account saved. Run “Generate obligations” to apply it.";
  });
}

function filingAccountInput(fd: FormData): E.FilingAccountInput {
  return { portalKind: str(fd, "portalKind"), name: str(fd, "name"), portalUrl: str(fd, "portalUrl"), accessMethod: str(fd, "accessMethod"), accessReference: str(fd, "accessReference"), firmAccountId: str(fd, "firmAccountId") || null, status: str(fd, "status") || "ACTIVE", notes: str(fd, "notes") };
}

export async function saveFilingAccountAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.saveFilingAccount(actor, entityId, filingAccountInput(fd));
    refresh(`/compliance/entities/${entityId}`);
    return "Portal saved. No password or MFA code is stored.";
  });
}

export async function saveFirmAccountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.saveFirmAccount(actor, filingAccountInput(fd));
    refresh("/compliance/settings");
    return "Firm-level account saved.";
  });
}

export async function addAuthorizationAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.addAuthorization(actor, entityId, { formType: str(fd, "formType"), filingAccountId: str(fd, "filingAccountId") || null, documentId: str(fd, "documentId") || null, effectiveDate: str(fd, "effectiveDate") || null, expiresAt: str(fd, "expiresAt") || null, status: str(fd, "status") || "ON_FILE", notes: str(fd, "notes") });
    refresh(`/compliance/entities/${entityId}`);
    return "Authorization recorded.";
  });
}

export async function setOwnersAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.setEntityOwners(actor, entityId, fd.getAll("owner").filter((x): x is string => typeof x === "string"));
    refresh(`/compliance/entities/${entityId}`);
    return "Responsible owners saved.";
  });
}

export async function viewerAction(entityId: string, portalUserId: string, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.grantEntityViewer(actor, entityId, portalUserId, on);
    refresh(`/compliance/entities/${entityId}`);
    return on ? "Access granted." : "Access removed.";
  });
}

export async function linkLicenseAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await E.linkLicense(actor, entityId, str(fd, "businessLicenseId"));
    refresh(`/compliance/entities/${entityId}`);
    return "License linked.";
  });
}

export async function applyTemplateAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const t = await E.applyIndustryTemplate(actor, entityId, str(fd, "template"));
    refresh(`/compliance/entities/${entityId}`);
    return `${t.name} template applied (activity tags added). Run “Generate obligations” next.`;
  });
}

// --- Obligations ------------------------------------------------------------------------------

export async function generateAction(entityId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const items = await O.generateObligations(actor, entityId);
    refresh(`/compliance/entities/${entityId}`);
    const created = items.filter((i) => i.created).length;
    const nv = items.filter((i) => i.result === "NEEDS_VERIFICATION").length;
    return `${created} new proposed obligation${created === 1 ? "" : "s"}; ${nv} need verification; ${items.filter((i) => i.result === "DOES_NOT_APPLY").length} rules don't apply to this profile.`;
  });
}

export async function applyProposalAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await applyProposedProfile(actor, clientId, str(fd, "package"));
    refresh(`/clients/${clientId}`);
    return { ok: `Proposed profile applied: ${r.businessItems} business item(s)${r.nonprofit ? ` and ${r.nonprofitItems} nonprofit item(s)` : ""}, all Proposed / Needs verification until Tabitha approves them.`, next: { href: `/compliance/entities/${r.business.id}`, label: "Review the proposal" } };
  });
}

export async function activateAction(obligationId: string, entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await O.activateObligation(actor, obligationId, { startDate: str(fd, "startDate") || undefined });
    refresh(`/compliance/entities/${entityId}`);
    return "Approved and active: its filing periods, prep task and reminders are set.";
  });
}

export async function obligationStatusAction(obligationId: string, entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const status = str(fd, "status") as "SUSPENDED" | "CLOSED" | "INACTIVE" | "ACTIVE";
    if (!["SUSPENDED", "CLOSED", "INACTIVE", "ACTIVE"].includes(status)) throw new ValidationError("Choose a status.");
    await O.setObligationStatus(actor, obligationId, status, str(fd, "reason") || "Reactivated");
    refresh(`/compliance/entities/${entityId}`);
    return "Status changed.";
  });
}

export async function editObligationAction(obligationId: string, entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await O.editObligation(actor, obligationId, {
      assignedStaffId: str(fd, "assignedStaffId") || null,
      reviewerId: str(fd, "reviewerId") || null,
      clientApprovalRequired: fd.get("clientApprovalRequired") === "on",
      clientVisible: fd.get("clientVisible") === "on",
      serviceType: str(fd, "serviceType") || null,
      filingAccountId: str(fd, "filingAccountId") || null,
      accessReference: str(fd, "accessReference") || null,
      prepLeadDays: Number.parseInt(str(fd, "prepLeadDays") || "10", 10),
      ...(str(fd, "frequency") ? { frequency: str(fd, "frequency") } : {}),
    });
    refresh(`/compliance/entities/${entityId}`);
    return "Saved.";
  });
}

export async function customObligationAction(entityId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await O.addCustomObligation(actor, entityId, { title: str(fd, "title"), formName: str(fd, "formName"), jurisdictionLevel: str(fd, "jurisdictionLevel"), jurisdictionName: str(fd, "jurisdictionName"), category: str(fd, "category") || "OTHER", frequency: str(fd, "frequency"), dueRuleCode: str(fd, "dueRuleCode"), weekendRule: str(fd, "weekendRule"), clientApprovalRequired: fd.get("clientApprovalRequired") === "on", startDate: str(fd, "startDate") || undefined, verified: fd.get("verified") === "on", notes: str(fd, "notes") });
    refresh(`/compliance/entities/${entityId}`);
    return "Custom obligation added and active.";
  });
}

// --- Periods ----------------------------------------------------------------------------------

const periodPaths = (periodId: string) => [`/compliance/periods/${periodId}`];

export async function startPreparingAction(periodId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.startPreparing(actor, periodId);
    refresh(...periodPaths(periodId));
    return "Marked Preparing.";
  });
}

export async function amountAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.setAmountDue(actor, periodId, centsOrNull(str(fd, "amount")));
    refresh(...periodPaths(periodId));
    return "Amount saved. Any earlier version and approval was invalidated.";
  });
}

export async function dueDateAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.setPeriodDueDate(actor, periodId, str(fd, "dueDate"), str(fd, "note"));
    refresh(...periodPaths(periodId));
    return "Due date saved (Needs verification).";
  });
}

export async function uploadComplianceDocAction(entityId: string, periodId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = await fileOf(fd);
    await P.uploadComplianceDocument(actor, { entityId, periodId, kind: str(fd, "kind") as P.DocKind, title: str(fd, "title"), bytes: f.bytes, originalName: f.name });
    refresh(`/compliance/entities/${entityId}`, ...(periodId ? periodPaths(periodId) : []));
    return "Saved to the entity's Tax & Compliance folder.";
  });
}

export async function createVersionAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = await P.createReturnVersion(actor, periodId, { note: str(fd, "note") });
    refresh(...periodPaths(periodId));
    return `Version ${v.version} ready (hash ${v.contentHash.slice(0, 12)}…).`;
  });
}

export async function sendVersionAction(periodId: string, versionId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await P.sendForApproval(actor, versionId);
    refresh(...periodPaths(periodId));
    const held = r.filter((x) => x.status === "HELD").length;
    return r.length === 0 ? "Sent to the portal. No client login can see this entity yet — check portal visibility." : held ? `Sent to the client's portal. ${held} notice(s) HELD — the compliance client-notification switch is off.` : "Sent; the client was notified.";
  });
}

const evidenceOf = (fd: FormData) => ({ confirmationNumber: str(fd, "reference"), documentId: str(fd, "documentId") || null, note: str(fd, "note") });

export async function submittedAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordSubmitted(actor, periodId, { ...evidenceOf(fd), filedOn: str(fd, "filedOn") || null, zeroReturn: fd.get("zeroReturn") === "on", channel: "MANUAL" });
    refresh(...periodPaths(periodId));
    return "Recorded as Submitted (you're the verifier). The next period was created.";
  });
}

export async function acceptedAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordAccepted(actor, periodId, evidenceOf(fd));
    refresh(...periodPaths(periodId));
    return "Recorded as Accepted.";
  });
}

export async function rejectedAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordRejected(actor, periodId, { ...evidenceOf(fd), reason: str(fd, "reason") });
    refresh(...periodPaths(periodId));
    return "Recorded as Rejected. The prep task is open again.";
  });
}

export async function paymentAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordPayment(actor, periodId, evidenceOf(fd));
    refresh(...periodPaths(periodId));
    return "Payment recorded (payment status only).";
  });
}

export async function noPaymentAction(periodId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.markNoPaymentDue(actor, periodId);
    refresh(...periodPaths(periodId));
    return "Marked: no payment due.";
  });
}

export async function notRequiredAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordNotRequired(actor, periodId, { ...evidenceOf(fd), reason: str(fd, "reason") });
    refresh(...periodPaths(periodId));
    return "Recorded as not required, with evidence.";
  });
}

export async function extensionAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.recordExtension(actor, periodId, evidenceOf(fd));
    refresh(...periodPaths(periodId));
    return "Extension recorded. Reminders follow the extended date; payment was still due on the original date.";
  });
}

export async function amendedAction(periodId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await P.startAmended(actor, periodId, str(fd, "reason"));
    refresh(...periodPaths(periodId));
    return { ok: "Amended return started.", next: { href: `/compliance/periods/${r.id}`, label: "Open the amended return" } };
  });
}

export async function publishDocAction(periodId: string, documentId: string, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await P.publishComplianceDocument(actor, documentId, on);
    refresh(...periodPaths(periodId));
    return on ? "Released to the client's Tax & Compliance page." : "Withdrawn from the client's page.";
  });
}

// --- Owner settings and rules -----------------------------------------------------------------

export async function switchAction(key: SwitchKey, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setComplianceSwitch(actor, key, on);
    refresh("/compliance/settings");
    return on ? "Switch turned ON." : "Switch turned OFF.";
  });
}

export async function reminderSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateReminderSettings(actor, { reminderDays: lines(str(fd, "reminderDays")).map(Number), prepTaskDays: Number(str(fd, "prepTaskDays")), defaultPrepLeadDays: Number(str(fd, "defaultPrepLeadDays")), approvalEscalationDays: Number(str(fd, "approvalEscalationDays")), approvalReminderEveryDays: Number(str(fd, "approvalReminderEveryDays")) });
    refresh("/compliance/settings");
    return "Reminder rules saved.";
  });
}

export async function editRuleAction(ruleKey: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = await editRule(actor, ruleKey, { formName: str(fd, "formName"), obligationName: str(fd, "obligationName"), dueRuleCode: str(fd, "dueRuleCode"), dueRuleDescription: str(fd, "dueRuleDescription"), weekendRule: str(fd, "weekendRule"), frequency: str(fd, "frequency"), sourceUrl: str(fd, "sourceUrl"), verificationStatus: str(fd, "verified") === "on" ? "VERIFIED" : "NEEDS_VERIFICATION", notes: str(fd, "notes"), reason: str(fd, "reason") });
    refresh("/compliance/rules");
    return `Saved as version ${v.version}.`;
  });
}

export async function addTemplateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addIndustryTemplate(actor, { key: str(fd, "key"), name: str(fd, "name"), description: str(fd, "description"), ruleKeys: lines(str(fd, "ruleKeys")), activityTags: lines(str(fd, "activityTags")) });
    refresh("/compliance/rules");
    return "Industry template added.";
  });
}

// --- Client portal ----------------------------------------------------------------------------

export async function portalDecisionAction(versionId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const decision = str(fd, "decision") === "APPROVED" ? "APPROVED" : "CHANGES_REQUESTED";
    const h = await headers();
    await P.clientDecide(user, versionId, { decision, signerName: str(fd, "signerName"), comments: str(fd, "comments"), contentHash: str(fd, "contentHash") }, { ip: await clientIp(), userAgent: h.get("user-agent") });
    revalidatePath("/client/compliance");
    return decision === "APPROVED" ? "Thank you — your approval was recorded. Our office will file it and let you know." : "Thank you — we'll make the changes and send an updated version.";
  });
}
