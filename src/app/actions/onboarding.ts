"use server";

import { revalidatePath } from "next/cache";
import { requirePortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { portalUploadDocument } from "@/lib/services/documents";
import {
  acceptRecurringTerms, BUSINESS_DOC_TYPES, reviewBusinessChange, saveDraft, saveEligibility, savePaymentMethod, submitBusinessInfo, type AccountEntry, type BusinessForm,
} from "@/lib/services/business-onboarding";

const refresh = () => {
  revalidatePath("/client/business");
  revalidatePath("/bookkeeping", "layout");
};

function formInput(fd: FormData): BusinessForm {
  const rows = Number(str(fd, "accountRows")) || 0;
  const accounts: AccountEntry[] = [];
  for (let i = 0; i < Math.min(rows, 20); i++) {
    accounts.push({
      id: str(fd, `a${i}_id`) || undefined,
      institution: str(fd, `a${i}_institution`),
      accountType: str(fd, `a${i}_type`),
      last4: str(fd, `a${i}_last4`),
      accessMethod: str(fd, `a${i}_access`),
      remove: fd.get(`a${i}_remove`) === "on",
    });
  }
  const keys = ["legalName", "dba", "ein", "address1", "address2", "city", "state", "postalCode", "startDate", "contactName", "contactEmail", "contactPhone", "payrollProvider", "payrollFrequency"] as const;
  return { ...Object.fromEntries(keys.map((k) => [k, str(fd, k)])), payroll: (str(fd, "payroll") as "YES" | "NO" | "") || "", accounts };
}

export async function eligibilityAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await saveEligibility(user, clientId, str(fd, "relationship"), str(fd, "wantsBookkeeping"));
    refresh();
    return str(fd, "wantsBookkeeping") === "yes" ? "Saved. Next, enter your business information below." : "Saved. Bookkeeping onboarding isn't needed for your account.";
  });
}

/** One form, two buttons: Save & Continue Later, or Submit for review. */
export async function businessInfoAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const form = formInput(fd);
    if (str(fd, "intent") === "draft") {
      const missing = await saveDraft(user, clientId, form);
      refresh();
      return missing.length ? `Saved — Pending Onboarding. Still needed: ${missing.join(", ")}.` : "Saved. Everything required is filled in — submit when you're ready.";
    }
    await submitBusinessInfo(user, clientId, form);
    refresh();
    return { ok: "Submitted. Your information is Pending Review — our office will verify it. You can see it below (read-only).", next: { href: `/client/business?account=${clientId}`, label: "View your submitted information" } };
  });
}

export async function businessDocumentAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose a file to upload.");
    const docType = str(fd, "docType");
    if (!(docType in BUSINESS_DOC_TYPES)) throw new ValidationError("Choose what this document is.");
    await requireClientAccess(user.id, clientId, "upload");
    const doc = await portalUploadDocument(user, { clientId, docType, title: BUSINESS_DOC_TYPES[docType as keyof typeof BUSINESS_DOC_TYPES], bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name });
    refresh();
    return doc.scanStatus === "CLEAN" ? "Uploaded to your business file." : "Uploaded to your business file. It's being checked for viruses before our staff can open it.";
  });
}

export async function paymentMethodAction(clientId: string, input: { sourceId: string; cardholderName: string; verificationToken?: string }): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const card = await savePaymentMethod(user, clientId, input);
    refresh();
    return `Saved with Square: ${card.card_brand ?? "card"} ending in ${card.last_4 ?? "····"}. Saving a card doesn't authorize any charge.`;
  });
}

export async function acceptTermsAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await acceptRecurringTerms(user, clientId, { agree: fd.get("agree") === "on", typedName: str(fd, "typedName") });
    refresh();
    return "Thank you — your recurring-payment authorization is recorded.";
  });
}

// --- Staff (Admin) review ----------------------------------------------------------

export async function reviewChangeAction(changeId: string, decision: "approve" | "reject", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await reviewBusinessChange(actor, changeId, decision, str(fd, "note"));
    refresh();
    return decision === "approve" ? "Approved. The verified business information is updated." : "Returned to the client with your note.";
  });
}
