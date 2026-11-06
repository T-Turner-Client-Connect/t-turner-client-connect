"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser, clientIp } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
// Services, pricing drafts, work status and the owner override were removed from the client page
// (replaced by the Agreements center); earlier pricing agreements stay readable and signable.
import { requestMethodChange, saveFeeSetting, sendAgreement, signAgreement } from "@/lib/services/service-agreements";

const cents = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  if (!v.trim() || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
};
const refreshClient = (clientId: string) => revalidatePath(`/clients/${clientId}`);

export async function sendAgreementAction(clientId: string, agreementId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    // Agreements are sent by Tabitha only (the nonprofit package agreement is sent from its portfolio page).
    if (!(await isReportApprover(actor))) throw new ValidationError("Only Tabitha can send agreements.");
    const r = await sendAgreement(actor, agreementId);
    refreshClient(clientId);
    revalidatePath(`/nonprofits/${clientId}`);
    return r.recipients ? `Sent. ${r.recipients} portal login${r.recipients === 1 ? "" : "s"} notified (a sign-in link only).` : "Sent to the portal. No one with billing access has a portal login yet — invite the client so they can sign.";
  });
}

export async function saveFeeSettingAction(method: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const pct = str(fd, "percent");
    const flat = str(fd, "flat");
    await saveFeeSetting(actor, {
      method,
      enabled: fd.get("enabled") === "on",
      percentBps: pct ? Math.round(Number(pct) * 100) : 0,
      flatCents: flat ? cents(flat) : 0,
      verifiedNote: str(fd, "verifiedNote"),
      providerName: str(fd, "providerName"),
    });
    revalidatePath("/owner/settings");
    return "Saved. It applies to agreements prepared from now on; signed agreements keep their terms.";
  });
}

// --- Client portal ---------------------------------------------------------

export async function signAgreementAction(agreementId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const r = await signAgreement(user, {
      agreementId,
      method: str(fd, "method"),
      signerName: str(fd, "signerName"),
      agreed: fd.get("agree") === "on",
      shownHash: str(fd, "shownHash"),
      ip: await clientIp(),
      userAgent: (await headers()).get("user-agent"),
    });
    revalidatePath("/client/agreements");
    return `Signed. Your total is $${(r.selection.totalCents / 100).toFixed(2)} by ${r.selection.label}. A signed copy is saved in your documents.`;
  });
}

export async function changeMethodAction(agreementId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const a = await requestMethodChange(user, agreementId);
    revalidatePath("/client/agreements");
    return { ok: `A revised agreement (version ${a.version}) is ready. Choose your new payment method and sign it — your current agreement stays in effect until you do.`, next: { href: `/client/agreements?open=${a.id}`, label: "Open the revised agreement" } };
  });
}
