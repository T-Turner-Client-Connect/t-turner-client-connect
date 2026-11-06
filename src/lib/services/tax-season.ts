import "server-only";
import { prisma } from "@/lib/prisma";
import { fmtDate } from "@/lib/format";
import { seasonSteps, type SeasonFiling } from "@/lib/tax/season-steps";
import { DOCUMENTS_STATUS, taxYearStatuses } from "./tax-center";
import { summaryRequirement } from "./tax-summary";

/** The Taxes tab's step-by-step progress for one tax year, from the statuses already kept (no new data). */
export async function taxSeasonProgress(clientId: string, year: number) {
  const [[status], client, filings] = await Promise.all([
    taxYearStatuses(clientId, [year]),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { clientType: true } }),
    prisma.filingRecord.findMany({
      where: { clientId, taxYear: year, filingType: { in: ["ORIGINAL", "AMENDED"] } },
      include: { documents: { where: { deletedAt: null, filingDocType: "RETURN", OR: [{ visibility: "PUBLISHED" }, { reviewStatus: "APPROVED" }] }, select: { publishedAt: true, reviewedAt: true, createdAt: true } } },
    }),
  ]);
  const strip = await yearStrip(clientId, year, status);
  const step = (k: string) => strip.find((s) => s.key === k)?.done ?? false;
  // With no filing yet, an individual's federal return is what the summary rule applies to.
  const keys = filings.length ? filings : client.clientType === "INDIVIDUAL" ? [{ clientId, taxYear: year, returnType: "1040", jurisdiction: "FEDERAL", filingType: "ORIGINAL" }] : [];
  const reqs = await Promise.all(keys.map((f) => summaryRequirement({ ...f, clientId })));
  const ownerFilings = filings.length
    ? await prisma.filingStatusEvent.count({ where: { filingId: { in: filings.map((f) => f.id) }, field: "FILING", verificationNote: { contains: "Owner filing" } } })
    : 0;
  const seasonFilings: SeasonFiling[] = filings.map((f) => {
    const sent = f.documents.map((d) => d.publishedAt ?? d.reviewedAt ?? d.createdAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return { jurisdiction: f.jurisdiction, filingType: f.filingType, filingStatus: f.filingStatus, prepStatus: f.prepStatus, returnSentAt: sent };
  });
  return seasonSteps(
    {
      year,
      questionnaireDone: step("questionnaire"),
      documentsDone: step("documents"),
      summaryRequired: reqs.some((r) => r.required),
      summaryApproved: reqs.some((r) => r.required && !!r.approved),
      ownerFilingRecorded: ownerFilings > 0,
      filings: seasonFilings,
    },
    fmtDate,
  );
}

type YearStatus = Awaited<ReturnType<typeof taxYearStatuses>>[number];
export type StripStep = { key: string; label: string; value: string; done: boolean };

/**
 * The Taxes-tab year header strip: Questionnaire · Documents · Preparation ·
 * Filing · Acceptance, read-only, from the statuses the client's My Tax Center
 * already uses (so the portal is unchanged). Staff side only, Documents comes
 * from the year's tax-document requests when there are any; otherwise it is
 * the manual value (set under Filing history › More options › Client progress note).
 */
export async function yearStrip(clientId: string, year: number, status?: YearStatus): Promise<StripStep[]> {
  const y = status ?? (await taxYearStatuses(clientId, [year]))[0];
  const reqs = await prisma.documentRequest.findMany({ where: { clientId, taxYear: year, kind: "YEAR_END", status: { in: ["OPEN", "SUBMITTED", "ACCEPTED"] } }, select: { status: true } });
  const accepted = y.steps.find((s) => s.key === "acceptance")?.done ?? false;
  return y.steps.map((s) => {
    if (s.key !== "documents" || !reqs.length || accepted) return { key: s.key, label: s.label, value: s.value, done: s.done };
    const got = reqs.filter((r) => r.status !== "OPEN").length;
    const done = got === reqs.length;
    return { key: s.key, label: s.label, value: done ? DOCUMENTS_STATUS.ALL_RECEIVED : `${got} of ${reqs.length} requested received`, done };
  });
}

/**
 * One line for Step 1 when an identity document is missing or expired
 * ("Driver's license and Social Security card not on file"); null when all
 * are on file (or pending verification), or the viewer can't see identity status.
 */
export async function identityGapLine(clientId: string, user: { id: string; role: string }): Promise<string | null> {
  const { canStaffViewIdentity, identityChecklist } = await import("./identity");
  if (!(await canStaffViewIdentity(user, clientId))) return null;
  const list = await identityChecklist(clientId);
  const and = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  const parts = list
    .map(({ person, items }) => {
      const needed = items.filter((i) => i.state === "NEEDED").map((i) => i.label);
      const expired = items.filter((i) => i.state === "EXPIRED" && !i.replacementPending).map((i) => i.label);
      const text = [needed.length ? `${and(needed)} not on file` : "", expired.length ? `${and(expired)} expired` : ""].filter(Boolean).join("; ");
      return text ? { name: person.name, text } : null;
    })
    .filter((x): x is { name: string; text: string } => !!x);
  if (!parts.length) return null;
  if (list.length === 1) return parts[0].text.charAt(0).toUpperCase() + parts[0].text.slice(1);
  return parts.map((p) => `${p.name}: ${p.text}`).join(" · ");
}
