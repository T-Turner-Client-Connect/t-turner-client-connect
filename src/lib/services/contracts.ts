import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { timingSafeEqual } from "node:crypto";
import { sign } from "@/lib/crypto";
import { ValidationError } from "./clients";
import { notifyClientUsers, staffUploadDocument } from "./documents";

/**
 * Jotform contracts. The client opens the assigned form inside the portal;
 * a signed `assignment_ref` is prefilled into a hidden field so a webhook
 * submission can be tied to exactly one assignment. Status only changes when
 * Jotform reports a submission that we verify through the Jotform API —
 * opening the link never counts. The API key stays server-side.
 */
export function jotformConfig() {
  return {
    formBase: (process.env.JOTFORM_FORM_BASE || "https://form.jotform.com").replace(/\/$/, ""),
    apiBase: (process.env.JOTFORM_API_BASE || "https://api.jotform.com").replace(/\/$/, ""),
    apiKey: process.env.JOTFORM_API_KEY || null,
    webhookSecret: process.env.JOTFORM_WEBHOOK_SECRET || null,
    refField: process.env.JOTFORM_REF_FIELD || "assignment_ref",
  };
}

export function jotformStatus() {
  const c = jotformConfig();
  return {
    links: true,
    verifiedCompletion: Boolean(c.apiKey && c.webhookSecret),
    label: c.apiKey && c.webhookSecret ? "Connected (webhook + API verification)" : "Links work; completion tracking needs JOTFORM_API_KEY and JOTFORM_WEBHOOK_SECRET",
  };
}

export function assignmentRef(assignmentId: string) {
  return `${assignmentId}.${sign(`jotform:${assignmentId}`).slice(0, 22)}`;
}

export function parseAssignmentRef(ref: string): string | null {
  const [id, sig] = ref.split(".");
  if (!id || !sig) return null;
  const expected = Buffer.from(sign(`jotform:${id}`).slice(0, 22));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

export function contractFormUrl(a: { id: string; jotformFormId: string }) {
  const c = jotformConfig();
  return `${c.formBase}/${encodeURIComponent(a.jotformFormId)}?${encodeURIComponent(c.refField)}=${encodeURIComponent(assignmentRef(a.id))}`;
}

export async function assignContract(actor: Actor, input: { clientId: string; title: string; jotformFormId: string; dueAt?: Date | null }) {
  const formId = input.jotformFormId.trim();
  if (!/^\d{6,20}$/.test(formId)) throw new ValidationError("Enter the numeric Jotform form ID (from the form's URL).");
  if (!input.title.trim()) throw new ValidationError("Name the contract.");
  const a = await prisma.contractAssignment.create({ data: { clientId: input.clientId, title: input.title.trim().slice(0, 200), jotformFormId: formId, dueAt: input.dueAt ?? null, createdById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "contract.assigned", entityType: "ContractAssignment", entityId: a.id, clientId: input.clientId });
  await notifyClientUsers(input.clientId, "CONTRACT_ASSIGNED", `contract:${a.id}`, "CONTRACTS");
  return a;
}

/** Staff confirmed completion directly in Jotform (used when the API isn't connected). */
export async function staffVerifyContract(actor: Actor, assignmentId: string, submissionId: string) {
  if (!submissionId.trim()) throw new ValidationError("Enter the Jotform submission ID you checked.");
  const a = await prisma.contractAssignment.update({
    where: { id: assignmentId },
    data: { status: "COMPLETED", submissionId: submissionId.trim(), submittedAt: new Date(), completionSource: "staff_verified" },
  });
  await audit(prisma, { actorId: actor.id, action: "contract.staff_verified", entityType: "ContractAssignment", entityId: assignmentId, clientId: a.clientId, details: { submissionId } });
}

export async function attachContractPdf(actor: Actor, assignmentId: string, file: { bytes: Uint8Array; originalName: string }) {
  const a = await prisma.contractAssignment.findUnique({ where: { id: assignmentId } });
  if (!a) throw new ValidationError("Contract not found.");
  const doc = await staffUploadDocument(actor, { clientId: a.clientId, category: "CONTRACTS", title: `${a.title} (completed)`, visibility: "PUBLISHED", bytes: file.bytes, originalName: file.originalName });
  await prisma.contractAssignment.update({ where: { id: assignmentId }, data: { pdfDocumentId: doc.id } });
}

type JotformSubmission = { form_id?: string; id?: string; answers?: Record<string, { name?: string; answer?: unknown }> };

/**
 * Handles a Jotform webhook. The shared secret in the URL proves the call
 * came from our Jotform webhook; the submission is then re-fetched from the
 * Jotform API so nothing in the POST body is trusted on its own.
 */
export async function handleJotformWebhook(secret: string | null, submissionId: string | null): Promise<{ status: number; result: string }> {
  const c = jotformConfig();
  if (!c.webhookSecret || !c.apiKey) return { status: 503, result: "Jotform verification not configured" };
  if (!secret || secret !== c.webhookSecret) return { status: 401, result: "Bad secret" };
  if (!submissionId || !/^\d+$/.test(submissionId)) return { status: 400, result: "Missing submission" };
  const res = await fetch(`${c.apiBase}/submission/${submissionId}`, { headers: { APIKEY: c.apiKey } });
  if (!res.ok) return { status: 502, result: `Jotform API HTTP ${res.status}` };
  const sub = ((await res.json()) as { content?: JotformSubmission }).content;
  const refAnswer = Object.values(sub?.answers ?? {}).find((a) => a.name === c.refField)?.answer;
  const assignmentId = typeof refAnswer === "string" ? parseAssignmentRef(refAnswer) : null;
  if (!assignmentId) return { status: 200, result: "No valid assignment reference; ignored" };
  const a = await prisma.contractAssignment.findUnique({ where: { id: assignmentId } });
  if (!a || a.jotformFormId !== sub?.form_id) return { status: 200, result: "Assignment/form mismatch; ignored" };
  if (a.submissionId === submissionId) return { status: 200, result: "Already recorded" };
  await prisma.contractAssignment.update({
    where: { id: a.id },
    data: { status: "COMPLETED", submissionId, submittedAt: new Date(), completionSource: "jotform_api" },
  });
  await audit(prisma, { actorId: null, action: "contract.completed_via_jotform", entityType: "ContractAssignment", entityId: a.id, clientId: a.clientId, details: { submissionId } });
  return { status: 200, result: "Recorded" };
}
