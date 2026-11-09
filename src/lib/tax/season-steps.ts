/**
 * The staff Taxes tab in tax-season order: Step 1 client info & documents,
 * Step 2 prepare & client approval, Step 3 Finish & Send. A step that is done
 * for the selected tax year starts collapsed ("✓ Done"), so the first open
 * section on load is the next thing to do. Pure: the inputs are the statuses
 * Client Connect already keeps (see taxSeasonProgress).
 */

export type SeasonFiling = {
  jurisdiction: string;
  filingType: string;
  filingStatus: string;
  prepStatus: string;
  /** When this filing's return copy reached the client (published, or released by Tabitha); null if not yet. */
  returnSentAt: Date | null;
};

export type SeasonInput = {
  year: number;
  questionnaireDone: boolean;
  documentsDone: boolean;
  /** Any return for the year needs a client-approved summary before Tabitha files it. */
  summaryRequired: boolean;
  summaryApproved: boolean;
  /** Tabitha recorded the filing through the owner gate (with the approved summary or a stated override). */
  ownerFilingRecorded: boolean;
  /** Original and amended returns for the year (extensions have no return copy and don't count). */
  filings: SeasonFiling[];
};

export type StepKey = "info" | "prep" | "send";
export type SeasonSteps = {
  year: number;
  done: Record<StepKey, boolean>;
  /** The first step still to do (null when all are done). */
  next: StepKey | null;
  allDone: boolean;
  /** Set when every step is done, e.g. "2025: Federal + AL returns sent to client on Apr 15, 2026". */
  doneLine: string | null;
  sentOn: Date | null;
};

const ORDER: StepKey[] = ["info", "prep", "send"];

export function seasonSteps(input: SeasonInput, fmt: (d: Date) => string): SeasonSteps {
  const returns = input.filings.filter((f) => f.filingType === "ORIGINAL" || f.filingType === "AMENDED");
  const allAccepted = returns.length > 0 && returns.every((f) => f.filingStatus === "ACCEPTED");
  const info = input.questionnaireDone && input.documentsDone;
  // An accepted return means preparation and approval are behind the client (e.g. filed before Client Connect).
  const prep = input.summaryApproved || input.ownerFilingRecorded || allAccepted || (!input.summaryRequired && returns.length > 0 && returns.every((f) => f.prepStatus === "READY_TO_FILE" || f.filingStatus !== "NOT_SUBMITTED"));
  const send = allAccepted && returns.every((f) => f.returnSentAt);
  const done = { info, prep, send };
  const next = ORDER.find((k) => !done[k]) ?? null;
  const sentOn = send ? new Date(Math.max(...returns.map((f) => f.returnSentAt!.getTime()))) : null;
  let doneLine: string | null = null;
  if (!next && sentOn) {
    const names = Array.from(new Set([...returns].sort((a, b) => (a.jurisdiction === "FEDERAL" ? -1 : b.jurisdiction === "FEDERAL" ? 1 : a.jurisdiction.localeCompare(b.jurisdiction))).map((f) => (f.jurisdiction === "FEDERAL" ? "Federal" : f.jurisdiction))));
    const amended = returns.every((f) => f.filingType === "AMENDED") ? "amended " : "";
    doneLine = `${input.year}: ${names.join(" + ")} ${amended}${returns.length === 1 ? "return" : "returns"} sent to client on ${fmt(sentOn)}`;
  }
  return { year: input.year, done, next, allDone: !next, doneLine, sentOn };
}
