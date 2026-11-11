/**
 * Rule evaluation — pure. Does this rule apply to this entity's profile?
 *   APPLIES             every condition is met by a recorded fact
 *   DOES_NOT_APPLY      a recorded fact rules it out (no obligation is created)
 *   NEEDS_VERIFICATION  a fact the rule depends on isn't recorded (an obligation is proposed,
 *                       labeled Needs Verification, and the gap goes on the Missing Info report)
 * Nothing is assumed: an unknown fact never counts as a "yes" or a "no".
 */
import type { RuleConditions } from "./rules-data";

export type Registration = { id?: string; type: string; jurisdictionName: string | null; agency: string; status: string; filingFrequency: string | null; accountLast4?: string | null };

export type EntityFacts = {
  kind: string;
  taxClassification: string | null;
  sCorpEffectiveDate: string | null;
  fiscalYearEndMonth: number | null;
  stateOfFormation: string | null;
  states: string[];
  counties: string[];
  cities: string[];
  hasLocation: boolean;
  activityTags: string[];
  payrollStatus: string;
  issues1099: string;
  irsExemptionStatus: string | null;
  nonprofitForm: string | null;
  registrations: Registration[];
};

export type Evaluation = {
  result: "APPLIES" | "DOES_NOT_APPLY" | "NEEDS_VERIFICATION";
  reasons: string[];
  missing: string[];
  registration?: Registration;
  /** Frequency used, and whether it came from a recorded account. */
  frequency?: string;
  frequencyAssumed?: boolean;
};

const lc = (xs: string[]) => xs.map((x) => x.trim().toLowerCase());
const matchJur = (r: Registration, j?: string) => !j || lc([r.jurisdictionName ?? "", r.agency]).some((x) => x.includes(j.toLowerCase()));

export function isNonprofitEntity(f: Pick<EntityFacts, "kind" | "taxClassification">) {
  return f.kind === "NONPROFIT" || f.taxClassification === "EXEMPT_ORG";
}

export function evaluateRule(rule: { conditions: RuleConditions; frequency: string }, f: EntityFacts): Evaluation {
  const c = rule.conditions ?? {};
  const reasons: string[] = [];
  const missing: string[] = [];
  const no = (why: string): Evaluation => ({ result: "DOES_NOT_APPLY", reasons: [why], missing: [] });
  if (c.manualOnly) return no("Reference rule: recorded on a return's period, not generated on its own.");

  const nonprofit = isNonprofitEntity(f);
  if (c.nonprofit === true && !nonprofit) return no("Not a nonprofit entity.");
  if (c.nonprofit === false && nonprofit) return no("Nonprofit entity.");
  // A nonprofit's own filings never come from business-only rules and vice versa (income tax forms).
  if (c.nonprofit === undefined && nonprofit && c.taxClassifications) return no("Nonprofit entity.");

  if (c.entityKinds) {
    if (!c.entityKinds.includes(f.kind)) return no(`Entity type ${f.kind} is not ${c.entityKinds.join("/")}.`);
    reasons.push(`Entity type ${f.kind}`);
  }
  if (c.taxClassifications) {
    if (!f.taxClassification) missing.push("Federal tax classification not recorded");
    else if (!c.taxClassifications.includes(f.taxClassification)) return no(`Tax classification ${f.taxClassification}.`);
    else reasons.push(`Tax classification ${f.taxClassification}`);
  }
  if (c.sCorpElection && f.taxClassification === "S_CORP" && !f.sCorpEffectiveDate) missing.push("S corporation election effective date not recorded");
  if (c.fyeRequired && !f.fiscalYearEndMonth) missing.push("Fiscal year-end not recorded");

  if (c.formationStates) {
    if (!f.stateOfFormation) missing.push("State of formation not recorded");
    else if (!c.formationStates.includes(f.stateOfFormation)) return no(`Formed in ${f.stateOfFormation}.`);
  }
  if (c.states) {
    if (!f.states.length) missing.push("State of operation not recorded");
    else if (!f.states.some((s) => c.states!.includes(s))) return no(`Doesn't operate in ${c.states.join("/")}.`);
    else reasons.push(`Operates in ${c.states.join("/")}`);
  }
  if (c.counties) {
    if (!f.counties.length) missing.push(f.hasLocation ? "County of the business location not recorded" : "Business location (county) not recorded");
    else if (!lc(f.counties).some((x) => lc(c.counties!).includes(x.replace(/ county$/, "")))) return no(`No location in ${c.counties.join("/")} County.`);
    else reasons.push(`Location in ${c.counties.join("/")} County`);
  }
  if (c.cities) {
    if (!f.cities.length) missing.push(f.hasLocation ? "City of the business location not recorded" : "Business location (city) not recorded");
    else if (!lc(f.cities).some((x) => lc(c.cities!).includes(x))) return no(`No location in ${c.cities.join("/")}.`);
    else reasons.push(`Location in ${c.cities.join("/")}`);
  }
  const tags = lc(f.activityTags);
  if (c.activityTagsAny) {
    if (!tags.length) missing.push("Industry / activity not recorded");
    else if (!tags.some((t) => c.activityTagsAny!.includes(t))) return no("Activity doesn't match.");
    else reasons.push(`Activity: ${tags.filter((t) => c.activityTagsAny!.includes(t)).join(", ")}`);
  }
  if (c.tagDecision) {
    if (tags.includes(c.tagDecision.no)) return no(`Recorded: ${c.tagDecision.no}.`);
    if (!tags.includes(c.tagDecision.yes)) missing.push(c.tagDecision.missing);
    else reasons.push(`Activity: ${c.tagDecision.yes}`);
  }
  if (c.payroll !== undefined) {
    if (f.payrollStatus === "UNKNOWN") missing.push("Payroll status not recorded");
    else if ((f.payrollStatus === "YES") !== c.payroll) return no(f.payrollStatus === "YES" ? "Has payroll." : "No payroll.");
    else reasons.push(c.payroll ? "Has payroll" : "No payroll");
  }
  if (c.issues1099 !== undefined) {
    if (f.issues1099 === "UNKNOWN") missing.push("Whether the business issues Forms 1099 is not recorded");
    else if ((f.issues1099 === "YES") !== c.issues1099) return no("Doesn't issue Forms 1099.");
    else reasons.push("Issues Forms 1099");
  }
  if (c.nonprofitForms) {
    if (!f.nonprofitForm) {
      if (!c.nonprofitFormFallback) return no("990 form not determined yet (tracked by the determination rule).");
      missing.push("990-N / 990-EZ / 990 not determined (gross receipts and total assets needed)");
    } else if (!c.nonprofitForms.includes(f.nonprofitForm)) return no(`Files ${f.nonprofitForm}.`);
    else reasons.push(`Files ${f.nonprofitForm}`);
  }

  let frequency = rule.frequency;
  let frequencyAssumed = false;
  let registration: Registration | undefined;
  const fromAccount = rule.frequency.startsWith("ACCOUNT:");
  if (c.registration) {
    const g = c.registration;
    const accounts = f.registrations.filter((r) => r.type === g.type && matchJur(r, g.jurisdiction));
    const open = accounts.filter((r) => r.status !== "CLOSED");
    if (accounts.length && !open.length) return no("The registered account is closed.");
    registration = open[0];
    if (!registration) missing.push(g.missing);
    if (g.frequencies) {
      const freq = registration?.filingFrequency ?? null;
      if (freq && !g.frequencies.includes(freq)) return no(`Account files ${freq.toLowerCase()}.`);
      if (!freq && !g.fallbackOnUnknownFrequency) return no("Frequency not recorded (tracked by the monthly rule).");
    }
  }
  if (fromAccount) {
    const recorded = registration?.filingFrequency;
    if (recorded) frequency = recorded;
    else {
      frequency = rule.frequency.slice("ACCOUNT:".length);
      frequencyAssumed = true;
      const label = c.registration?.jurisdiction ? `${c.registration.jurisdiction} ` : "";
      missing.push(`${label}filing frequency not recorded (assumed ${frequency.toLowerCase()})`);
    }
  }
  if (registration && !registration.accountLast4) missing.push(`${registration.jurisdictionName ?? registration.agency} account number missing`);

  return { result: missing.length ? "NEEDS_VERIFICATION" : "APPLIES", reasons, missing: [...new Set(missing)], registration, frequency, frequencyAssumed };
}
