import { PDFDocument, StandardFonts } from "pdf-lib";

/**
 * FICTIONAL prepared-return PDFs for the automatic summary tests. The text
 * mimics the printed wording of the 2025 forms (see the unverified line map);
 * TaxAct's real print layout still needs calibrating with a sample PDF.
 * All people, numbers and account numbers here are made up.
 */

export type Person = { first: string; last: string };
export type ReturnCfg = {
  year?: number;
  alYear?: number;
  taxpayer: Person;
  spouse?: Person;
  status: "SINGLE" | "MFJ" | "MFS" | "HOH" | "QSS";
  dependents?: { name: string; ssn: string; rel: string; dob?: string }[];
  /** Line-map id → dollars (undefined = printed blank). */
  v: Record<string, number | undefined>;
  deposit?: { routing: string; account: string; type: "Checking" | "Savings" } | null;
  forms?: { sa?: boolean; s8812?: boolean; al?: boolean; alsa?: boolean };
  /** Line-map ids whose printed line is left out entirely. */
  drop?: string[];
  /** Raw text replacements applied to the finished lines. */
  replace?: [string, string][];
  extraPages?: string[][];
};

const T: Record<string, string> = {
  "1040.1a": "1a Total amount from Form(s) W-2, box 1 (see instructions) . . . . 1a",
  "1040.1z": "z Add lines 1a through 1h . . . . . . . 1z",
  "1040.2b": "2a Tax-exempt interest . . 2a b Taxable interest . . 2b",
  "1040.3b": "3a Qualified dividends . . 3a b Ordinary dividends . . 3b",
  "1040.4b": "4a IRA distributions . . 4a b Taxable amount . . 4b",
  "1040.5b": "5a Pensions and annuities . . 5a b Taxable amount . . 5b",
  "1040.6b": "6a Social security benefits . . 6a b Taxable amount . . 6b",
  "1040.7": "7 Capital gain or (loss). Attach Schedule D if required. If not required, check here . . 7",
  "1040.8": "8 Additional income from Schedule 1, line 10 . . . . . 8",
  "1040.9": "9 Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7, and 8. This is your total income . . . 9",
  "1040.10": "10 Adjustments to income from Schedule 1, line 26 . . . . 10",
  "1040.11": "11 Subtract line 10 from line 9. This is your adjusted gross income . . . 11",
  "1040.12": "12 Standard deduction or itemized deductions (from Schedule A) . . . 12",
  "1040.13": "13 Qualified business income deduction from Form 8995 or Form 8995-A . . 13",
  "1040.14": "14 Add lines 12 and 13 . . . . . . . 14",
  "1040.15": "15 Subtract line 14 from line 11. If zero or less, enter -0-. This is your taxable income . . 15",
  "1040.16": "16 Tax (see instructions). Check if any from Form(s): 1 8814 2 4972 3 . . 16",
  "1040.17": "17 Amount from Schedule 2, line 3 . . . . . . 17",
  "1040.18": "18 Add lines 16 and 17 . . . . . . . . 18",
  "1040.19": "19 Child tax credit or credit for other dependents from Schedule 8812 . . 19",
  "1040.20": "20 Amount from Schedule 3, line 8 . . . . . . 20",
  "1040.21": "21 Add lines 19 and 20 . . . . . . . . 21",
  "1040.22": "22 Subtract line 21 from line 18. If zero or less, enter -0- . . . 22",
  "1040.23": "23 Other taxes, including self-employment tax, from Schedule 2, line 21 . . 23",
  "1040.24": "24 Add lines 22 and 23. This is your total tax . . . . . 24",
  "1040.25a": "a Form(s) W-2 . . . . . . . . 25a",
  "1040.25b": "b Form(s) 1099 . . . . . . . . 25b",
  "1040.25c": "c Other forms (see instructions) . . . . . 25c",
  "1040.25d": "d Add lines 25a through 25c . . . . . . 25d",
  "1040.26": "26 2025 estimated tax payments and amount applied from 2024 return . . 26",
  "1040.27": "27 Earned income credit (EIC) . . . . . . 27",
  "1040.28": "28 Additional child tax credit from Schedule 8812 . . . . 28",
  "1040.29": "29 American opportunity credit from Form 8863, line 8 . . . 29",
  "1040.30": "30 Refundable adoption credit from Form 8839, line 13 . . . 30",
  "1040.31": "31 Amount from Schedule 3, line 15 . . . . . 31",
  "1040.32": "32 Add lines 27, 28, 29, 30, and 31. These are your total other payments and refundable credits . . 32",
  "1040.33": "33 Add lines 25d, 26, and 32. These are your total payments . . . 33",
  "1040.34": "34 If line 33 is more than line 24, subtract line 24 from line 33. This is the amount you overpaid . . 34",
  "1040.35a": "35a Amount of line 34 you want refunded to you. If Form 8888 is attached, check here . . 35a",
  "1040.36": "36 Amount of line 34 you want applied to your 2026 estimated tax . . 36",
  "1040.37": "37 Subtract line 33 from line 24. This is the amount you owe. For details on how to pay, go to www.irs.gov/Payments or see instructions . . 37",
  "1040.38": "38 Estimated tax penalty (see instructions) . . . . 38",
  "SA.1": "1 Medical and dental expenses (see instructions) . . . 1",
  "SA.2": "2 Enter amount from Form 1040 or 1040-SR, line 11 . . 2",
  "SA.3": "3 Multiply line 2 by 7.5% (0.075) . . . . . . 3",
  "SA.4": "4 Subtract line 3 from line 1. If line 3 is more than line 1, enter -0- . . 4",
  "SA.5a": "a State and local income taxes or general sales taxes. You may include either income taxes or general sales taxes on line 5a, but not both. If you elect to include general sales taxes instead of income taxes, check this box . . 5a",
  "SA.5b": "b State and local real estate taxes (see instructions) . . 5b",
  "SA.5c": "c State and local personal property taxes . . . 5c",
  "SA.5d": "d Add lines 5a through 5c . . . . . . 5d",
  "SA.5e": "e Enter the smaller of line 5d or $40,000 ($20,000 if married filing separately) . . 5e",
  "SA.6": "6 Other taxes. List type and amount . . . . . 6",
  "SA.7": "7 Add lines 5e and 6 . . . . . . . . 7",
  "SA.8a": "a Home mortgage interest and points reported to you on Form 1098. See instructions if limited . . 8a",
  "SA.8b": "b Home mortgage interest not reported to you on Form 1098. See instructions if limited. If paid to the person from whom you bought the home, see instructions and show that person's name, identifying no., and address . . 8b",
  "SA.8c": "c Points not reported to you on Form 1098. See instructions for special rules . . 8c",
  "SA.8e": "e Add lines 8a through 8c . . . . . . 8e",
  "SA.9": "9 Investment interest. Attach Form 4952 if required. See instructions . . 9",
  "SA.10": "10 Add lines 8e and 9 . . . . . . . . 10",
  "SA.11": "11 Gifts by cash or check. If you made any gift of $250 or more, see instructions . . 11",
  "SA.12": "12 Other than by cash or check. If you made any gift of $250 or more, see instructions. You must attach Form 8283 if over $500 . . 12",
  "SA.13": "13 Carryover from prior year . . . . . . . 13",
  "SA.14": "14 Add lines 11 through 13 . . . . . . . 14",
  "SA.15": "15 Casualty and theft loss(es) from a federally declared disaster (other than net qualified disaster losses). Attach Form 4684 and enter the amount from line 18 of that form. See instructions . . 15",
  "SA.16": "16 Other—from list in instructions. List type and amount . . 16",
  "SA.17": "17 Add the amounts in the far right column for lines 4 through 16. Also, enter this amount on Form 1040 or 1040-SR, line 12 . . 17",
  "8812.4": "4 Number of qualifying children under age 17 with the required social security number . . 4",
  "8812.6": "6 Number of other dependents, including any qualifying children who are not under age 17 or who do not have the required social security number . . 6",
  "8812.12": "12 Subtract line 11 from line 8. If zero or less, enter -0- . . 12",
  "8812.14": "14 Enter the smaller of line 12 or line 13. This is your child tax credit and credit for other dependents. Enter this amount on Form 1040, 1040-SR, or 1040-NR, line 19 . . 14",
  "8812.27": "27 This is your additional child tax credit. Enter this amount on Form 1040, 1040-SR, or 1040-NR, line 28 . . 27",
  "AL40.10": "10 Total adjusted gross income (subtract line 9 from line 8) . . 10",
  "AL40.11": "11 Standard deduction or itemized deductions (Schedule A) . . 11",
  "AL40.12": "12 Federal tax deduction . . . . . . 12",
  "AL40.13": "13 Personal exemption . . . . . . . 13",
  "AL40.14": "14 Dependent exemption . . . . . . . 14",
  "AL40.15": "15 Total deductions (add lines 11 through 14) . . 15",
  "AL40.16": "16 Taxable income (subtract line 15 from line 10) . . 16",
  "AL40.17": "17 Income tax due . . . . . . . . 17",
  "AL40.18": "18 Total nonrefundable credits . . . . . 18",
  "AL40.19": "19 Net tax liability . . . . . . . . 19",
  "AL40.20": "20 Alabama income tax withheld . . . . . 20",
  "AL40.21": "21 Estimated tax payments . . . . . . 21",
  "AL40.22": "22 Total payments . . . . . . . . 22",
  "AL40.23": "23 Amount overpaid . . . . . . . . 23",
  "AL40.24": "24 Amount applied to your 2026 estimated tax . . 24",
  "AL40.25": "25 Amount to be refunded . . . . . . 25",
  "AL40.26": "26 Amount you owe . . . . . . . . 26",
  "ALSA.1": "1 Medical and dental expenses . . . . . 1",
  "ALSA.2": "2 Enter amount from Form 40, line 10 . . . 2",
  "ALSA.3": "3 Multiply line 2 by 4% (.04) . . . . . 3",
  "ALSA.4": "4 Subtract line 3 from line 1. If zero or less, enter -0- . . 4",
  "ALSA.5": "5 Real estate taxes . . . . . . . . 5",
  "ALSA.6": "6 Personal property taxes . . . . . . 6",
  "ALSA.7": "7 Other taxes . . . . . . . . . 7",
  "ALSA.8": "8 Add lines 5 through 7 . . . . . . 8",
  "ALSA.9": "9 Home mortgage interest and points reported to you on Form 1098 . . 9",
  "ALSA.10": "10 Home mortgage interest not reported to you on Form 1098 . . 10",
  "ALSA.11": "11 Points not reported to you on Form 1098 . . . 11",
  "ALSA.12": "12 Investment interest . . . . . . . 12",
  "ALSA.13": "13 Add lines 9 through 12 . . . . . . 13",
  "ALSA.14": "14 Gifts by cash or check . . . . . . 14",
  "ALSA.15": "15 Other than by cash or check . . . . . 15",
  "ALSA.16": "16 Carryover from prior year . . . . . . 16",
  "ALSA.17": "17 Add lines 14 through 16 . . . . . . 17",
  "ALSA.18": "18 Other miscellaneous deductions . . . . 18",
  "ALSA.19": "19 Total itemized deductions . . . . . . 19",
};

const fmt = (d: number) => (d < 0 ? `(${Math.abs(d).toLocaleString("en-US")}.)` : `${d.toLocaleString("en-US")}.`);
const box = (on: boolean) => (on ? "[X]" : "[ ]");

export function returnPages(cfg: ReturnCfg): string[][] {
  const y = cfg.year ?? 2025;
  const line = (id: string) => (cfg.drop?.includes(id) ? null : `${T[id]}${cfg.v[id] !== undefined ? ` ${fmt(cfg.v[id]!)}` : ""}`);
  const ids = (prefix: string) => Object.keys(T).filter((k) => k.startsWith(prefix));
  const lines = (prefix: string, from?: string, to?: string) => {
    const all = ids(prefix);
    const a = from ? all.indexOf(from) : 0;
    const b = to ? all.indexOf(to) + 1 : all.length;
    return all.slice(a, b).map(line).filter((l): l is string => !!l);
  };
  const st = cfg.status;
  const p1 = [
    `Form 1040 Department of the Treasury—Internal Revenue Service U.S. Individual Income Tax Return ${y} OMB No. 1545-0074`,
    `For the year Jan. 1–Dec. 31, ${y}, or other tax year beginning , ${y}, ending , 20`,
    `Your first name and middle initial ${cfg.taxpayer.first} Last name ${cfg.taxpayer.last} Your social security number 400-00-1234`,
    `If joint return, spouse's first name and middle initial ${cfg.spouse ? `${cfg.spouse.first} Last name ${cfg.spouse.last}` : "Last name"} Spouse's social security number${cfg.spouse ? " 400-00-5678" : ""}`,
    "Home address (number and street). If you have a P.O. box, see instructions. 100 Example Lane",
    `Filing Status ${box(st === "SINGLE")} Single ${box(st === "MFJ")} Married filing jointly ${box(st === "MFS")} Married filing separately (MFS) ${box(st === "HOH")} Head of household (HOH) ${box(st === "QSS")} Qualifying surviving spouse (QSS)`,
    "Dependents (see instructions): (1) First name Last name (2) Social security number (3) Relationship (4) Check if qualifies for",
    ...(cfg.dependents ?? []).map((d) => `${d.name} ${d.ssn} ${d.rel} [X] Child tax credit${d.dob ? ` Date of birth ${d.dob}` : ""}`),
    ...lines("1040.", "1040.1a", "1040.11"),
  ];
  const dep = cfg.deposit === undefined ? null : cfg.deposit;
  const p2 = [
    `Form 1040 (${y}) Page 2`,
    ...lines("1040.", "1040.12", "1040.24"),
    "25 Federal income tax withheld from:",
    ...lines("1040.", "1040.25a", "1040.35a"),
    ...(dep ? [`b Routing number ${dep.routing} c Type: ${box(dep.type === "Checking")} Checking ${box(dep.type === "Savings")} Savings`, `d Account number ${dep.account}`] : ["b Routing number c Type: [ ] Checking [ ] Savings", "d Account number"]),
    ...lines("1040.", "1040.36", "1040.38"),
  ];
  const pages: string[][] = [p1, p2];
  const name = `${cfg.taxpayer.first} ${cfg.taxpayer.last}${cfg.spouse ? ` & ${cfg.spouse.first} ${cfg.spouse.last}` : ""}`;
  if (cfg.forms?.sa) {
    pages.push([
      `SCHEDULE A (Form 1040) Itemized Deductions ${y} OMB No. 1545-0074`,
      `Name(s) shown on Form 1040 or 1040-SR ${name} Your social security number 400-00-1234`,
      "Medical and Dental Expenses Caution: Do not include expenses reimbursed or paid by others.",
      ...lines("SA.", "SA.1", "SA.4"),
      "Taxes You Paid 5 State and local taxes.",
      ...lines("SA.", "SA.5a", "SA.7"),
      "Interest You Paid 8 Home mortgage interest and points. If you didn't use all of your home mortgage loan(s) to buy, build, or improve your home, see instructions and check this box",
      ...lines("SA.", "SA.8a", "SA.10"),
      "Gifts to Charity",
      ...lines("SA.", "SA.11", "SA.14"),
      "Casualty and Theft Losses",
      ...lines("SA.", "SA.15", "SA.17"),
      "18 If you elect to itemize deductions even though they are less than your standard deduction, check this box",
    ]);
  }
  if (cfg.forms?.s8812) {
    pages.push([
      `SCHEDULE 8812 (Form 1040) Credits for Qualifying Children and Other Dependents ${y}`,
      `Name(s) shown on return ${name}`,
      ...lines("8812.", "8812.4", "8812.6"),
      ...lines("8812.", "8812.12", "8812.27"),
    ]);
  }
  if (cfg.forms?.al) {
    pages.push([
      `FORM 40 Alabama Individual Income Tax Return ${cfg.alYear ?? y} ALABAMA DEPARTMENT OF REVENUE`,
      `Your first name and initial ${cfg.taxpayer.first} Last name ${cfg.taxpayer.last} Your social security number 400-00-1234`,
      ...lines("AL40."),
    ]);
  }
  if (cfg.forms?.alsa) {
    pages.push([`SCHEDULE A Alabama Itemized Deductions ${cfg.alYear ?? y} FORM 40`, `Name ${name}`, ...lines("ALSA.")]);
  }
  pages.push(["Form 8879 IRS e-file Signature Authorization " + y, "Do not send to the IRS. Keep for your records."]);
  pages.push(...(cfg.extraPages ?? []));
  return pages.map((p) => p.map((l) => (cfg.replace ?? []).reduce((s, [a, b]) => s.split(a).join(b), l)));
}

/** Jordan Sample (Head of Household, two children) — the numbers from the approved mockup. */
export const jordan = (over: Partial<ReturnCfg> = {}): ReturnCfg => ({
  taxpayer: { first: "Jordan", last: "Sample" },
  status: "HOH",
  dependents: [
    { name: "Ava Sample", ssn: "400-00-0001", rel: "Daughter", dob: "03/14/2016" },
    { name: "Mason Sample", ssn: "400-00-0002", rel: "Son", dob: "07/02/2019" },
  ],
  deposit: { routing: "062000019", account: "000012344821", type: "Checking" },
  forms: { sa: true, s8812: true, al: true, alsa: true },
  ...over,
  v: {
    "1040.1a": 62000, "1040.1z": 62000, "1040.9": 62000, "1040.11": 62000, "1040.12": 23625, "1040.14": 23625, "1040.15": 38375, "1040.16": 4265,
    "1040.18": 4265, "1040.19": 4265, "1040.21": 4265, "1040.22": 0, "1040.24": 0, "1040.25a": 4800, "1040.25d": 4800, "1040.28": 135, "1040.32": 135,
    "1040.33": 4935, "1040.34": 4935, "1040.35a": 4935,
    "SA.1": 1800, "SA.2": 62000, "SA.3": 4650, "SA.4": 0, "SA.5b": 950, "SA.5c": 210, "SA.5d": 1160, "SA.5e": 1160, "SA.7": 1160, "SA.8a": 8400, "SA.8e": 8400, "SA.10": 8400, "SA.11": 1200, "SA.14": 1200, "SA.17": 10760,
    "8812.4": 2, "8812.6": 0, "8812.12": 4400, "8812.14": 4265, "8812.27": 135,
    "AL40.10": 62000, "AL40.11": 10760, "AL40.13": 3000, "AL40.14": 1000, "AL40.15": 14760, "AL40.16": 47240, "AL40.17": 2322, "AL40.19": 2322, "AL40.20": 2900, "AL40.22": 2900, "AL40.23": 578, "AL40.25": 578,
    "ALSA.1": 1800, "ALSA.2": 62000, "ALSA.3": 2480, "ALSA.4": 0, "ALSA.5": 950, "ALSA.6": 210, "ALSA.8": 1160, "ALSA.9": 8400, "ALSA.13": 8400, "ALSA.14": 1200, "ALSA.17": 1200, "ALSA.19": 10760,
    ...(over.v ?? {}),
  },
});

/** Riley & Casey Example: married filing jointly, standard deduction, no state return. */
export const jointCouple = (over: Partial<ReturnCfg> = {}): ReturnCfg => ({
  taxpayer: { first: "Riley", last: "Example" },
  spouse: { first: "Casey", last: "Example" },
  status: "MFJ",
  dependents: [],
  deposit: { routing: "062000019", account: "000099991111", type: "Savings" },
  forms: {},
  ...over,
  v: {
    "1040.1a": 98000, "1040.1z": 98000, "1040.2b": 400, "1040.9": 98400, "1040.11": 98400, "1040.12": 31500, "1040.14": 31500, "1040.15": 66900, "1040.16": 7570,
    "1040.18": 7570, "1040.21": 0, "1040.22": 7570, "1040.24": 7570, "1040.25a": 8200, "1040.25d": 8200, "1040.33": 8200, "1040.34": 630, "1040.35a": 630,
    ...(over.v ?? {}),
  },
});

/** Morgan Owes: single, owes the IRS and Alabama (standard deduction both). */
export const owes = (over: Partial<ReturnCfg> = {}): ReturnCfg => ({
  taxpayer: { first: "Morgan", last: "Owes" },
  status: "SINGLE",
  dependents: [],
  deposit: null,
  forms: { al: true },
  ...over,
  v: {
    "1040.1a": 30000, "1040.1z": 30000, "1040.8": 12000, "1040.9": 42000, "1040.11": 42000, "1040.12": 15750, "1040.14": 15750, "1040.15": 26250, "1040.16": 2911,
    "1040.18": 2911, "1040.22": 2911, "1040.23": 1700, "1040.24": 4611, "1040.25a": 3361, "1040.25d": 3361, "1040.33": 3361, "1040.37": 1250,
    "AL40.10": 42000, "AL40.11": 2500, "AL40.12": 4611, "AL40.13": 1500, "AL40.15": 8611, "AL40.16": 33389, "AL40.17": 1559, "AL40.19": 1559, "AL40.20": 1439, "AL40.22": 1439, "AL40.26": 120,
    ...(over.v ?? {}),
  },
});

export async function toPdf(pages: string[][]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([612, 1008]);
    lines.forEach((l, i) => page.drawText(l, { x: 20, y: 980 - i * 13, size: 6, font }));
  }
  return new Uint8Array(await doc.save());
}

export const returnPdf = (cfg: ReturnCfg) => toPdf(returnPages(cfg));

/** A signed Form 8879 (fictional). */
export function form8879Pages(o: { year?: number; taxpayer: Person; spouse?: Person; agi: number; totalTax: number; withheld: number; refund?: number; owe?: number }) {
  const y = o.year ?? 2025;
  return [[
    `Form 8879 IRS e-file Signature Authorization ${y} OMB No. 1545-0074`,
    `Taxpayer's name ${o.taxpayer.first} ${o.taxpayer.last} Social security number 400-00-1234`,
    `Spouse's name ${o.spouse ? `${o.spouse.first} ${o.spouse.last}` : ""} Spouse's social security number`,
    "Part I Tax Return Information — Tax Year Ending December 31 (Whole dollars only)",
    `1 Adjusted gross income . . . . 1 ${fmt(o.agi)}`,
    `2 Total tax . . . . . . . 2 ${fmt(o.totalTax)}`,
    `3 Federal income tax withheld from Form(s) W-2 and Form(s) 1099 . . 3 ${fmt(o.withheld)}`,
    `4 Amount you want refunded to you . . . 4${o.refund !== undefined ? ` ${fmt(o.refund)}` : ""}`,
    `5 Amount you owe . . . . . . 5${o.owe !== undefined ? ` ${fmt(o.owe)}` : ""}`,
    "Part II Taxpayer Declaration and Signature Authorization",
    `Your signature ${o.taxpayer.first} ${o.taxpayer.last} (signed electronically) Date 11/06/2026`,
  ]];
}
