import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { readDocumentBytes } from "./documents";
import { pdfToPages, parseReturnPages } from "@/lib/tax/return-parser/parse";
import { auditReaders, redact, type AuditDoc } from "@/lib/coetha-audit-model";
import { coethaOn } from "./owner-switches";
import {
  AUDIT_KINDS, auditCaseView, buildAuditPackage, linkAuditDocument, refreshAuditStatus, requestAuditDocument, splitNoticeToNewAudit, type AuditKind,
} from "./audit-center";

/**
 * Coetha's audit preparation, step by step in the background (one step per request, so it fits
 * the hosting's time limits; the reading background function and the 10-minute task keep it going):
 *  1. read each notice (agency, year, reference, type, deadline, where/how to respond, the items
 *     examined and documents requested), flagging anything unclear instead of guessing;
 *  2. take the reported amount of each item from the filed return in Client Connect (the return
 *     reader first; otherwise the return's text with identifiers removed);
 *  3. review the client's documents for the year, one at a time, and match each to the items it
 *     supports with the amount it shows (links, never copies);
 *  4. request what is missing, refresh the status, and build the package once every item is
 *     supported. Material differences, unclear notices and missing returns go to Tabitha.
 * Nothing is adjusted to agree, nothing is invented, and nothing is sent to an agency.
 */

type Reading = {
  pending?: boolean;
  notices?: Record<string, { at: string; noticeNumber?: string | null; error?: string; unclear?: string[] }>;
  returnTried?: Record<string, string>;
  reviewed?: Record<string, { at: string; matched: number; kind?: string; error?: string }>;
  flags?: string[];
  blocked?: string | null;
  lastRun?: string;
};

const SKIP_DOC_TYPES = ["AGENCY_LETTER", "AUDIT_PACKAGE", "FEDERAL_RETURN", "STATE_RETURN", "AMENDED_RETURN", "TAX_RETURN"];
const MAX_DOCS_PER_AUDIT = 60;
const MAX_BYTES = 8 * 1024 * 1024;
const FORM_FIELD: [RegExp, string][] = [[/schedule a\b/i, "SA"], [/schedule 1\b/i, "S1"], [/schedule 2\b/i, "S2"], [/schedule 3\b/i, "S3"], [/form 1040\b/i, "F1040"]];

const readingOf = (v: unknown): Reading => (v && typeof v === "object" ? (v as Reading) : {});
async function saveReading(caseId: string, patch: (r: Reading) => Reading) {
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, select: { coethaReading: true } });
  const next = patch(readingOf(c.coethaReading));
  await prisma.noticeCase.update({ where: { id: caseId }, data: { coethaReading: next as never } });
  return next;
}

/** Marks an audit as having work for Coetha and starts the background reader. */
export async function queueAuditWork(caseId: string, opts: { rereview?: boolean } = {}) {
  // New items: documents already reviewed are checked again against them.
  await saveReading(caseId, (r) => ({ ...r, pending: true, ...(opts.rereview ? { reviewed: {} } : {}) }));
  const { kickBackgroundReading } = await import("./coetha-reading");
  await kickBackgroundReading();
}

async function owner(): Promise<Actor | null> {
  const o = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null, user: { active: true } }, select: { user: { select: { id: true, role: true, name: true, email: true } } } });
  return o?.user ?? null;
}

/** A task for Tabitha once per key (the audit-center helper is private; same marker format). */
async function flagForTabitha(caseId: string, key: string, title: string, details: string) {
  const o = await owner();
  if (!o) return;
  const marker = `[audit:${caseId}:${key}]`;
  if (await prisma.task.count({ where: { details: { contains: marker } } })) return;
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { client: { select: { displayName: true } } } });
  await prisma.task.create({ data: { title: `${title} — ${c.client.displayName}`.slice(0, 200), details: `${details}\n\nOpen: /notices/${caseId} ${marker}`, clientId: c.clientId, assigneeId: o.id, createdById: o.id, priority: "HIGH", dueAt: c.responseDueOn } });
}

async function docInput(file: { storageKey: string; encrypted: boolean; mimeType: string; sizeBytes: number }): Promise<AuditDoc | null> {
  if (file.sizeBytes > MAX_BYTES || !["application/pdf", "image/png", "image/jpeg"].includes(file.mimeType)) return null;
  const bytes = await readDocumentBytes(file);
  if (!bytes) return null;
  if (file.mimeType === "application/pdf") {
    const pages = await pdfToPages(bytes).catch(() => null);
    const text = pages?.map((p) => `--- page ${p.page} ---\n${p.text}`).join("\n") ?? "";
    // A text layer goes as text with identifiers removed; a scan goes as the file.
    if (text.replace(/---.*---/g, "").replace(/\s+/g, "").length > 15) return { kind: "text", text: redact(text).slice(0, 60_000) };
  }
  return { kind: "file", mediaType: file.mimeType, base64: Buffer.from(bytes).toString("base64") };
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// --- Step 1: the notices ---------------------------------------------------------------------------

async function readNextNotice(caseId: string, r: Reading): Promise<boolean> {
  const docs = await prisma.document.findMany({ where: { noticeCaseId: caseId, docType: "AGENCY_LETTER", deletedAt: null, scanStatus: "CLEAN", NOT: [{ title: { startsWith: "Audit response" } }, { title: { startsWith: "Agency correspondence" } }] }, include: { file: true }, orderBy: { createdAt: "asc" } });
  const d = docs.find((x) => !r.notices?.[x.id]);
  if (!d?.file) return false;
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { items: true } });
  const input = await docInput(d.file);
  if (!input) {
    await saveReading(caseId, (x) => ({ ...x, notices: { ...x.notices, [d.id]: { at: new Date().toISOString(), error: "not a readable PDF or image" } } }));
    await flagForTabitha(caseId, `notice-unreadable:${d.id}`, "Coetha couldn't read an audit notice", `${d.title}: not a readable PDF or image.`);
    return true;
  }
  let n;
  try {
    n = await auditReaders().notice(input);
  } catch (err) {
    await saveReading(caseId, (x) => ({ ...x, notices: { ...x.notices, [d.id]: { at: new Date().toISOString(), error: err instanceof Error ? err.message.slice(0, 200) : "failed" } } }));
    return true;
  }
  const unclear = [...n.unclear];
  const kind = c.auditKind as AuditKind;
  if (n.agency === "UNCLEAR" || n.agency === "OTHER") unclear.push("The agency on the notice isn't clearly the IRS or a state revenue department.");
  else if ((n.agency === "IRS") !== (kind === "FEDERAL")) unclear.push(`The notice is from ${n.agency === "IRS" ? "the IRS" : `a state (${n.stateCode ?? "?"})`}, but the audit was opened as ${AUDIT_KINDS[kind]}.`);
  if (n.agency === "STATE" && n.stateCode && c.stateCode && n.stateCode.toUpperCase() !== c.stateCode) unclear.push(`The notice is from ${n.stateCode}, not ${c.stateCode}.`);
  if (n.taxYear && c.taxYear && n.taxYear !== c.taxYear) unclear.push(`The notice is for tax year ${n.taxYear}, not ${c.taxYear}.`);

  // A later notice with a different reference and none of the same items is a separate examination.
  const isAdditional = d.title.startsWith("Additional notice");
  if (isAdditional && n.noticeNumber && c.noticeReference && !same(n.noticeNumber, c.noticeReference) && !n.items.some((i) => c.items.some((x) => same(x.label, i.label) || (same(x.schedule, i.form) && same(x.returnLine, i.line))))) {
    await saveReading(caseId, (x) => ({ ...x, notices: { ...x.notices, [d.id]: { at: new Date().toISOString(), noticeNumber: n.noticeNumber } } }));
    const sep = await splitNoticeToNewAudit(null, d.id, `Notice ${n.noticeNumber} examines different items than ${c.noticeReference}.`);
    await queueAuditWork(sep.id);
    return true;
  }

  // What the notice says becomes the case record (an earlier verified value is kept; differences are flagged).
  const due = n.responseDeadline && /^\d{4}-\d{2}-\d{2}$/.test(n.responseDeadline) ? new Date(`${n.responseDeadline}T12:00:00Z`) : null;
  if (due && c.responseDueOn && c.responseDueOn.toISOString().slice(0, 10) !== n.responseDeadline && !isAdditional) unclear.push(`The notice's response date (${n.responseDeadline}) differs from the date entered (${c.responseDueOn.toISOString().slice(0, 10)}); the notice's date is used.`);
  await prisma.noticeCase.update({
    where: { id: caseId },
    data: {
      auditType: c.auditType ?? n.auditType,
      noticeReference: c.noticeReference ?? n.noticeNumber,
      respondTo: c.respondTo ?? n.respondTo,
      responseInstructions: c.responseInstructions ?? n.instructions,
      responseDueOn: due && (!c.responseDueOn || !isAdditional || due > c.responseDueOn) ? due : c.responseDueOn,
    },
  });
  let position = c.items.length;
  let added = false;
  for (const it of n.items) {
    const match = c.items.find((x) => same(x.label, it.label) || (it.form && it.line && same(x.schedule, it.form) && same(x.returnLine, it.line)));
    if (match) {
      if (it.documentsRequested && !match.requested?.includes(it.documentsRequested)) await prisma.auditItem.update({ where: { id: match.id }, data: { requested: [match.requested, it.documentsRequested].filter(Boolean).join(" · ").slice(0, 1000) } });
    } else {
      const created = await prisma.auditItem.create({ data: { caseId, position: position++, label: it.label.slice(0, 200), schedule: it.form?.slice(0, 60) ?? null, returnLine: it.line?.slice(0, 40) ?? null, requested: it.documentsRequested?.slice(0, 1000) ?? null, note: it.amountOnNotice != null ? `Amount cited on the notice: $${it.amountOnNotice.toFixed(2)}` : null } });
      c.items.push(created);
      added = true;
      await audit(prisma, { actorId: null, action: "audit.item_added", entityType: "AuditItem", entityId: created.id, clientId: c.clientId, details: { caseId, label: created.label, by: "COETHA", fromNotice: d.id } });
    }
  }
  await saveReading(caseId, (x) => ({ ...x, notices: { ...x.notices, [d.id]: { at: new Date().toISOString(), noticeNumber: n.noticeNumber, unclear } }, ...(added ? { reviewed: {} } : {}) }));
  await audit(prisma, { actorId: null, action: "audit.notice_read", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { by: "COETHA", documentId: d.id, noticeNumber: n.noticeNumber, items: n.items.length, unclear } });
  if (unclear.length) await flagForTabitha(caseId, `unclear:${d.id}`, "Coetha flagged the audit notice", `Coetha read the notice and could not determine with certainty:\n- ${unclear.join("\n- ")}`);
  return true;
}

// --- Step 2: reported amounts from the filed return ------------------------------------------------

async function readReturnAmounts(caseId: string, r: Reading): Promise<boolean> {
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { items: { orderBy: { position: "asc" } } } });
  const todo = c.items.filter((i) => i.reportedCents == null && !r.returnTried?.[i.id]);
  if (!todo.length) return false;
  const mark = (note: string) => saveReading(caseId, (x) => ({ ...x, returnTried: { ...x.returnTried, ...Object.fromEntries(todo.map((i) => [i.id, note])) } }));
  const ret = c.filingId ? await prisma.document.findFirst({ where: { clientId: c.clientId, filingId: c.filingId, filingDocType: "RETURN", deletedAt: null, supersededAt: null, scanStatus: "CLEAN" }, include: { file: true }, orderBy: { createdAt: "desc" } }) : null;
  if (!ret?.file) {
    await mark("no filed return");
    await flagForTabitha(caseId, "no-return", "Filed return not in Client Connect", `Coetha needs the filed ${c.taxYear} ${c.auditKind === "FEDERAL" ? "federal" : c.stateCode} return to read the reported amounts. Upload it to the client's tax filings (or enter the amounts on the audit page).`);
    return true;
  }
  const bytes = await readDocumentBytes(ret.file);
  const pages = bytes ? await pdfToPages(bytes).catch(() => null) : null;
  if (!pages?.some((p) => p.text.trim().length > 40)) {
    await mark("return is a scan");
    await flagForTabitha(caseId, "return-scan", "Filed return is a scan", "The filed return has no text layer, and Coetha doesn't send a full return image (it carries Social Security numbers). Enter the reported amounts on the audit page, or upload the electronic return.");
    return true;
  }
  // The return reader first (exact printed lines it knows).
  const parsed = parseReturnPages(pages);
  const readings = parsed.readings as Record<string, { status: string; value?: number }>;
  const left: typeof todo = [];
  for (const i of todo) {
    const form = FORM_FIELD.find(([re]) => re.test(i.schedule ?? i.label))?.[1];
    const reading = form && i.returnLine ? readings[`${form}.${i.returnLine.replace(/\D+$/, "")}`] : undefined;
    if (reading?.status === "found" && typeof reading.value === "number") {
      await prisma.auditItem.update({ where: { id: i.id }, data: { reportedCents: reading.value, note: [i.note, `Reported amount read from the filed return (${form} line ${i.returnLine}).`].filter(Boolean).join(" ") } });
      await audit(prisma, { actorId: null, action: "audit.item_updated", entityType: "AuditItem", entityId: i.id, clientId: c.clientId, details: { by: "COETHA", reportedCents: reading.value, source: "return reader" } });
    } else left.push(i);
  }
  if (left.length) {
    const text = redact(pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join("\n")).slice(0, 80_000);
    try {
      const out = await auditReaders().returnAmounts(text, left.map((i, n) => ({ ref: `I${n + 1}`, label: i.label, form: i.schedule, line: i.returnLine })));
      for (const [n, i] of left.entries()) {
        const a = out.items.find((x) => x.ref === `I${n + 1}`);
        if (a?.amount != null) {
          const cents = Math.round(a.amount * 100);
          await prisma.auditItem.update({ where: { id: i.id }, data: { reportedCents: cents, note: [i.note, `Reported amount read from the filed return${a.where ? ` (${a.where})` : ""}.`].filter(Boolean).join(" ").slice(0, 1000) } });
          await audit(prisma, { actorId: null, action: "audit.item_updated", entityType: "AuditItem", entityId: i.id, clientId: c.clientId, details: { by: "COETHA", reportedCents: cents, where: a.where } });
        }
      }
    } catch { /* tried; the item shows "reported amount not entered" and is flagged at the end */ }
  }
  await mark("read");
  return true;
}

// --- Step 3: supporting documents ------------------------------------------------------------------

async function candidates(caseId: string) {
  const c = await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId }, include: { items: { include: { requests: { select: { id: true } } } } } });
  const requestIds = c.items.flatMap((i) => i.requests.map((r) => r.id));
  const docs = await prisma.document.findMany({
    where: {
      clientId: c.clientId, deletedAt: null, scanStatus: "CLEAN", filingDocType: null, supersededAt: null,
      category: { notIn: ["IDENTITY"] },
      OR: [{ docType: null }, { docType: { notIn: SKIP_DOC_TYPES } }],
      AND: [{ OR: [{ year: c.taxYear }, { noticeCaseId: caseId }, ...(requestIds.length ? [{ requestId: { in: requestIds } }] : [])] }],
    },
    include: { file: true },
    orderBy: { createdAt: "asc" },
    take: MAX_DOCS_PER_AUDIT,
  });
  // Answers to this audit's requests first, then the client's audit uploads, then the rest of the year.
  const rank = (d: (typeof docs)[number]) => (d.requestId && requestIds.includes(d.requestId) ? 0 : d.noticeCaseId === caseId ? 1 : 2);
  return { c, docs: docs.sort((a, b) => rank(a) - rank(b)), requestIds };
}

async function reviewNextDocument(caseId: string, r: Reading): Promise<boolean> {
  const { c, docs } = await candidates(caseId);
  if (!c.items.length) return false;
  const d = docs.find((x) => !r.reviewed?.[x.id]);
  if (!d?.file) return false;
  const input = await docInput(d.file);
  const items = c.items.map((i, n) => ({ ref: `I${n + 1}`, id: i.id, label: i.label, requested: i.requested }));
  if (!input) {
    await saveReading(caseId, (x) => ({ ...x, reviewed: { ...x.reviewed, [d.id]: { at: new Date().toISOString(), matched: 0, error: "not a readable PDF or image" } } }));
    return true;
  }
  let out;
  try {
    out = await auditReaders().support(input, c.taxYear, items);
  } catch (err) {
    await saveReading(caseId, (x) => ({ ...x, reviewed: { ...x.reviewed, [d.id]: { at: new Date().toISOString(), matched: 0, error: err instanceof Error ? err.message.slice(0, 200) : "failed" } } }));
    return true;
  }
  let matched = 0;
  const wrongYear = out.taxYearShown != null && c.taxYear != null && out.taxYearShown !== c.taxYear;
  if (!wrongYear) {
    for (const m of out.matches) {
      const it = items.find((i) => i.ref === m.ref);
      if (!it) continue;
      await linkAuditDocument(null, it.id, d.id, { amount: m.amount != null ? m.amount.toFixed(2) : undefined, note: `${out.kind}: ${m.why}`.slice(0, 500) }, "COETHA");
      matched++;
    }
  }
  await saveReading(caseId, (x) => ({ ...x, reviewed: { ...x.reviewed, [d.id]: { at: new Date().toISOString(), matched, kind: out.kind } } }));
  await audit(prisma, { actorId: null, action: "audit.document_reviewed", entityType: "NoticeCase", entityId: caseId, clientId: c.clientId, details: { by: "COETHA", documentId: d.id, kind: out.kind, matched, wrongYear } });
  // A client's answer to a request that supports nothing: the request stays open for review, and Tabitha is told once.
  if (!matched && d.requestId) await flagForTabitha(caseId, `nomatch:${d.id}`, "An uploaded audit document doesn't support the item", `${d.title}${wrongYear ? ` is for ${out.taxYearShown}, not ${c.taxYear}` : " doesn't show support for the requested item"}. Coetha left the request open.`);
  return true;
}

// --- Step 4: what's missing, status, package -------------------------------------------------------

const usd = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function finish(caseId: string) {
  const v = (await auditCaseView(caseId))!;
  for (const i of v.items) {
    const active = i.requests.some((q) => q.status === "OPEN" || q.status === "SUBMITTED");
    if (active) continue;
    if (i.check.state === "MISSING") await requestAuditDocument(null, i.id, { title: i.requested ? `For ${i.label}: ${i.requested}`.slice(0, 200) : `Documents supporting ${i.label}`, instructions: i.reportedCents != null ? `Your return reports ${usd(i.reportedCents)} for this item.` : undefined });
    else if (i.check.state === "DIFFERENCE" && (i.check.differenceCents ?? 0) > 0) await requestAuditDocument(null, i.id, { title: `Documents for the remaining ${usd(i.check.differenceCents!)} of ${i.label}`.slice(0, 200), instructions: `Your return reports ${usd(i.reportedCents ?? 0)}; the documents on file support ${usd(i.check.supportedCents ?? 0)}.` });
    else if (i.check.state === "NOT_READ") await flagForTabitha(caseId, `notread:${i.id}`, "Reported amount needed for an audit item", `${i.label}: Coetha couldn't read the amount reported on the filed return. Enter it on the audit page.`);
  }
  const status = await refreshAuditStatus(caseId);
  if (status === "READY_FOR_FINAL_REVIEW") {
    const latest = await prisma.auditItemDocument.findFirst({ where: { item: { caseId } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    const itemChange = await prisma.auditItem.findFirst({ where: { caseId }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
    const pkg = v.packageDocumentId ? await prisma.document.findUnique({ where: { id: v.packageDocumentId }, select: { createdAt: true } }) : null;
    const changed = [latest?.createdAt, itemChange?.updatedAt].filter(Boolean).some((t) => !pkg || t! > pkg.createdAt);
    const o = await owner();
    if (changed && o) await buildAuditPackage(o, caseId);
  }
}

/** One step of Coetha's audit work on one case. Returns what was done, or null when it's finished. */
export async function stepAudit(caseId: string): Promise<string | null> {
  const c = await prisma.noticeCase.findUnique({ where: { id: caseId } });
  if (!c?.auditKind || ["SUBMITTED", "AWAITING_AGENCY", "CLOSED"].includes(c.auditStatus ?? "")) return null;
  const r = readingOf(c.coethaReading);
  const blocked = !(await coethaOn()) ? "Coetha is switched off" : !process.env.ANTHROPIC_API_KEY?.trim() ? "no Anthropic API key" : (await prisma.coethaOptOut.count({ where: { clientId: c.clientId } })) ? "the client prefers no Coetha" : null;
  if (blocked) {
    await saveReading(caseId, (x) => ({ ...x, pending: false, blocked }));
    await flagForTabitha(caseId, `blocked:${blocked}`, "Coetha isn't preparing this audit", `Coetha can't work this audit: ${blocked}. The office prepares it from the audit page.`);
    return null;
  }
  if (await readNextNotice(caseId, r)) return "notice";
  if (await readReturnAmounts(caseId, readingOf((await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId } })).coethaReading))) return "return";
  if (await reviewNextDocument(caseId, readingOf((await prisma.noticeCase.findUniqueOrThrow({ where: { id: caseId } })).coethaReading))) return "document";
  await finish(caseId);
  await saveReading(caseId, (x) => ({ ...x, pending: false, blocked: null, lastRun: new Date().toISOString() }));
  return null;
}

/** For the background reader: the next audit with work, one step (held by a short lease). */
export async function workAuditOnce(now = new Date()): Promise<boolean> {
  const cases = await prisma.noticeCase.findMany({
    where: { auditKind: { not: null }, auditStatus: { notIn: ["SUBMITTED", "AWAITING_AGENCY", "CLOSED"] }, OR: [{ coethaReading: { path: ["pending"], equals: true } }, { items: { some: { requests: { some: { status: "SUBMITTED" } } } } }] },
    select: { id: true, coethaReading: true },
    orderBy: { updatedAt: "asc" },
    take: 5,
  });
  for (const c of cases) {
    const name = `audit:${c.id}`;
    const until = new Date(now.getTime() + 4 * 60_000);
    const got = await prisma.jobLock.updateMany({ where: { name, lockedUntil: { lt: now } }, data: { lockedUntil: until } });
    if (!got.count) {
      try { await prisma.jobLock.create({ data: { name, lockedUntil: until } }); } catch { continue; }
    }
    try {
      // A case picked up only because the client answered a request has pending work again.
      if (!readingOf(c.coethaReading).pending) await saveReading(c.id, (x) => ({ ...x, pending: true }));
      await stepAudit(c.id);
      return true;
    } finally {
      await prisma.jobLock.update({ where: { name }, data: { lockedUntil: new Date(0) } }).catch(() => {});
    }
  }
  return false;
}

export async function auditWorkLeft() {
  return prisma.noticeCase.count({ where: { auditKind: { not: null }, auditStatus: { notIn: ["SUBMITTED", "AWAITING_AGENCY", "CLOSED"] }, coethaReading: { path: ["pending"], equals: true } } });
}

/** Tests and local runs: every step of one audit until Coetha is done (or the step limit). */
export async function workAudit(caseId: string, maxSteps = 100) {
  const steps: string[] = [];
  await saveReading(caseId, (x) => ({ ...x, pending: true }));
  for (let n = 0; n < maxSteps; n++) {
    const s = await stepAudit(caseId);
    if (!s) break;
    steps.push(s);
  }
  return steps;
}
