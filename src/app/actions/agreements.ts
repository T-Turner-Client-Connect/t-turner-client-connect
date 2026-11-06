"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIp, requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { assignContract } from "@/lib/services/contracts";
import type { AgreementOptions } from "@/lib/agreements/catalog";
import {
  addInvoiceToAgreement, approveClause, askToSend, bulkCreate, createAgreement, createClientForAgreement, declineClientAgreement, dismissAttorneyNote, newSigningLink, prepareRenewal, saveClause, saveTemplate,
  sendAgreement, sendSelected, signClientAgreement, updateAgreement, voidAgreement, type SignInput,
} from "@/lib/services/agreements";

const refresh = (id?: string) => {
  revalidatePath("/agreements");
  if (id) revalidatePath(`/agreements/${id}`);
};

function optionsFrom(fd: FormData): Partial<AgreementOptions> {
  try {
    const v = JSON.parse(str(fd, "options") || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new ValidationError("The options couldn't be read. Reload the page and try again.");
  }
}

export async function newClientForAgreementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => {
    const type = str(fd, "clientType");
    const c = await createClientForAgreement(actor, { clientType: type === "BUSINESS" || type === "NONPROFIT" ? type : "INDIVIDUAL", firstName: str(fd, "firstName"), lastName: str(fd, "lastName"), businessName: str(fd, "businessName"), email: str(fd, "email"), phone: str(fd, "phone") });
    id = c.id;
  });
  if (r?.ok && id) redirect(`/agreements/new?client=${id}`);
  return r;
}

export async function createAgreementAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = "";
  const r = await run(async () => {
    id = (await createAgreement(actor, { clientId: str(fd, "clientId"), templateKey: str(fd, "templateKey"), options: optionsFrom(fd), title: str(fd, "title") })).id;
    refresh();
  });
  if (r?.ok && id) redirect(`/agreements/${id}`);
  return r;
}

export async function updateAgreementAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateAgreement(actor, id, { options: optionsFrom(fd), title: str(fd, "title") });
    refresh(id);
    return "Draft saved.";
  });
}

export async function askToSendAction(id: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await askToSend(actor, id);
    refresh(id);
    return "Sent to Tabitha. She'll see it on her Owner's Office overview.";
  });
}

export async function sendAgreementAction(id: string, via: "PORTAL" | "LINK"): Promise<ActionState> {
  const actor = await requireUser();
  let link: string | null = null;
  const r = await run(async () => {
    const res = await sendAgreement(actor, id, via);
    link = res.url;
    refresh(id);
    return res.url ? "Signing link created. Copy it now — it's shown only once, works once and expires in 14 days." : `Sent. ${res.recipients} portal login${res.recipients === 1 ? "" : "s"} notified (a sign-in link only).`;
  });
  return r && link ? { ...r, link } : r;
}

export async function newLinkAction(id: string, email: boolean): Promise<ActionState> {
  const actor = await requireUser();
  let link: string | null = null;
  const r = await run(async () => {
    const res = await newSigningLink(actor, id, { email });
    link = res.url;
    refresh(id);
    return res.emailed ? `New link emailed to ${res.emailed}. Earlier links no longer work.` : "New signing link created. Earlier links no longer work.";
  });
  return r && link ? { ...r, link } : r;
}

export async function voidAgreementAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await voidAgreement(actor, id, str(fd, "reason"));
    refresh(id);
    return "Voided.";
  });
}

export async function addInvoiceAction(id: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const made = await addInvoiceToAgreement(actor, id);
    refresh(id);
    revalidatePath("/owner/invoices");
    return { ok: `Draft invoice${made.length === 1 ? "" : "s"} ${made.map((m) => m.number).join(", ")} created. Nothing was sent.`, next: { href: made.length === 1 ? `/owner/invoices/${made[0].id}` : "/owner/invoices", label: made.length === 1 ? "Open the invoice" : "Open Invoices" } };
  });
}

export async function bulkCreateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let batch = "";
  const r = await run(async () => {
    batch = await bulkCreate(actor, str(fd, "templateKey"), fd.getAll("clientId").map(String));
    refresh();
  });
  if (r?.ok && batch) redirect(`/agreements/bulk?batch=${batch}`);
  return r;
}

export async function sendSelectedAction(batch: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const ids = fd.getAll("agreementId").map(String);
    if (!ids.length) throw new ValidationError("Select the agreements to send.");
    const res = await sendSelected(actor, ids);
    refresh();
    revalidatePath(`/agreements/bulk?batch=${batch}`);
    const sent = res.filter((x) => x.ok).length;
    const links = res.filter((x) => x.url).length;
    const failed = res.filter((x) => !x.ok);
    return `${sent} sent${links ? ` (${links} by signing link — copy each from its agreement page with “New signing link”)` : ""}.${failed.length ? ` ${failed.length} not sent: ${failed.map((f) => f.message).join(" ")}` : ""}`;
  });
}

export async function prepareRenewalAction(id: string): Promise<ActionState> {
  const actor = await requireUser();
  let next = "";
  const r = await run(async () => {
    next = (await prepareRenewal(actor, id)).id;
    refresh(id);
  });
  if (r?.ok && next) redirect(`/agreements/${next}`);
  return r;
}

export async function saveClauseAction(key: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const approve = str(fd, "intent") === "approve";
    const v = await saveClause(actor, key, { body: str(fd, "body"), approve });
    revalidatePath("/agreements/library");
    return approve ? `Saved and approved as version ${v}.` : `Saved as draft version ${v}. It can't be sent until you approve it.`;
  });
}

export async function approveClauseAction(key: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = await approveClause(actor, key);
    revalidatePath("/agreements/library");
    return `Version ${v} approved.`;
  });
}

export async function saveTemplateAction(key: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = await saveTemplate(actor, key, { title: str(fd, "title"), intro: str(fd, "intro"), clauseKeys: fd.getAll("clauseKey").map(String) });
    revalidatePath("/agreements/library");
    return `Template saved as version ${v}. Agreements already drafted keep the version they started with.`;
  });
}

export async function dismissAttorneyNoteAction(): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await dismissAttorneyNote(actor);
    refresh();
    revalidatePath("/agreements/library");
    return "Noted.";
  });
}

/** Firm-wide "Assign a Jotform contract" (older or special contracts built in Jotform). */
export async function assignJotformAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const clientId = str(fd, "clientId");
    if (!clientId) throw new ValidationError("Choose the client.");
    await assignContract(actor, { clientId, title: str(fd, "title"), jotformFormId: str(fd, "formId"), dueAt: dateOrNull(fd, "dueAt") });
    refresh();
    revalidatePath(`/clients/${clientId}`);
    return "Jotform contract assigned. It now appears in their portal.";
  });
}

// --- Client side ------------------------------------------------------------------------

async function signInput(fd: FormData): Promise<SignInput> {
  return {
    acknowledged: fd.getAll("ack").map(String),
    consent: fd.get("consent") === "on",
    fullName: str(fd, "fullName"),
    address: str(fd, "address"),
    phone: str(fd, "phone"),
    email: str(fd, "email"),
    signature: str(fd, "signature"),
    answers: { serviceSelection: str(fd, "q_serviceSelection"), paymentMethod: str(fd, "q_paymentMethod") },
    shownHash: str(fd, "shownHash"),
    ip: await clientIp(),
    userAgent: (await headers()).get("user-agent"),
  };
}

export async function portalSignAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await signClientAgreement({ portalUser: user }, id, await signInput(fd));
    revalidatePath("/client/agreements");
    return "Signed. Thank you — a signed copy is saved in your Documents under Contracts.";
  });
}

export async function portalDeclineAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await declineClientAgreement({ portalUser: user }, id, str(fd, "reason"));
    revalidatePath("/client/agreements");
    return "Declined. We've let T. Turner & Associates know.";
  });
}

export async function linkSignAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await signClientAgreement({ token }, null, await signInput(fd));
    revalidatePath(`/agreement-sign/${token}`);
    return "Signed. Thank you — T. Turner & Associates has your signed agreement.";
  });
}

export async function linkDeclineAction(token: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    await declineClientAgreement({ token }, null, str(fd, "reason"));
    revalidatePath(`/agreement-sign/${token}`);
    return "Declined. We've let T. Turner & Associates know.";
  });
}
