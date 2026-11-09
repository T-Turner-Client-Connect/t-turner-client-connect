import { ALABAMA_MEDICAL_FLOOR_BP, FEDERAL_MEDICAL_FLOOR_BP, medicalFloorCents, pct } from "./thresholds";

/**
 * The client's plain-language summary, built ONLY from values read off the
 * return (keyed by line-map id) and the facts read with them. Every sentence
 * is a fixed template below; no AI writes or rewrites any of it. Numbers in
 * the text are extracted values or simple arithmetic on them.
 */

export type SummaryInput = {
  taxYear: number;
  filingStatus: string;
  taxpayerName: string;
  spouseName: string | null;
  dependents: { name: string; relationship?: string; age?: number | null }[];
  /** Line-map id → cents (or a count for the 8812 counts). */
  values: Record<string, number>;
  /** Line-map id → the line number printed on the return. */
  lines: Record<string, string>;
  deposit: { accountLast4: string | null; type: string | null } | null;
};

export type Row = { title: string; detail?: string; source?: string; cents: number; sign?: "minus" | "plus"; emphasis?: boolean };
export type Amount = { label: string; cents: number; kind: "refund" | "owed" | "even" };
export type ClientSummary = {
  taxYear: number;
  taxpayerFirst: string;
  statusLabel: string;
  answer: { headline: string; federal: Amount; state: Amount | null; total: { label: string; cents: number } | null; deposit: string | null };
  who: { status: string; meaning: string; dependentsTitle: string | null; dependentsText: string | null };
  federal: { title: string; intro: string; rows: Row[]; result: { label: string; cents: number } };
  deductions: {
    intro: string;
    items: Row[];
    total: { label: string; cents: number } | null;
    alabamaTotal: string | null;
    medical: { title: string; lines: string[] } | null;
    federalChoice: { heading: string; text: string };
    alabamaChoice: { heading: string; text: string } | null;
    source: string;
  };
  alabama: { title: string; intro: string; rows: Row[]; result: { label: string; cents: number } } | null;
  next: string[];
  approveNote: string;
};

export const STATUS_LABEL: Record<string, string> = { SINGLE: "Single", MFJ: "Married Filing Jointly", MFS: "Married Filing Separately", HOH: "Head of Household", QSS: "Qualifying Surviving Spouse" };

/** One sentence per filing status. Neutral, and true for everyone who files that way. */
export const STATUS_MEANING: Record<string, string> = {
  SINGLE: "You're filing on your own as an unmarried person.",
  MFJ: "You and your spouse are filing one return together, with your income and deductions combined.",
  MFS: "You're married, and each of you files your own return.",
  HOH: "You're unmarried and paid more than half the cost of keeping up a home for a qualifying person, such as your child. This status gives you a bigger tax-free amount than filing Single.",
  QSS: "Your spouse passed away recently and you have a dependent child at home, so for a limited time you can use the same tax rates as a joint return.",
};

export const money = (c: number) => `$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const CHILD = /^(son|daughter|child|stepson|stepdaughter|stepchild|foster child|grandchild|grandson|granddaughter)$/i;

export function buildClientSummary(s: SummaryInput): ClientSummary {
  const v = (id: string) => s.values[id] ?? 0;
  const has = (id: string) => id in s.values;
  const ln = (id: string) => s.lines[id] ?? id.split(".")[1];
  const first = s.taxpayerName.split(/\s+/)[0] ?? s.taxpayerName;
  const statusLabel = STATUS_LABEL[s.filingStatus] ?? s.filingStatus;
  const hasAL = has("AL40.10");
  const hasSA = has("SA.17");
  const hasALSA = has("ALSA.19");

  // --- 1. The answer -------------------------------------------------------------------
  const fedCents = v("1040.35a") > 0 ? v("1040.35a") : -v("1040.37");
  const alCents = hasAL ? (v("AL40.25") > 0 ? v("AL40.25") : -v("AL40.26")) : null;
  const amt = (cents: number, who: string): Amount =>
    cents > 0 ? { label: `${who} refund`, cents, kind: "refund" } : cents < 0 ? { label: `${who === "Federal" ? "You owe the IRS" : `You owe ${who}`}`, cents: -cents, kind: "owed" } : { label: `${who}: nothing owed, no refund`, cents: 0, kind: "even" };
  const federal = amt(fedCents, "Federal");
  if (federal.kind === "refund") federal.label = "Federal refund (IRS)";
  const state = alCents === null ? null : amt(alCents, "Alabama");
  const all = [fedCents, ...(alCents === null ? [] : [alCents])];
  const net = all.reduce((n, c) => n + c, 0);
  let headline: string;
  let total: ClientSummary["answer"]["total"] = null;
  if (all.every((c) => c >= 0) && all.some((c) => c > 0)) {
    headline = `Good news, ${first}. You're getting money back.`;
    if (state) total = { label: "Total coming back to you", cents: net };
  } else if (all.every((c) => c <= 0) && all.some((c) => c < 0)) {
    headline = `${first}, here's what you owe.`;
    if (state) total = { label: "Total you owe", cents: -net };
  } else if (all.every((c) => c === 0)) headline = `${first}, you don't owe anything and no refund is due.`;
  else {
    headline = `${first}, here's where your return stands.`;
    total = net >= 0 ? { label: "Overall, coming back to you", cents: net } : { label: "Overall, you owe", cents: -net };
  }
  const acct = s.deposit?.accountLast4 ? `your ${s.deposit.type === "SAVINGS" ? "savings" : "checking"} account ending in ${s.deposit.accountLast4}` : null;
  const deposit = acct && fedCents > 0 ? `Your federal refund goes by direct deposit to ${acct}.` : null;

  // --- 2. Who's on the return ------------------------------------------------------------
  const deps = s.dependents;
  const allChildren = deps.length > 0 && deps.every((d) => CHILD.test((d.relationship ?? "").trim()));
  const named = deps.map((d) => `${d.name.split(/\s+/)[0]}${typeof d.age === "number" ? ` (${d.age})` : ""}`);
  const who = {
    status: `Filing status: ${statusLabel}`,
    meaning: STATUS_MEANING[s.filingStatus] ?? "",
    dependentsTitle: deps.length ? `${allChildren ? (deps.length === 1 ? "Child you claimed" : "Children you claimed") : "Dependents you claimed"}: ${deps.length}` : null,
    dependentsText: deps.length ? list(named) : null,
  };

  // --- 3. How we got the federal number ---------------------------------------------------------
  const F = (id: string, label?: string) => `${label ?? "Line"} ${ln(id)}`;
  const rows: Row[] = [];
  const incomeParts: [string, string][] = [["1040.1z", "wages"], ["1040.2b", "taxable interest"], ["1040.3b", "dividends"], ["1040.4b", "IRA distributions"], ["1040.5b", "pensions"], ["1040.6b", "taxable Social Security"], ["1040.7", "capital gains"], ["1040.8", "other income"]];
  const nonzero = incomeParts.filter(([id]) => v(id) !== 0);
  const onlyWages = nonzero.length === 1 && nonzero[0][0] === "1040.1z";
  rows.push({
    title: "Money you earned",
    detail: onlyWages ? (v("1040.1a") === v("1040.1z") ? "Your wages from Form W-2." : "Your wages.") : nonzero.length ? `${list(nonzero.map(([id, l], i) => `${i === 0 ? l[0].toUpperCase() + l.slice(1) : l} ${v(id) < 0 ? "−" : ""}${money(v(id))}`))}.` : undefined,
    source: F("1040.9", "Form 1040, line"),
    cents: v("1040.9"),
  });
  if (v("1040.10") > 0) {
    rows.push({ title: "Adjustments to income", detail: "Amounts subtracted before your deduction (Schedule 1).", source: F("1040.10"), cents: v("1040.10"), sign: "minus" });
    rows.push({ title: "Your adjusted gross income", source: F("1040.11"), cents: v("1040.11") });
  }
  const fedItemized = hasSA && v("SA.17") === v("1040.12");
  rows.push(
    fedItemized
      ? { title: "Your itemized deductions", detail: "The bills you added up on Schedule A. See “Your deductions” below.", source: F("1040.12"), cents: v("1040.12"), sign: "minus" }
      : { title: "Tax-free amount (standard deduction)", detail: `Most people get a set amount that isn't taxed. Yours, as ${statusLabel}, is ${money(v("1040.12"))}.`, source: F("1040.12"), cents: v("1040.12"), sign: "minus" },
  );
  if (v("1040.13") > 0) rows.push({ title: "Qualified business income deduction", detail: "A deduction for income from a business.", source: F("1040.13"), cents: v("1040.13"), sign: "minus" });
  if (v("1040.13b") > 0) rows.push({ title: "Additional deductions (Schedule 1-A)", source: F("1040.13b"), cents: v("1040.13b"), sign: "minus" });
  rows.push({ title: "Income that's actually taxed", detail: fedItemized ? "What's left after your deductions." : "What's left after the tax-free amount.", source: F("1040.15"), cents: v("1040.15") });
  rows.push({ title: "Tax on that income", detail: "Figured from the IRS tax rates.", source: F("1040.16"), cents: v("1040.16") });
  if (v("1040.17") > 0) rows.push({ title: "Additional tax (Schedule 2)", source: F("1040.17"), cents: v("1040.17"), sign: "plus" });
  const t18 = v("1040.16") + v("1040.17");
  const t22 = Math.max(0, t18 - v("1040.19") - v("1040.20"));
  if (v("1040.19") > 0) {
    const kids = v("8812.4");
    const others = v("8812.6");
    const title = kids && others ? "Child tax credit and credit for other dependents" : !kids && others ? "Credit for other dependents" : "Child tax credit";
    const forWhom = has("8812.4") && kids ? `For your ${kids} qualifying ${kids === 1 ? "child" : "children"} (Schedule 8812).` : "From Schedule 8812.";
    const wiped = t22 === 0 && v("1040.20") === 0 ? " It wiped out your whole tax bill." : "";
    rows.push({ title, detail: `${forWhom}${wiped}`, source: F("1040.19"), cents: v("1040.19"), sign: "minus" });
  }
  if (v("1040.20") > 0) rows.push({ title: "Other credits (Schedule 3)", source: F("1040.20"), cents: v("1040.20"), sign: "minus" });
  if (v("1040.23") > 0) rows.push({ title: "Other taxes (Schedule 2)", detail: "Such as self-employment tax.", source: F("1040.23"), cents: v("1040.23"), sign: "plus" });
  rows.push({ title: "Your federal tax for the year", source: F("1040.24"), cents: v("1040.24"), emphasis: true });
  const withheld = has("1040.25d") ? v("1040.25d") : v("1040.25a") + v("1040.25b") + v("1040.25c");
  if (withheld > 0) {
    const onlyW2 = v("1040.25b") === 0 && v("1040.25c") === 0;
    rows.push({
      title: onlyW2 ? "Tax already taken from your paychecks" : "Tax already withheld from your pay and other income",
      detail: [onlyW2 ? null : "From your W-2s, 1099s and other forms.", v("1040.24") === 0 ? "Since your tax is $0, all of it comes back to you." : null].filter(Boolean).join(" ") || undefined,
      source: onlyW2 ? `Line ${ln("1040.25a")} (W-2, box 2)` : F("1040.25d"),
      cents: withheld,
      sign: "plus",
    });
  }
  if (v("1040.26") > 0) rows.push({ title: "Estimated tax payments you made", source: F("1040.26"), cents: v("1040.26"), sign: "plus" });
  if (v("1040.27") > 0) rows.push({ title: "Earned income credit", detail: "A credit for working people. It counts like a payment.", source: F("1040.27"), cents: v("1040.27"), sign: "plus" });
  if (v("1040.28") > 0) {
    const goesTo = fedCents > 0 ? "added to your refund" : "used to lower what you owe";
    let detail = `It counts like a payment and is ${goesTo}.`;
    if (has("8812.12") && v("8812.12") > 0) {
      const rest = v("8812.12") - v("1040.19");
      detail = `Your credit was ${money(v("8812.12"))}. ${money(v("1040.19"))} erased your tax; ${rest === v("1040.28") ? `the other ${money(v("1040.28"))}` : `${money(v("1040.28"))} of the rest`} is ${goesTo}.`;
    }
    rows.push({ title: fedCents > 0 ? "Leftover child credit, paid to you" : "Leftover child credit", detail, source: F("1040.28"), cents: v("1040.28"), sign: "plus" });
  }
  if (v("1040.29") > 0) rows.push({ title: "College credit (American opportunity), refundable part", source: F("1040.29"), cents: v("1040.29"), sign: "plus" });
  if (v("1040.30") > 0) rows.push({ title: "Refundable adoption credit", source: F("1040.30"), cents: v("1040.30"), sign: "plus" });
  if (v("1040.31") > 0) rows.push({ title: "Other payments and credits (Schedule 3)", source: F("1040.31"), cents: v("1040.31"), sign: "plus" });
  if (v("1040.36") > 0) rows.push({ title: "Kept toward next year's estimated tax", detail: "You chose to apply this part of your overpayment to next year.", source: F("1040.36"), cents: v("1040.36"), sign: "minus" });
  const fedTitle = federal.kind === "refund" ? "How we got your federal refund" : federal.kind === "owed" ? "How we got the amount you owe the IRS" : "How we got your federal result";
  const fedResult = federal.kind === "refund" ? { label: "Your federal refund", cents: v("1040.35a") } : federal.kind === "owed" ? { label: "Amount you owe the IRS", cents: v("1040.37") } : { label: "Nothing owed, no refund", cents: 0 };

  // --- 4. Deductions ----------------------------------------------------------------------
  const items: Row[] = [];
  const from = hasSA ? "SA" : hasALSA ? "ALSA" : null;
  if (from === "SA") {
    const mortgage = has("SA.8e") ? v("SA.8e") : v("SA.8a") + v("SA.8b") + v("SA.8c");
    if (mortgage) items.push({ title: "Mortgage interest", detail: v("SA.8a") && !v("SA.8b") ? "From your Form 1098" : undefined, source: `Schedule A, line ${ln("SA.8e")}`, cents: mortgage });
    if (v("SA.9")) items.push({ title: "Investment interest", source: `Schedule A, line ${ln("SA.9")}`, cents: v("SA.9") });
    if (v("SA.5a")) items.push({ title: "State and local income or sales tax", source: `Schedule A, line ${ln("SA.5a")}`, cents: v("SA.5a") });
    if (v("SA.5b")) items.push({ title: "Property tax on your home", source: `Schedule A, line ${ln("SA.5b")}`, cents: v("SA.5b") });
    if (v("SA.5c")) items.push({ title: "Car tag (the value-based part)", detail: "Shown on your return as personal property tax. Only the part of a tag that's based on your vehicle's value counts, not the flat tag fees.", source: `Schedule A, line ${ln("SA.5c")}`, cents: v("SA.5c") });
    if (has("SA.5e") && has("SA.5d") && v("SA.5e") < v("SA.5d")) items.push({ title: "State and local taxes that counted", detail: `There's a limit on these taxes: ${money(v("SA.5e"))} of your ${money(v("SA.5d"))} counted.`, source: `Schedule A, line ${ln("SA.5e")}`, cents: v("SA.5e") });
    if (v("SA.6")) items.push({ title: "Other taxes", source: `Schedule A, line ${ln("SA.6")}`, cents: v("SA.6") });
    const gifts = has("SA.14") ? v("SA.14") : v("SA.11") + v("SA.12") + v("SA.13");
    if (gifts) items.push({ title: "Donations to charity", source: `Schedule A, line ${ln("SA.14")}`, cents: gifts });
    if (v("SA.15")) items.push({ title: "Casualty and theft losses", source: `Schedule A, line ${ln("SA.15")}`, cents: v("SA.15") });
    if (v("SA.16")) items.push({ title: "Other itemized deductions", source: `Schedule A, line ${ln("SA.16")}`, cents: v("SA.16") });
    if (v("SA.1")) items.push({ title: "Medical bills", detail: v("SA.4") ? `You paid ${money(v("SA.1"))}; ${money(v("SA.4"))} counted.` : `You paid ${money(v("SA.1"))}, but none of it counted this year (see below).`, source: `Schedule A, lines ${ln("SA.1")} and ${ln("SA.4")}`, cents: v("SA.4") });
  } else if (from === "ALSA") {
    const mortgage = has("ALSA.13") ? v("ALSA.13") - v("ALSA.12") : v("ALSA.9") + v("ALSA.10") + v("ALSA.11");
    if (mortgage) items.push({ title: "Mortgage interest", detail: v("ALSA.9") && !v("ALSA.10") ? "From your Form 1098" : undefined, source: "Alabama Schedule A", cents: mortgage });
    if (v("ALSA.12")) items.push({ title: "Investment interest", source: `Alabama Schedule A, line ${ln("ALSA.12")}`, cents: v("ALSA.12") });
    if (v("ALSA.5")) items.push({ title: "Property tax on your home", source: `Alabama Schedule A, line ${ln("ALSA.5")}`, cents: v("ALSA.5") });
    if (v("ALSA.6")) items.push({ title: "Car tag (the value-based part)", detail: "Shown on your return as personal property tax. Only the part of a tag that's based on your vehicle's value counts, not the flat tag fees.", source: `Alabama Schedule A, line ${ln("ALSA.6")}`, cents: v("ALSA.6") });
    if (v("ALSA.7")) items.push({ title: "Other taxes", source: `Alabama Schedule A, line ${ln("ALSA.7")}`, cents: v("ALSA.7") });
    const gifts = has("ALSA.17") ? v("ALSA.17") : v("ALSA.14") + v("ALSA.15") + v("ALSA.16");
    if (gifts) items.push({ title: "Donations to charity", source: `Alabama Schedule A, line ${ln("ALSA.17")}`, cents: gifts });
    if (v("ALSA.18")) items.push({ title: "Other itemized deductions", source: `Alabama Schedule A, line ${ln("ALSA.18")}`, cents: v("ALSA.18") });
    if (v("ALSA.1")) items.push({ title: "Medical bills", detail: v("ALSA.4") ? `You paid ${money(v("ALSA.1"))}; ${money(v("ALSA.4"))} counted.` : `You paid ${money(v("ALSA.1"))}, but none of it counted this year (see below).`, source: `Alabama Schedule A, lines ${ln("ALSA.1")} and ${ln("ALSA.4")}`, cents: v("ALSA.4") });
  }
  const itemTotal = from === "SA" ? v("SA.17") : from === "ALSA" ? v("ALSA.19") : null;
  const alabamaTotal = hasSA && hasALSA && v("ALSA.19") !== v("SA.17") ? `Your Alabama itemized total is ${money(v("ALSA.19"))} (Alabama Schedule A, line ${ln("ALSA.19")}). Alabama counts some items differently.` : null;

  const medicalLines: string[] = [];
  const need = (threshold: number, paid: number) => Math.max(0, threshold - paid);
  if (hasSA && v("SA.1") > 0) {
    const th = has("SA.3") ? v("SA.3") : medicalFloorCents(v("SA.2") || v("1040.11"), FEDERAL_MEDICAL_FLOOR_BP);
    medicalLines.push(
      v("SA.4") > 0
        ? `For the IRS, medical counts once it passes ${pct(FEDERAL_MEDICAL_FLOOR_BP)} of your income, which is ${money(th)} for you. You paid ${money(v("SA.1"))}, so ${money(v("SA.4"))} counted.`
        : `Medical only counts after it passes a set share of your income. For the IRS that's ${pct(FEDERAL_MEDICAL_FLOOR_BP)} of your income, which is ${money(th)} for you. You paid ${money(v("SA.1"))}, so you'd need ${money(need(th, v("SA.1")))} more in medical bills before any of it helps.`,
    );
  }
  if (hasALSA && v("ALSA.1") > 0) {
    const th = has("ALSA.3") ? v("ALSA.3") : medicalFloorCents(v("ALSA.2") || v("AL40.10"), ALABAMA_MEDICAL_FLOOR_BP);
    medicalLines.push(
      v("ALSA.4") > 0
        ? `For Alabama, medical counts once it passes ${pct(ALABAMA_MEDICAL_FLOOR_BP)} of your income (${money(th)}). ${money(v("ALSA.4"))} counted for Alabama.`
        : `${medicalLines.length ? "Alabama's bar is lower" : "For Alabama, medical counts after it passes"}${medicalLines.length ? "," : ""} ${pct(ALABAMA_MEDICAL_FLOOR_BP)} of your income (${money(th)}). You'd need ${money(need(th, v("ALSA.1")))} more for Alabama.`,
    );
  }
  const noneCounted = (hasSA ? v("SA.4") === 0 : true) && (hasALSA ? v("ALSA.4") === 0 : true);
  if (medicalLines.length) medicalLines.push("Tip: keep receipts for doctor, dental, eye care and prescriptions. A big medical year could make them count.");
  const medical = medicalLines.length ? { title: noneCounted ? "Why your medical bills didn't count" : "How your medical bills counted", lines: medicalLines } : null;

  const federalChoice = fedItemized
    ? { heading: "We itemized", text: `Your ${money(v("SA.17"))} itemized total is the amount on Form 1040, line ${ln("1040.12")}.` }
    : hasSA
      ? { heading: "We used the standard deduction", text: `${money(v("1040.12"))} is bigger than your ${money(v("SA.17"))} itemized total.` }
      : { heading: "We used the standard deduction", text: `${money(v("1040.12"))} (Form 1040, line ${ln("1040.12")}). Your federal return doesn't itemize.` };
  let alabamaChoice: ClientSummary["deductions"]["alabamaChoice"] = null;
  if (hasAL) {
    const alItemized = hasALSA && v("ALSA.19") === v("AL40.11");
    if (alItemized) {
      const kinds = [
        v("ALSA.9") + v("ALSA.10") + v("ALSA.11") ? "mortgage" : null,
        v("ALSA.5") ? "property tax" : null,
        v("ALSA.6") ? "car tag" : null,
        v("ALSA.14") + v("ALSA.15") + v("ALSA.16") ? "donations" : null,
        v("ALSA.4") ? "medical bills" : null,
      ].filter((k): k is string => !!k);
      alabamaChoice = {
        heading: "We itemized",
        text: `Alabama lets you choose separately from the IRS. Your Alabama return uses your ${money(v("ALSA.19"))} itemized total (Form 40, line ${ln("AL40.11")})${!fedItemized && kinds.length ? `, so your ${list(kinds)} still lower your Alabama tax` : ""}.`,
      };
    } else {
      alabamaChoice = {
        heading: "We used Alabama's standard deduction",
        text: `${money(v("AL40.11"))} (Form 40, line ${ln("AL40.11")})${hasALSA && v("ALSA.19") < v("AL40.11") ? ` is bigger than your ${money(v("ALSA.19"))} Alabama itemized total` : ""}.`,
      };
    }
  }
  const sources = [hasSA ? "Schedule A" : null, hasALSA ? "Alabama Schedule A" : null].filter(Boolean) as string[];

  // --- 5. Alabama ----------------------------------------------------------------------------
  let alabama: ClientSummary["alabama"] = null;
  if (hasAL) {
    const A = (id: string) => `Form 40, line ${ln(id)}`;
    const alItemized = hasALSA && v("ALSA.19") === v("AL40.11");
    const parts = [
      v("AL40.11") ? (alItemized ? `your itemized deductions ${money(v("AL40.11"))} (see above)` : `your standard deduction ${money(v("AL40.11"))}`) : null,
      v("AL40.12") ? `the federal income tax you can deduct ${money(v("AL40.12"))}` : null,
      v("AL40.13") ? `your personal exemption ${money(v("AL40.13"))}` : null,
      v("AL40.14") ? `${money(v("AL40.14"))} for your dependents` : null,
    ].filter((p): p is string => !!p);
    const totalDed = has("AL40.15") ? v("AL40.15") : v("AL40.11") + v("AL40.12") + v("AL40.13") + v("AL40.14");
    const alRows: Row[] = [
      { title: "Money you earned", detail: "Your Alabama adjusted gross income.", source: A("AL40.10"), cents: v("AL40.10") },
      { title: "Alabama tax-free amounts", detail: parts.length ? `${list(parts).replace(/^./, (c) => c.toUpperCase())}.` : undefined, source: `Lines ${ln("AL40.11")}–${ln(has("AL40.15") ? "AL40.15" : "AL40.14")}`, cents: totalDed, sign: "minus" },
      { title: `Alabama tax on ${money(v("AL40.16"))}`, source: `Line ${ln("AL40.17")}`, cents: v("AL40.17") },
    ];
    if (v("AL40.18") > 0) alRows.push({ title: "Alabama credits", source: `Line ${ln("AL40.18")}`, cents: v("AL40.18"), sign: "minus" });
    if (v("AL40.20") > 0) alRows.push({ title: "Alabama tax taken from your paychecks", source: `Line ${ln("AL40.20")}`, cents: v("AL40.20"), sign: "plus" });
    if (v("AL40.21") > 0) alRows.push({ title: "Alabama estimated tax payments", source: `Line ${ln("AL40.21")}`, cents: v("AL40.21"), sign: "plus" });
    if (v("AL40.24") > 0) alRows.push({ title: "Kept toward next year's Alabama estimated tax", source: `Line ${ln("AL40.24")}`, cents: v("AL40.24"), sign: "minus" });
    const alRefund = v("AL40.25");
    const result =
      alRefund > 0
        ? { label: v("AL40.24") > 0 ? "Your Alabama refund" : `You paid ${money(alRefund)} more than you owed, so it comes back`, cents: alRefund }
        : v("AL40.26") > 0
          ? { label: "Amount you owe Alabama", cents: v("AL40.26") }
          : { label: "Nothing owed to Alabama, no refund", cents: 0 };
    alabama = {
      title: alRefund > 0 ? "How we got your Alabama refund" : v("AL40.26") > 0 ? "How we got the amount you owe Alabama" : "How we got your Alabama result",
      intro: "Alabama has its own rules and amounts.",
      rows: alRows,
      result,
    };
  }

  // --- 6. What happens next ---------------------------------------------------------------------
  const both = hasAL ? "federal and Alabama returns" : "federal return";
  const next = [
    s.spouseName ? "Read this over. If it looks right, each of you taps Approve and signs with your own name." : "Read this over. If it looks right, tap Approve.",
    `We file your ${both}.`,
    all.some((c) => c > 0) ? `${hasAL ? "The IRS and Alabama each send refunds on their own schedule" : "The IRS sends refunds on its own schedule"}. You can check refund status on the IRS${hasAL ? " and Alabama Department of Revenue" : ""} website${hasAL ? "s" : ""}, or ask us.` : null,
    all.some((c) => c < 0) ? "Any amount you owe is due by the filing deadline. Ask us if you'd like help with how to pay." : null,
  ].filter((x): x is string => !!x);

  return {
    taxYear: s.taxYear,
    taxpayerFirst: first,
    statusLabel,
    answer: { headline, federal, state, total, deposit },
    who,
    federal: { title: fedTitle, intro: "Step by step, in plain words.", rows, result: fedResult },
    deductions: {
      intro: hasAL
        ? "You can take a set tax-free amount (the standard deduction), or add up certain bills you paid (itemizing). The choice is made separately for the IRS and for Alabama."
        : "You can take a set tax-free amount (the standard deduction), or add up certain bills you paid (itemizing).",
      items,
      total: itemTotal === null ? null : { label: "Your itemized total", cents: itemTotal },
      alabamaTotal,
      medical,
      federalChoice,
      alabamaChoice,
      source: sources.length ? `From ${list(sources)}` : `From Form 1040, line ${ln("1040.12")}`,
    },
    alabama,
    next,
    approveNote: "Approving confirms these numbers look right to you. It doesn't replace your IRS Form 8879 e-file signature.",
  };
}
