"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireUser, clientIp } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  createService, ownerOverride, prepareAgreement, recordPaymentAuthorization, requestMethodChange, saveFeeSetting, sendAgreement, setServiceStatus, signAgreement, voidAgreement,
} from "@/lib/services/service-agreements";

const cents = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  if (!v.trim() || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
};
const refreshClient = (clientId: string) => revalidatePath(`/clients/${clientId}`);

export async function createServiceAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const year = str(fd, "taxYear");
    const s = await createService(actor, { clientId, type: str(fd, "type"), taxYear: year ? Number(year) : null, periodLabel: str(fd, "periodLabel"), title: str(fd, "title"), description: str(fd, "description"), assignedToId: str(fd, "assignedToId") || null, requiresPaymentAuth: fd.get("requiresPaymentAuth") === "on" });
    refreshClient(clientId);
    return `Added “${s.title}”. Next: prepare its pricing agreement.`;
  });
}

export async function prepareAgreementAction(clientId: string, serviceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const lines = [0, 1, 2, 3]
      .map((i) => ({ label: str(fd, `label${i}`), raw: str(fd, `amount${i}`) }))
      .filter((l) => l.label || l.raw)
      .map((l) => {
        const c = cents(l.raw);
        if (!l.label || Number.isNaN(c)) throw new ValidationError("Give each charge a description and an amount.");
        return { label: l.label, cents: c };
      });
    const rtFee = str(fd, "refundTransferFee");
    const a = await prepareAgreement(actor, serviceId, {
      lines,
      paymentTerms: str(fd, "paymentTerms"),
      refundTransfer: fd.get("refundTransferEligible") === "on" ? { eligible: true, feeCents: rtFee ? cents(rtFee) || 0 : 0 } : null,
    });
    refreshClient(clientId);
    return `Draft agreement version ${a.version} saved. Review it, then send it to the client.`;
  });
}

export async function sendAgreementAction(clientId: string, agreementId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await sendAgreement(actor, agreementId);
    refreshClient(clientId);
    return r.recipients ? `Sent. ${r.recipients} portal login${r.recipients === 1 ? "" : "s"} notified (a sign-in link only).` : "Sent to the portal. No one with billing access has a portal login yet — invite the client so they can sign.";
  });
}

export async function voidAgreementAction(clientId: string, agreementId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await voidAgreement(actor, agreementId, str(fd, "reason"));
    refreshClient(clientId);
    return "Voided.";
  });
}

export async function serviceStatusAction(clientId: string, serviceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setServiceStatus(actor, serviceId, str(fd, "status"));
    refreshClient(clientId);
    return "Status updated.";
  });
}

export async function paymentAuthAction(clientId: string, serviceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordPaymentAuthorization(actor, serviceId, str(fd, "note"));
    refreshClient(clientId);
    return "Payment authorization recorded.";
  });
}

export async function ownerOverrideAction(clientId: string, serviceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerOverride(actor, serviceId, str(fd, "reason"));
    refreshClient(clientId);
    return "Override recorded. Work may begin.";
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
