import { FIELD, FIELDS, FORM_NAMES, type FormCode } from "./line-map";
import type { ParsedReturn, Person } from "./parse";
import { ALABAMA_MEDICAL_FLOOR_BP, FEDERAL_MEDICAL_FLOOR_BP, medicalFloorCents, pct } from "./thresholds";

/**
 * The fail-safe. Every check here must pass before a summary can be sent;
 * any failure is a plain-language reason shown to Tabitha. All arithmetic
 * uses only values read from the return (plus the two medical floors in
 * thresholds.ts), and each formula is written out in the message.
 */

export type Issue = { code: string; message: string };
export type Values = Record<string, number>;
export type Expected = { taxYear: number; taxpayer: Person | null; spouse: Person | null };

export type ReturnFacts = {
  taxYear: number;
  filingStatus: "SINGLE" | "MFJ" | "MFS" | "HOH" | "QSS";
  taxpayerName: string;
  spouseName: string | null;
  dependents: { name: string; relationship: string; age: number | null }[];
  federalResultCents: number;
  federalDeduction: "STANDARD" | "ITEMIZED";
  alabama: { resultCents: number; deduction: "STANDARD" | "ITEMIZED" } | null;
  deposit: { routingLast4: string; accountLast4: string; type: "CHECKING" | "SAVINGS" } | null;
};

export type CheckResult = { issues: Issue[]; values: Values; lines: Record<string, string>; facts: ReturnFacts | null };

const money = (c: number) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
const fullName = (p: Person) => `${p.first} ${p.last}`.replace(/\s+/g, " ").trim();

/** Same person: first names (ignoring a middle initial) and last names agree, case, spacing and punctuation ignored. */
export function samePerson(onReturn: Person, onRecord: Person) {
  const firstOnReturn = norm(onReturn.first.split(/\s+/)[0] ?? "");
  const firstOnRecord = norm(onRecord.first.split(/\s+/)[0] ?? "");
  return !!firstOnReturn && firstOnReturn === firstOnRecord && norm(onReturn.last) === norm(onRecord.last);
}

export function checkReturn(p: ParsedReturn, expected: Expected): CheckResult {
  const issues: Issue[] = [];
  const add = (code: string, message: string) => {
    if (!issues.some((i) => i.code === code && i.message === message)) issues.push({ code, message });
  };
  const values: Values = {};
  const lines: Record<string, string> = {};
  const empty = { issues, values, lines, facts: null };

  if (!p.readable) {
    add("UNREADABLE", "The PDF has no readable text (it may be a scan or photo). Upload the return printed to PDF from TaxAct.");
    return empty;
  }
  if (p.businessReturn) {
    add("BUSINESS_RETURN", `Business return summaries aren't supported yet (Form ${p.businessReturn} found). Phase 2.`);
    return empty;
  }
  for (const u of p.unsupported) add("UNSUPPORTED_FORM", `${u} isn't supported by the automatic summary yet.`);
  if (!p.forms.F1040) {
    add("NO_1040", "No Form 1040 was found in the PDF.");
    return empty;
  }
  if (p.multipleReturns) add("MULTIPLE_RETURNS", "The PDF has more than one Form 1040. Upload one client's return at a time.");

  // --- Tax year ----------------------------------------------------------------------
  const fy = p.years.F1040 ?? [];
  if (!fy.length) add("YEAR_UNREADABLE", "The tax year on Form 1040 couldn't be read.");
  for (const form of Object.keys(p.forms) as FormCode[]) {
    const ys = p.years[form] ?? [];
    if (ys.length > 1) add("YEAR_AMBIGUOUS", `${FORM_NAMES[form]} shows more than one tax year (${ys.join(", ")}).`);
    else if (ys.length && ys[0] !== expected.taxYear) add("YEAR_MISMATCH", `${FORM_NAMES[form]} is for ${ys[0]}, but this upload is for the ${expected.taxYear} tax year.`);
  }

  // --- Names (never one client's summary for another) -------------------------------------
  if (!p.taxpayer) add("NAME_UNREADABLE", "The taxpayer's name on Form 1040 couldn't be read.");
  else if (!expected.taxpayer) add("NAME_NO_RECORD", "This client's record has no first and last name to compare with the return.");
  else if (!samePerson(p.taxpayer, expected.taxpayer)) add("NAME_MISMATCH", `The name on the return (${fullName(p.taxpayer)}) doesn't match this client (${fullName(expected.taxpayer)}).`);
  if (p.alTaxpayer && expected.taxpayer && !samePerson(p.alTaxpayer, expected.taxpayer)) add("NAME_MISMATCH_AL", `The name on Alabama Form 40 (${fullName(p.alTaxpayer)}) doesn't match this client (${fullName(expected.taxpayer)}).`);

  // --- Filing status ----------------------------------------------------------------------
  const status = p.filingStatus.code as ReturnFacts["filingStatus"] | null;
  if (!status) add("FILING_STATUS", `Filing status couldn't be read: ${p.filingStatus.note ?? "unclear"}`);
  const joint = status === "MFJ";
  if (joint && !p.spouse) add("SPOUSE_UNREADABLE", "This is a joint return, but the spouse's name on Form 1040 couldn't be read.");
  if (p.spouse && (joint || status === "MFS")) {
    if (!expected.spouse) add("SPOUSE_NO_RECORD", `The return names a spouse (${fullName(p.spouse)}), but this client has no spouse on file. Add the spouse to the client or tax case first.`);
    else if (!samePerson(p.spouse, expected.spouse)) add("SPOUSE_MISMATCH", `The spouse on the return (${fullName(p.spouse)}) doesn't match the spouse on file (${fullName(expected.spouse)}).`);
  }

  // --- Every line on each form that is in the PDF ---------------------------------------------
  for (const f of FIELDS) {
    if (!p.forms[f.form]) continue;
    const r = p.readings[f.id];
    const where = `${FORM_NAMES[f.form]}, line ${f.line} (${f.label})`;
    if (r.status === "found") {
      values[f.id] = r.value;
      lines[f.id] = r.printedLine ?? f.line;
    } else if (r.status === "blank") {
      values[f.id] = 0;
      lines[f.id] = r.printedLine ?? f.line;
    } else if (r.status === "ambiguous") add("AMBIGUOUS_LINE", `${where}: unclear — ${r.note}.`);
    else if (f.required) add("MISSING_LINE", `${where}: not found on the return.`);
  }
  const has = (id: string) => id in values;
  const v = (id: string) => values[id] ?? 0;
  const eq = (code: string, form: string, lhsId: string, rhs: number, formula: string) => {
    if (!has(lhsId)) return;
    if (v(lhsId) !== rhs) add(code, `${form}: line ${lines[lhsId]} shows ${money(v(lhsId))}, but ${formula} = ${money(rhs)}.`);
  };
  const L = (id: string) => `line ${lines[id] ?? FIELD[id].line}`;

  // --- Form 1040 arithmetic ------------------------------------------------------------------
  const F = "Form 1040";
  const incomeParts = ["1040.1z", "1040.2b", "1040.3b", "1040.4b", "1040.5b", "1040.6b", "1040.7", "1040.8"];
  eq("MATH_TOTAL_INCOME", F, "1040.9", incomeParts.reduce((n, id) => n + v(id), 0), "lines 1z + 2b + 3b + 4b + 5b + 6b + 7 + 8");
  eq("MATH_AGI", F, "1040.11", v("1040.9") - v("1040.10"), "line 9 − line 10");
  const deductions = v("1040.12") + v("1040.13") + v("1040.13b");
  eq("MATH_DEDUCTIONS", F, "1040.14", deductions, "line 12 + line 13" + (has("1040.13b") ? " + Schedule 1-A deductions" : ""));
  eq("MATH_TAXABLE_INCOME", F, "1040.15", Math.max(0, v("1040.11") - (has("1040.14") ? v("1040.14") : deductions)), "line 11 − line 14 (not less than $0)");
  const t18 = v("1040.16") + v("1040.17");
  eq("MATH_TAX", F, "1040.18", t18, "line 16 + line 17");
  const t21 = v("1040.19") + v("1040.20");
  eq("MATH_CREDITS", F, "1040.21", t21, "line 19 + line 20");
  const t22 = Math.max(0, t18 - t21);
  eq("MATH_TAX_AFTER_CREDITS", F, "1040.22", t22, "line 18 − line 21 (not less than $0)");
  eq("MATH_TOTAL_TAX", F, "1040.24", t22 + v("1040.23"), "line 22 + line 23");
  const t25d = v("1040.25a") + v("1040.25b") + v("1040.25c");
  eq("MATH_WITHHOLDING", F, "1040.25d", t25d, "lines 25a + 25b + 25c");
  const t32 = v("1040.27") + v("1040.28") + v("1040.29") + v("1040.30") + v("1040.31");
  eq("MATH_OTHER_PAYMENTS", F, "1040.32", t32, "lines 27 + 28 + 29 + 30 + 31");
  eq("MATH_TOTAL_PAYMENTS", F, "1040.33", (has("1040.25d") ? v("1040.25d") : t25d) + v("1040.26") + (has("1040.32") ? v("1040.32") : t32), "line 25d + line 26 + line 32");
  if (v("1040.38") > 0) add("PENALTY", `Form 1040, ${L("1040.38")} shows an estimated tax penalty (${money(v("1040.38"))}). The automatic summary doesn't explain penalties yet.`);

  // Total payments − total tax = refund (or amount owed).
  if (has("1040.33") && has("1040.24")) {
    const diff = v("1040.33") - v("1040.24");
    if (diff > 0) {
      if (!has("1040.34")) add("MISSING_LINE", `Form 1040: payments are more than the tax, but ${L("1040.34")} (amount overpaid) wasn't found.`);
      else eq("MATH_OVERPAID", F, "1040.34", diff, "line 33 − line 24");
      if (has("1040.34") && v("1040.35a") + v("1040.36") !== v("1040.34")) add("MATH_REFUND", `Form 1040: ${L("1040.35a")} (refund ${money(v("1040.35a"))}) + ${L("1040.36")} (applied ${money(v("1040.36"))}) should equal ${L("1040.34")} (${money(v("1040.34"))}).`);
      if (v("1040.37") !== 0) add("MATH_RESULT", `Form 1040 shows both an overpayment and an amount owed (${L("1040.37")}).`);
    } else if (diff < 0) {
      if (!has("1040.37")) add("MISSING_LINE", `Form 1040: the tax is more than the payments, but ${L("1040.37")} (amount you owe) wasn't found.`);
      else eq("MATH_OWED", F, "1040.37", -diff, "line 24 − line 33");
      if (v("1040.34") !== 0 || v("1040.35a") !== 0) add("MATH_RESULT", "Form 1040 shows both an amount owed and a refund.");
    } else if (v("1040.35a") !== 0 || v("1040.37") !== 0) add("MATH_RESULT", "Form 1040: total payments equal total tax, but a refund or amount owed is printed.");
  }

  // Schedules 1–3 tie to Form 1040 when they're in the PDF.
  const tie = (form: FormCode, schedId: string, lineId: string, what: string) => {
    if (p.forms[form] && has(schedId) && has(lineId) && v(schedId) !== v(lineId)) add("MATH_SCHEDULE_TIE", `${FORM_NAMES[form]}, ${L(schedId)} (${what}, ${money(v(schedId))}) doesn't match Form 1040, ${L(lineId)} (${money(v(lineId))}).`);
  };
  tie("S1", "S1.10", "1040.8", "additional income");
  tie("S1", "S1.26", "1040.10", "adjustments");
  tie("S2", "S2.3", "1040.17", "additional tax");
  tie("S2", "S2.21", "1040.23", "other taxes");
  tie("S3", "S3.8", "1040.20", "credits");
  tie("S3", "S3.15", "1040.31", "other payments");

  // --- Schedule A: the total must equal the sum of its parts -----------------------------------
  let federalDeduction: ReturnFacts["federalDeduction"] = "STANDARD";
  if (p.forms.SA) {
    const S = "Schedule A";
    if (has("SA.2") && has("1040.11")) eq("MATH_SCHED_A_AGI", S, "SA.2", v("1040.11"), "Form 1040, line 11");
    const agi = has("SA.2") ? v("SA.2") : v("1040.11");
    const floor = medicalFloorCents(agi, FEDERAL_MEDICAL_FLOOR_BP);
    if (has("SA.3") && Math.abs(v("SA.3") - floor) > 100) add("MATH_SCHED_A_MEDICAL_FLOOR", `${S}: ${L("SA.3")} shows ${money(v("SA.3"))}, but ${pct(FEDERAL_MEDICAL_FLOOR_BP)} of ${money(agi)} = ${money(floor)}.`);
    eq("MATH_SCHED_A_MEDICAL", S, "SA.4", Math.max(0, v("SA.1") - (has("SA.3") ? v("SA.3") : floor)), "line 1 − line 3 (not less than $0)");
    const t5d = v("SA.5a") + v("SA.5b") + v("SA.5c");
    eq("MATH_SCHED_A_TAXES", S, "SA.5d", t5d, "lines 5a + 5b + 5c");
    if (has("SA.5e") && v("SA.5e") > (has("SA.5d") ? v("SA.5d") : t5d)) add("MATH_SCHED_A_TAXES", `${S}: ${L("SA.5e")} (${money(v("SA.5e"))}) is more than line 5d.`);
    const t5e = has("SA.5e") ? v("SA.5e") : t5d;
    eq("MATH_SCHED_A_TAXES", S, "SA.7", t5e + v("SA.6"), "line 5e + line 6");
    const t8e = v("SA.8a") + v("SA.8b") + v("SA.8c");
    eq("MATH_SCHED_A_INTEREST", S, "SA.8e", t8e, "lines 8a + 8b + 8c");
    eq("MATH_SCHED_A_INTEREST", S, "SA.10", (has("SA.8e") ? v("SA.8e") : t8e) + v("SA.9"), "line 8e + line 9");
    const t14 = v("SA.11") + v("SA.12") + v("SA.13");
    eq("MATH_SCHED_A_GIFTS", S, "SA.14", t14, "lines 11 + 12 + 13");
    const taxes = has("SA.7") ? v("SA.7") : t5e + v("SA.6");
    const interest = has("SA.10") ? v("SA.10") : t8e + v("SA.9");
    const gifts = has("SA.14") ? v("SA.14") : t14;
    eq("MATH_SCHED_A_TOTAL", S, "SA.17", v("SA.4") + taxes + interest + gifts + v("SA.15") + v("SA.16"), "lines 4 + 7 + 10 + 14 + 15 + 16");
    if (has("SA.17") && has("1040.12")) {
      if (v("SA.17") === v("1040.12")) federalDeduction = "ITEMIZED";
      else if (v("SA.17") > v("1040.12")) add("DEDUCTION_CHOICE", `Schedule A totals ${money(v("SA.17"))}, more than Form 1040, line 12 (${money(v("1040.12"))}), and line 12 doesn't match it. Check which deduction was used.`);
    }
  }

  // --- Schedule 8812 ------------------------------------------------------------------------
  if (p.forms.S8812) {
    tie("S8812", "8812.14", "1040.19", "child tax credit");
    if (has("8812.27") || v("1040.28")) tie("S8812", "8812.27", "1040.28", "additional child tax credit");
    if (has("8812.12") && has("8812.14") && v("8812.14") > v("8812.12")) add("MATH_8812", `Schedule 8812: ${L("8812.14")} (${money(v("8812.14"))}) is more than ${L("8812.12")} (${money(v("8812.12"))}).`);
  }

  // --- Dependents -----------------------------------------------------------------------------
  let dependents: ReturnFacts["dependents"] = [];
  if (!p.dependents) add("DEPENDENTS_UNREADABLE", `Dependents couldn't be read: ${p.dependentsNote ?? "unclear"}`);
  else {
    dependents = p.dependents.map((d) => ({ name: d.name, relationship: d.relationship, age: d.birthYear && d.birthYear <= expected.taxYear ? expected.taxYear - d.birthYear : null }));
    const claimed = v("8812.4") + v("8812.6");
    if (p.forms.S8812 && claimed > dependents.length) add("DEPENDENTS_COUNT", `Schedule 8812 counts ${claimed} dependent(s), but ${dependents.length} were read from Form 1040.`);
  }

  // --- Direct deposit -----------------------------------------------------------------------
  let deposit: ReturnFacts["deposit"] = null;
  if (p.deposit && v("1040.35a") > 0) {
    if (!p.deposit.routingLast4 || !p.deposit.accountLast4) add("DEPOSIT_UNREADABLE", "Form 1040, line 35b/35d: the direct-deposit routing or account number couldn't be read.");
    else if (!p.deposit.type) add("DEPOSIT_UNREADABLE", "Form 1040, line 35c: couldn't tell whether the refund account is checking or savings.");
    else deposit = { routingLast4: p.deposit.routingLast4, accountLast4: p.deposit.accountLast4, type: p.deposit.type };
  }

  // --- Alabama Form 40 and Schedule A -------------------------------------------------------------
  let alabama: ReturnFacts["alabama"] = null;
  if (p.forms.AL40) {
    const A = "Alabama Form 40";
    const t15 = v("AL40.11") + v("AL40.12") + v("AL40.13") + v("AL40.14");
    eq("MATH_AL_DEDUCTIONS", A, "AL40.15", t15, "lines 11 + 12 + 13 + 14");
    eq("MATH_AL_TAXABLE_INCOME", A, "AL40.16", Math.max(0, v("AL40.10") - (has("AL40.15") ? v("AL40.15") : t15)), "line 10 − line 15 (not less than $0)");
    const net = Math.max(0, v("AL40.17") - v("AL40.18"));
    eq("MATH_AL_NET_TAX", A, "AL40.19", net, "line 17 − line 18 (not less than $0)");
    const tax = has("AL40.19") ? v("AL40.19") : net;
    eq("MATH_AL_PAYMENTS", A, "AL40.22", v("AL40.20") + v("AL40.21"), "Alabama withholding + estimated payments");
    if (has("AL40.22")) {
      const diff = v("AL40.22") - tax;
      if (diff > 0) {
        if (has("AL40.23")) eq("MATH_AL_OVERPAID", A, "AL40.23", diff, "total payments − tax");
        if (v("AL40.25") + v("AL40.24") !== diff) add("MATH_AL_REFUND", `${A}: refund (${money(v("AL40.25"))}) + amount applied (${money(v("AL40.24"))}) should equal payments − tax (${money(diff)}).`);
        if (v("AL40.26")) add("MATH_AL_RESULT", `${A} shows both an overpayment and an amount owed.`);
      } else if (diff < 0) {
        if (!has("AL40.26")) add("MISSING_LINE", `${A}: the tax is more than the payments, but the amount you owe wasn't found.`);
        else eq("MATH_AL_OWED", A, "AL40.26", -diff, "tax − total payments");
        if (v("AL40.25")) add("MATH_AL_RESULT", `${A} shows both an amount owed and a refund.`);
      } else if (v("AL40.25") || v("AL40.26")) add("MATH_AL_RESULT", `${A}: payments equal the tax, but a refund or amount owed is printed.`);
    }
    let alDeduction: "STANDARD" | "ITEMIZED" = "STANDARD";
    if (p.forms.ALSA) {
      const S = "Alabama Schedule A";
      if (has("ALSA.2")) eq("MATH_AL_SCHED_A_AGI", S, "ALSA.2", v("AL40.10"), "Form 40, line 10");
      const agi = has("ALSA.2") ? v("ALSA.2") : v("AL40.10");
      const floor = medicalFloorCents(agi, ALABAMA_MEDICAL_FLOOR_BP);
      if (has("ALSA.3") && Math.abs(v("ALSA.3") - floor) > 100) add("MATH_AL_SCHED_A_MEDICAL_FLOOR", `${S}: ${L("ALSA.3")} shows ${money(v("ALSA.3"))}, but ${pct(ALABAMA_MEDICAL_FLOOR_BP)} of ${money(agi)} = ${money(floor)}.`);
      eq("MATH_AL_SCHED_A_MEDICAL", S, "ALSA.4", Math.max(0, v("ALSA.1") - (has("ALSA.3") ? v("ALSA.3") : floor)), "line 1 − line 3 (not less than $0)");
      const t8 = v("ALSA.5") + v("ALSA.6") + v("ALSA.7");
      eq("MATH_AL_SCHED_A_TAXES", S, "ALSA.8", t8, "lines 5 + 6 + 7");
      const t13 = v("ALSA.9") + v("ALSA.10") + v("ALSA.11") + v("ALSA.12");
      eq("MATH_AL_SCHED_A_INTEREST", S, "ALSA.13", t13, "lines 9 + 10 + 11 + 12");
      const t17 = v("ALSA.14") + v("ALSA.15") + v("ALSA.16");
      eq("MATH_AL_SCHED_A_GIFTS", S, "ALSA.17", t17, "lines 14 + 15 + 16");
      const total = v("ALSA.4") + (has("ALSA.8") ? v("ALSA.8") : t8) + (has("ALSA.13") ? v("ALSA.13") : t13) + (has("ALSA.17") ? v("ALSA.17") : t17) + v("ALSA.18");
      eq("MATH_AL_SCHED_A_TOTAL", S, "ALSA.19", total, "lines 4 + 8 + 13 + 17 + 18");
      if (has("ALSA.19") && v("ALSA.19") === v("AL40.11")) alDeduction = "ITEMIZED";
    } else if (p.forms.SA && has("SA.17") && v("SA.17") === v("AL40.11")) {
      add("AL_SCHED_A_MISSING", "Alabama Form 40, line 11 equals the federal itemized total, but Alabama Schedule A isn't in the PDF.");
    }
    alabama = { resultCents: v("AL40.25") > 0 ? v("AL40.25") : -v("AL40.26"), deduction: alDeduction };
  }

  if (issues.length || !status || !p.taxpayer) return { issues, values, lines, facts: null };
  return {
    issues, values, lines,
    facts: {
      taxYear: expected.taxYear,
      filingStatus: status,
      taxpayerName: fullName(p.taxpayer),
      spouseName: p.spouse && (joint || status === "MFS") ? fullName(p.spouse) : null,
      dependents,
      federalResultCents: v("1040.35a") > 0 ? v("1040.35a") : -v("1040.37"),
      federalDeduction,
      alabama,
      deposit,
    },
  };
}
