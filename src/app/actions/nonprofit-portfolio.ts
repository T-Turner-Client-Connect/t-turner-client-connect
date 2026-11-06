"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { assertAdmin } from "@/lib/auth/actor";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  addChecklistItem, addOfficer, applyStateTemplate, assignPackage, CATEGORIES, ensurePortfolio, recordIrsEvent, releaseItemFile, removeOfficer, resendReleaseNotice, saveClassification, savePortfolio,
  savePackage, saveStateTemplate, updateChecklistItem, uploadItemFile, type PackageDeliverable, type TemplateItem,
} from "@/lib/services/nonprofit-portfolio";

const refresh = (orgId: string) => revalidatePath(`/nonprofits/${orgId}`);
const FIELDS = ["legalName", "formationState", "formationDate", "ein", "sosEntityNumber", "sosFilingDate", "registeredAgent", "registeredAgentAddress", "classification", "agStatus", "agNote", "agRenewalDate", "samStatus", "uei", "samExpiresOn", "mission", "programs"];

export async function openPortfolioAction(orgId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ensurePortfolio(actor, orgId);
    refresh(orgId);
    return { ok: "Portfolio opened.", next: { href: `/nonprofits/${orgId}`, label: "Open Nonprofit Portfolio" } };
  });
}

export async function savePortfolioAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await savePortfolio(actor, orgId, Object.fromEntries(FIELDS.map((k) => [k, str(fd, k) || undefined])));
    refresh(orgId);
    return "Saved.";
  });
}

export async function addOfficerAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addOfficer(actor, orgId, { name: str(fd, "name"), role: str(fd, "role"), termStart: str(fd, "termStart") || undefined, termEnd: str(fd, "termEnd") || undefined });
    refresh(orgId);
    return "Added.";
  });
}

export async function removeOfficerAction(orgId: string, officerId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeOfficer(actor, officerId);
    refresh(orgId);
    return "Removed (kept in history).";
  });
}

export async function irsEventAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordIrsEvent(actor, orgId, { kind: str(fd, "kind"), at: dateOrNull(fd, "at"), note: str(fd, "note"), reference: str(fd, "reference") });
    refresh(orgId);
    return "Recorded.";
  });
}

export async function applyTemplateAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await applyStateTemplate(actor, orgId, str(fd, "state"));
    refresh(orgId);
    return `${r.added} requirement${r.added === 1 ? "" : "s"} added.${r.verified ? "" : " This state's requirements haven't been verified against official sources yet — confirm each one."}`;
  });
}

export async function addItemAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addChecklistItem(actor, orgId, { label: str(fd, "label"), category: str(fd, "category"), section: str(fd, "section") || undefined });
    refresh(orgId);
    return "Added.";
  });
}

export async function itemStatusAction(orgId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateChecklistItem(actor, itemId, { status: str(fd, "status"), responsibleId: str(fd, "responsibleId") || null, filingReference: str(fd, "filingReference"), staffNote: str(fd, "staffNote") });
    refresh(orgId);
    return "Updated.";
  });
}

export async function itemUploadAction(orgId: string, itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.");
    await uploadItemFile(actor, itemId, { origin: str(fd, "origin"), bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name });
    refresh(orgId);
    return "Saved (staff-only). Release it when it's approved for the client.";
  });
}

export async function releaseFileAction(orgId: string, fileId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await releaseItemFile(actor, fileId);
    refresh(orgId);
    return `Released to the client's portfolio. Email notice: ${r.sent} sent${r.failed ? `, ${r.failed} failed (see history; you can resend)` : ""}${r.skipped ? `, ${r.skipped} skipped (no login or email notices off)` : ""}.`;
  });
}

export async function resendNoticeAction(orgId: string, fileId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await resendReleaseNotice(actor, fileId);
    refresh(orgId);
    return `Notice resent: ${r.sent} sent${r.failed ? `, ${r.failed} failed` : ""}.`;
  });
}

// --- Settings (Admins) ---------------------------------------------------------

export async function saveClassificationAction(key: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    assertAdmin(actor);
    await saveClassification(actor, key || str(fd, "key").toUpperCase(), { label: str(fd, "label"), process: str(fd, "process"), form: str(fd, "form"), sourceUrl: str(fd, "sourceUrl"), active: fd.get("active") === "on", verifiedNote: str(fd, "verifiedNote"), markVerified: fd.get("markVerified") === "on" });
    revalidatePath("/nonprofits/settings");
    return "Saved.";
  });
}

/** One requirement per line: key | description | category | required (yes/no) | note | source URL */
export async function saveStateTemplateAction(state: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    assertAdmin(actor);
    const items: TemplateItem[] = str(fd, "items").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const [key, label, category, required, note, sourceUrl] = line.split("|").map((x) => x.trim());
      if (!key || !label) throw new ValidationError(`Each line needs a key and a description: “${line.slice(0, 60)}”`);
      return { key, label, category: (category?.toUpperCase() in CATEGORIES ? category.toUpperCase() : "OTHER") as TemplateItem["category"], required: !/^no$/i.test(required ?? ""), note: note || undefined, sourceUrl: sourceUrl || null };
    });
    await saveStateTemplate(actor, state, { items, verifiedNote: str(fd, "verifiedNote"), markVerified: fd.get("markVerified") === "on" });
    revalidatePath("/nonprofits/settings");
    return "Saved.";
  });
}

// --- Packages ---------------------------------------------------------------------

const money = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() && Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

export async function assignPackageAction(orgId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await assignPackage(actor, orgId, { packageKey: str(fd, "packageKey"), govFeeCents: money(str(fd, "govFee")), priceCents: money(str(fd, "price")) });
    refresh(orgId);
    return { ok: `Package assigned. ${r.added} document${r.added === 1 ? "" : "s"} added to the checklist, and a draft pricing agreement is ready — package work begins after the client signs it.`, next: { href: `/nonprofits/${orgId}`, label: "Review and send the package agreement" } };
  });
}

/** One deliverable per line: key | description | section (FORMATION, IRS, STATE, SAM, GRANT, OTHER). State prices: one per line, e.g. GA=3750. */
export async function savePackageAction(key: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const deliverables = str(fd, "deliverables").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const [k, label, section] = line.split("|").map((x) => x.trim());
      return { key: k, label, section: (section ?? "OTHER").toUpperCase() } as PackageDeliverable;
    });
    const statePrices = Object.fromEntries(str(fd, "statePrices").split(/[\n,]/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [st, v] = l.split("=").map((x) => x.trim());
      return [st.toUpperCase(), money(v ?? "") ?? NaN];
    }));
    await savePackage(actor, key || str(fd, "key").toUpperCase(), { name: str(fd, "name"), priceCents: money(str(fd, "price")) ?? 0, priceNote: str(fd, "priceNote"), statePrices, govFeesMode: str(fd, "govFeesMode"), deliverables, grantDisclaimer: fd.get("grantDisclaimer") === "on", active: fd.get("active") === "on" });
    revalidatePath("/nonprofits/settings");
    return "Saved. It applies to packages assigned from now on; signed agreements keep their terms.";
  });
}
