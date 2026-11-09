/**
 * Line map: which printed label on which form is read for each value.
 *
 * STATUS: UNVERIFIED. The official 2025 forms could not be downloaded from
 * irs.gov or revenue.alabama.gov while this was built (the network refused),
 * so these line numbers and label wordings follow the published 2024 layouts
 * and the 2025 changes known at the time. Everything about a line lives in
 * this one table so it is easy to correct after checking the 2025 forms and
 * a sample TaxAct print:
 *  - `line` is only a fallback for the source shown to the client: when the
 *    line number is printed next to the amount in the PDF, that printed
 *    number is shown instead.
 *  - `re` are the printed label patterns (case, spacing, commas and periods
 *    are ignored). A label must be found for a required value, and a label
 *    found twice with different amounts is ambiguous (the summary is held).
 *  - `after` anchors the search behind another printed phrase (for labels
 *    such as "Form(s) W-2" that also appear earlier on the form).
 */

export type FormCode = "F1040" | "S1" | "S2" | "S3" | "SA" | "S8812" | "AL40" | "ALSA" | "F8879";

export const FORM_NAMES: Record<FormCode, string> = {
  F1040: "Form 1040",
  S1: "Schedule 1",
  S2: "Schedule 2",
  S3: "Schedule 3",
  SA: "Schedule A",
  S8812: "Schedule 8812",
  AL40: "Alabama Form 40",
  ALSA: "Alabama Schedule A",
  F8879: "Form 8879",
};

export type FieldDef = {
  id: string;
  form: FormCode;
  line: string;
  label: string;
  re: RegExp[];
  after?: RegExp;
  /** "count" = a number of people (8812), not dollars. */
  kind?: "cents" | "count";
  /** Must be printed on the form whenever the form is in the PDF. */
  required?: boolean;
};

/**
 * Builds a tolerant pattern from printed wording: spacing may be missing or
 * doubled, commas, periods and apostrophes are optional, dashes may be any dash.
 */
export function phrase(text: string) {
  const src = text
    .trim()
    .split("")
    .map((ch) => {
      if (/\s/.test(ch)) return " ";
      if (ch === ",") return ",?";
      if (ch === ".") return "\\.?";
      if (ch === "'" || ch === "’") return "['’]?";
      if (ch === "-" || ch === "—" || ch === "–") return "[-—–]";
      return ch.replace(/[\\^$*+?()[\]{}|/]/g, "\\$&");
    })
    .join("")
    .replace(/ +/g, "\\s*");
  return new RegExp(src, "i");
}
const P = (...texts: string[]) => texts.map(phrase);

// prettier-ignore
export const FIELDS: FieldDef[] = [
  // --- Form 1040 (2025) ----------------------------------------------------------------
  { id: "1040.1a", form: "F1040", line: "1a", label: "Wages from Form(s) W-2", re: P("Total amount from Form(s) W-2, box 1 (see instructions)", "Total amount from Form(s) W-2, box 1") },
  { id: "1040.1z", form: "F1040", line: "1z", label: "Total wages", re: P("Add lines 1a through 1h"), required: true },
  { id: "1040.2b", form: "F1040", line: "2b", label: "Taxable interest", re: P("Taxable interest") },
  { id: "1040.3b", form: "F1040", line: "3b", label: "Ordinary dividends", re: P("Ordinary dividends") },
  { id: "1040.4b", form: "F1040", line: "4b", label: "IRA distributions, taxable amount", re: [/IRA\s*distributions[^\n]*?taxable\s*amount/i] },
  { id: "1040.5b", form: "F1040", line: "5b", label: "Pensions and annuities, taxable amount", re: [/pensions\s*and\s*annuities[^\n]*?taxable\s*amount/i] },
  { id: "1040.6b", form: "F1040", line: "6b", label: "Social security benefits, taxable amount", re: [/social\s*security\s*benefits[^\n]*?taxable\s*amount/i] },
  { id: "1040.7", form: "F1040", line: "7", label: "Capital gain or (loss)", re: P("Capital gain or (loss). Attach Schedule D if required. If not required, check here", "Capital gain or (loss). Attach Schedule D if required", "Capital gain or (loss)") },
  { id: "1040.8", form: "F1040", line: "8", label: "Additional income from Schedule 1", re: P("Additional income from Schedule 1, line 10") },
  { id: "1040.9", form: "F1040", line: "9", label: "Total income", re: P("This is your total income"), required: true },
  { id: "1040.10", form: "F1040", line: "10", label: "Adjustments to income", re: P("Adjustments to income from Schedule 1, line 26") },
  { id: "1040.11", form: "F1040", line: "11", label: "Adjusted gross income", re: P("This is your adjusted gross income"), required: true },
  { id: "1040.12", form: "F1040", line: "12", label: "Standard deduction or itemized deductions", re: P("Standard deduction or itemized deductions (from Schedule A)", "Standard deduction or itemized deductions"), required: true },
  { id: "1040.13", form: "F1040", line: "13", label: "Qualified business income deduction", re: P("Qualified business income deduction from Form 8995 or Form 8995-A", "Qualified business income deduction") },
  { id: "1040.13b", form: "F1040", line: "13b", label: "Additional deductions from Schedule 1-A", re: [/(?:additional\s*deductions\s*)?from\s*schedule\s*1[-—–]A(?:,?\s*line\s*\d+)?/i] },
  { id: "1040.14", form: "F1040", line: "14", label: "Total deductions", re: [/add\s*lines\s*12\s*and\s*13(?:a?\s*and\s*13b)?|add\s*lines\s*12,?\s*13a,?\s*and\s*13b/i] },
  { id: "1040.15", form: "F1040", line: "15", label: "Taxable income", re: P("This is your taxable income"), required: true },
  { id: "1040.16", form: "F1040", line: "16", label: "Tax", re: [/\btax\s*\(see\s*instructions\)\.?(?:\s*check\s*if\s*any\s*from\s*form\(?s\)?:?\s*1\s*\S?\s*8814\s*2\s*\S?\s*4972\s*3\s*\S?)?/i], required: true },
  { id: "1040.17", form: "F1040", line: "17", label: "Amount from Schedule 2, line 3", re: P("Amount from Schedule 2, line 3") },
  { id: "1040.18", form: "F1040", line: "18", label: "Tax plus Schedule 2", re: P("Add lines 16 and 17") },
  { id: "1040.19", form: "F1040", line: "19", label: "Child tax credit or credit for other dependents", re: P("Child tax credit or credit for other dependents from Schedule 8812", "Child tax credit or credit for other dependents") },
  { id: "1040.20", form: "F1040", line: "20", label: "Amount from Schedule 3, line 8", re: P("Amount from Schedule 3, line 8") },
  { id: "1040.21", form: "F1040", line: "21", label: "Total credits", re: P("Add lines 19 and 20") },
  { id: "1040.22", form: "F1040", line: "22", label: "Tax after credits", re: P("Subtract line 21 from line 18. If zero or less, enter -0-", "Subtract line 21 from line 18") },
  { id: "1040.23", form: "F1040", line: "23", label: "Other taxes from Schedule 2", re: P("Other taxes, including self-employment tax, from Schedule 2, line 21") },
  { id: "1040.24", form: "F1040", line: "24", label: "Total tax", re: P("This is your total tax"), required: true },
  { id: "1040.25a", form: "F1040", line: "25a", label: "Federal income tax withheld, Form(s) W-2", re: P("Form(s) W-2"), after: phrase("Federal income tax withheld from") },
  { id: "1040.25b", form: "F1040", line: "25b", label: "Federal income tax withheld, Form(s) 1099", re: P("Form(s) 1099"), after: phrase("Federal income tax withheld from") },
  { id: "1040.25c", form: "F1040", line: "25c", label: "Federal income tax withheld, other forms", re: P("Other forms (see instructions)"), after: phrase("Federal income tax withheld from") },
  { id: "1040.25d", form: "F1040", line: "25d", label: "Total federal income tax withheld", re: P("Add lines 25a through 25c") },
  { id: "1040.26", form: "F1040", line: "26", label: "Estimated tax payments", re: [/(?:20\d\d\s*)?estimated\s*tax\s*payments\s*and\s*amount\s*applied\s*from\s*(?:20\d\d\s*)?return/i] },
  { id: "1040.27", form: "F1040", line: "27", label: "Earned income credit", re: P("Earned income credit (EIC)") },
  { id: "1040.28", form: "F1040", line: "28", label: "Additional child tax credit", re: P("Additional child tax credit from Schedule 8812") },
  { id: "1040.29", form: "F1040", line: "29", label: "American opportunity credit", re: P("American opportunity credit from Form 8863, line 8") },
  { id: "1040.30", form: "F1040", line: "30", label: "Refundable adoption credit", re: [/refundable\s*adoption\s*credit[^\n]*?form\s*8839(?:,?\s*line\s*\d+)?/i] },
  { id: "1040.31", form: "F1040", line: "31", label: "Amount from Schedule 3, line 15", re: P("Amount from Schedule 3, line 15") },
  { id: "1040.32", form: "F1040", line: "32", label: "Total other payments and refundable credits", re: P("These are your total other payments and refundable credits") },
  { id: "1040.33", form: "F1040", line: "33", label: "Total payments", re: P("These are your total payments"), required: true },
  { id: "1040.34", form: "F1040", line: "34", label: "Amount overpaid", re: P("This is the amount you overpaid") },
  { id: "1040.35a", form: "F1040", line: "35a", label: "Refund", re: P("Amount of line 34 you want refunded to you. If Form 8888 is attached, check here", "Amount of line 34 you want refunded to you") },
  { id: "1040.36", form: "F1040", line: "36", label: "Applied to next year's estimated tax", re: [/amount\s*of\s*line\s*34\s*you\s*want\s*applied\s*to\s*your\s*(?:20\d\d\s*)?estimated\s*tax/i] },
  { id: "1040.37", form: "F1040", line: "37", label: "Amount you owe", re: [/this\s*is\s*the\s*amount\s*you\s*owe(?:\.?\s*for\s*details\s*on\s*how\s*to\s*pay,?\s*go\s*to\s*\S+\s*or\s*see\s*instructions)?/i] },
  { id: "1040.38", form: "F1040", line: "38", label: "Estimated tax penalty", re: P("Estimated tax penalty (see instructions)", "Estimated tax penalty") },

  // --- Schedules 1, 2, 3 (totals only) ---------------------------------------------------
  { id: "S1.10", form: "S1", line: "10", label: "Additional income", re: [/combine\s*lines\s*1\s*through\s*7\s*and\s*9[^\n]*?line\s*8\b/i, /this\s*is\s*your\s*additional\s*income/i], required: true },
  { id: "S1.26", form: "S1", line: "26", label: "Adjustments to income", re: [/these\s*are\s*your\s*adjustments\s*to\s*income[^\n]*?line\s*10\b/i, /these\s*are\s*your\s*adjustments\s*to\s*income/i], required: true },
  { id: "S2.3", form: "S2", line: "3", label: "Additional tax", re: [/add\s*lines\s*1z?\s*and\s*2[^\n]*?line\s*17\b/i], required: true },
  { id: "S2.21", form: "S2", line: "21", label: "Total other taxes", re: [/these\s*are\s*your\s*total\s*other\s*taxes[^\n]*?line\s*23\b/i, /these\s*are\s*your\s*total\s*other\s*taxes/i], required: true },
  { id: "S3.8", form: "S3", line: "8", label: "Nonrefundable credits", re: [/enter\s*here\s*and\s*on\s*form\s*1040[^\n]*?line\s*20\b/i], required: true },
  { id: "S3.15", form: "S3", line: "15", label: "Other payments and refundable credits", re: [/enter\s*here\s*and\s*on\s*form\s*1040[^\n]*?line\s*31\b/i], required: true },

  // --- Schedule A (Form 1040) ----------------------------------------------------------
  { id: "SA.1", form: "SA", line: "1", label: "Medical and dental expenses", re: P("Medical and dental expenses (see instructions)", "Medical and dental expenses"), required: true },
  { id: "SA.2", form: "SA", line: "2", label: "Adjusted gross income (from Form 1040, line 11)", re: [/enter\s*amount\s*from\s*form\s*1040[^\n]*?line\s*11\b/i] },
  { id: "SA.3", form: "SA", line: "3", label: "7.5% of adjusted gross income", re: [/multiply\s*line\s*2\s*by\s*7\.5\s*%\s*(?:\(0?\.075\))?/i] },
  { id: "SA.4", form: "SA", line: "4", label: "Medical and dental expenses that count", re: [/subtract\s*line\s*3\s*from\s*line\s*1\.?(?:\s*if\s*line\s*3\s*is\s*more\s*than\s*line\s*1,?\s*enter\s*-0-)?/i], required: true },
  { id: "SA.5a", form: "SA", line: "5a", label: "State and local income or sales taxes", re: [/state\s*and\s*local\s*income\s*taxes\s*or\s*general\s*sales\s*taxes[^\n]*?check\s*this\s*box/i, /state\s*and\s*local\s*income\s*taxes\s*or\s*general\s*sales\s*taxes/i] },
  { id: "SA.5b", form: "SA", line: "5b", label: "State and local real estate taxes", re: P("State and local real estate taxes (see instructions)", "State and local real estate taxes") },
  { id: "SA.5c", form: "SA", line: "5c", label: "State and local personal property taxes", re: P("State and local personal property taxes") },
  { id: "SA.5d", form: "SA", line: "5d", label: "Total state and local taxes", re: P("Add lines 5a through 5c") },
  { id: "SA.5e", form: "SA", line: "5e", label: "State and local taxes that count", re: [/enter\s*the\s*smaller\s*of\s*line\s*5d\s*or[^\n]*?(?:separately\)|worksheet)/i] },
  { id: "SA.6", form: "SA", line: "6", label: "Other taxes", re: P("Other taxes. List type and amount") },
  { id: "SA.7", form: "SA", line: "7", label: "Total taxes", re: P("Add lines 5e and 6") },
  { id: "SA.8a", form: "SA", line: "8a", label: "Home mortgage interest reported on Form 1098", re: P("Home mortgage interest and points reported to you on Form 1098. See instructions if limited", "Home mortgage interest and points reported to you on Form 1098") },
  { id: "SA.8b", form: "SA", line: "8b", label: "Home mortgage interest not reported on Form 1098", re: P("Home mortgage interest not reported to you on Form 1098") },
  { id: "SA.8c", form: "SA", line: "8c", label: "Points not reported on Form 1098", re: P("Points not reported to you on Form 1098") },
  { id: "SA.8e", form: "SA", line: "8e", label: "Total home mortgage interest", re: [/add\s*lines\s*8a\s*through\s*8[cd]/i] },
  { id: "SA.9", form: "SA", line: "9", label: "Investment interest", re: P("Investment interest. Attach Form 4952 if required", "Investment interest") },
  { id: "SA.10", form: "SA", line: "10", label: "Total interest", re: P("Add lines 8e and 9") },
  { id: "SA.11", form: "SA", line: "11", label: "Gifts by cash or check", re: [/gifts\s*by\s*cash\s*or\s*check(?:\.?\s*if\s*you\s*made\s*any\s*gift\s*of\s*\$?250\s*or\s*more,?\s*see\s*instructions)?/i] },
  { id: "SA.12", form: "SA", line: "12", label: "Gifts other than by cash or check", re: [/other\s*than\s*by\s*cash\s*or\s*check(?:[^\n]*?over\s*\$?500)?/i] },
  { id: "SA.13", form: "SA", line: "13", label: "Carryover from prior year", re: P("Carryover from prior year") },
  { id: "SA.14", form: "SA", line: "14", label: "Total gifts to charity", re: P("Add lines 11 through 13") },
  { id: "SA.15", form: "SA", line: "15", label: "Casualty and theft losses", re: [/casualty\s*and\s*theft\s*loss(?:\(?es\)?)?[^\n]*?see\s*instructions/i] },
  { id: "SA.16", form: "SA", line: "16", label: "Other itemized deductions", re: [/other\s*[-—–]\s*from\s*list\s*in\s*instructions\.?\s*list\s*type\s*and\s*amount/i] },
  { id: "SA.17", form: "SA", line: "17", label: "Total itemized deductions", re: [/add\s*the\s*amounts\s*in\s*the\s*far\s*right\s*column\s*for\s*lines\s*4\s*through\s*16[^\n]*?line\s*12\b/i, /add\s*the\s*amounts\s*in\s*the\s*far\s*right\s*column\s*for\s*lines\s*4\s*through\s*16/i], required: true },

  // --- Schedule 8812 ---------------------------------------------------------------------
  { id: "8812.4", form: "S8812", line: "4", label: "Qualifying children", kind: "count", re: [/number\s*of\s*qualifying\s*children\s*under\s*(?:age\s*)?17\s*with\s*the\s*required\s*social\s*security\s*number/i] },
  { id: "8812.6", form: "S8812", line: "6", label: "Other dependents", kind: "count", re: [/number\s*of\s*other\s*dependents[^\n]*?social\s*security\s*number/i] },
  { id: "8812.12", form: "S8812", line: "12", label: "Child tax credit and credit for other dependents before the tax limit", re: P("Subtract line 11 from line 8. If zero or less, enter -0-", "Subtract line 11 from line 8") },
  { id: "8812.14", form: "S8812", line: "14", label: "Child tax credit and credit for other dependents", re: [/this\s*is\s*your\s*child\s*tax\s*credit\s*and\s*credit\s*for\s*other\s*dependents(?:\.?\s*enter\s*this\s*amount\s*on\s*form\s*1040[^\n]*?line\s*19\b)?/i], required: true },
  { id: "8812.27", form: "S8812", line: "27", label: "Additional child tax credit", re: [/this\s*is\s*your\s*additional\s*child\s*tax\s*credit(?:\.?\s*enter\s*this\s*amount\s*on\s*form\s*1040[^\n]*?line\s*28\b)?/i] },

  // --- Alabama Form 40 (2025) -------------------------------------------------------------
  { id: "AL40.10", form: "AL40", line: "10", label: "Alabama adjusted gross income", re: [/(?:total\s*)?adjusted\s*gross\s*income(?:\s*\(subtract\s*line\s*\d+\s*from\s*line\s*\d+\))?/i], required: true },
  { id: "AL40.11", form: "AL40", line: "11", label: "Standard deduction or itemized deductions", re: P("Standard deduction or itemized deductions (Schedule A)", "Standard deduction or itemized deductions"), required: true },
  { id: "AL40.12", form: "AL40", line: "12", label: "Federal tax deduction", re: P("Federal tax deduction") },
  { id: "AL40.13", form: "AL40", line: "13", label: "Personal exemption", re: P("Personal exemption") },
  { id: "AL40.14", form: "AL40", line: "14", label: "Dependent exemption", re: P("Dependent exemption") },
  { id: "AL40.15", form: "AL40", line: "15", label: "Total deductions", re: P("Total deductions (add lines 11 through 14)", "Total deductions") },
  { id: "AL40.16", form: "AL40", line: "16", label: "Alabama taxable income", re: P("Taxable income (subtract line 15 from line 10)", "Taxable income"), required: true },
  { id: "AL40.17", form: "AL40", line: "17", label: "Alabama income tax", re: P("Income tax due"), required: true },
  { id: "AL40.18", form: "AL40", line: "18", label: "Alabama nonrefundable credits", re: P("Total nonrefundable credits", "Nonrefundable credits") },
  { id: "AL40.19", form: "AL40", line: "19", label: "Net Alabama tax", re: P("Net tax liability", "Net tax due") },
  { id: "AL40.20", form: "AL40", line: "20", label: "Alabama income tax withheld", re: P("Alabama income tax withheld") },
  { id: "AL40.21", form: "AL40", line: "21", label: "Alabama estimated tax payments", re: P("Estimated tax payments") },
  { id: "AL40.22", form: "AL40", line: "22", label: "Total Alabama payments", re: P("Total payments"), required: true },
  { id: "AL40.23", form: "AL40", line: "23", label: "Alabama amount overpaid", re: P("Amount overpaid") },
  { id: "AL40.24", form: "AL40", line: "24", label: "Applied to next year's Alabama estimated tax", re: [/amount\s*applied\s*to\s*(?:your\s*)?(?:20\d\d\s*)?estimated\s*tax/i] },
  { id: "AL40.25", form: "AL40", line: "25", label: "Alabama refund", re: P("Amount to be refunded") },
  { id: "AL40.26", form: "AL40", line: "26", label: "Alabama amount you owe", re: P("Amount you owe") },

  // --- Alabama Schedule A ---------------------------------------------------------------
  { id: "ALSA.1", form: "ALSA", line: "1", label: "Medical and dental expenses", re: P("Medical and dental expenses"), required: true },
  { id: "ALSA.2", form: "ALSA", line: "2", label: "Alabama adjusted gross income (from Form 40, line 10)", re: [/enter\s*amount\s*from\s*form\s*40[^\n]*?line\s*10\b/i] },
  { id: "ALSA.3", form: "ALSA", line: "3", label: "4% of Alabama adjusted gross income", re: [/multiply\s*line\s*2\s*by\s*4\s*%\s*(?:\(0?\.04\))?/i] },
  { id: "ALSA.4", form: "ALSA", line: "4", label: "Medical and dental expenses that count", re: [/subtract\s*line\s*3\s*from\s*line\s*1\.?(?:\s*if\s*(?:line\s*3\s*is\s*more\s*than\s*line\s*1|zero\s*or\s*less),?\s*enter\s*-0-)?/i], required: true },
  { id: "ALSA.5", form: "ALSA", line: "5", label: "Real estate taxes", re: P("Real estate taxes") },
  { id: "ALSA.6", form: "ALSA", line: "6", label: "Personal property taxes", re: P("Personal property taxes") },
  { id: "ALSA.7", form: "ALSA", line: "7", label: "Other taxes", re: P("Other taxes") },
  { id: "ALSA.8", form: "ALSA", line: "8", label: "Total taxes", re: P("Add lines 5 through 7") },
  { id: "ALSA.9", form: "ALSA", line: "9", label: "Home mortgage interest reported on Form 1098", re: P("Home mortgage interest and points reported to you on Form 1098", "Home mortgage interest reported on Form 1098") },
  { id: "ALSA.10", form: "ALSA", line: "10", label: "Home mortgage interest not reported on Form 1098", re: P("Home mortgage interest not reported to you on Form 1098") },
  { id: "ALSA.11", form: "ALSA", line: "11", label: "Points not reported on Form 1098", re: P("Points not reported to you on Form 1098") },
  { id: "ALSA.12", form: "ALSA", line: "12", label: "Investment interest", re: P("Investment interest") },
  { id: "ALSA.13", form: "ALSA", line: "13", label: "Total interest", re: P("Add lines 9 through 12") },
  { id: "ALSA.14", form: "ALSA", line: "14", label: "Gifts by cash or check", re: P("Gifts by cash or check") },
  { id: "ALSA.15", form: "ALSA", line: "15", label: "Gifts other than by cash or check", re: P("Other than by cash or check") },
  { id: "ALSA.16", form: "ALSA", line: "16", label: "Carryover from prior year", re: P("Carryover from prior year") },
  { id: "ALSA.17", form: "ALSA", line: "17", label: "Total gifts to charity", re: P("Add lines 14 through 16") },
  { id: "ALSA.18", form: "ALSA", line: "18", label: "Other itemized deductions", re: P("Other miscellaneous deductions", "Other itemized deductions") },
  { id: "ALSA.19", form: "ALSA", line: "19", label: "Total Alabama itemized deductions", re: P("Total itemized deductions"), required: true },
];

// --- Form 8879 (IRS e-file Signature Authorization), Part I -------------------------------
// Read only from a separately uploaded signed 8879, to compare with the approved summary.
FIELDS.push(
  { id: "8879.1", form: "F8879", line: "1", label: "Adjusted gross income", re: P("Adjusted gross income") },
  { id: "8879.2", form: "F8879", line: "2", label: "Total tax", re: P("Total tax") },
  { id: "8879.3", form: "F8879", line: "3", label: "Federal income tax withheld", re: [/federal\s*income\s*tax\s*withheld\s*from\s*form\(?s\)?\s*W-2\s*and\s*form\(?s\)?\s*1099/i] },
  { id: "8879.4", form: "F8879", line: "4", label: "Amount you want refunded to you", re: P("Amount you want refunded to you") },
  { id: "8879.5", form: "F8879", line: "5", label: "Amount you owe", re: P("Amount you owe") },
);

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.id, f])) as Record<string, FieldDef>;
export const fieldsOf = (form: FormCode) => FIELDS.filter((f) => f.form === form);
