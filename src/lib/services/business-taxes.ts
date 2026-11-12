import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { assertLedger } from "./ledger";
import { addBusinessLicense } from "./business-overview";
import { todayCentral } from "./square-billing";

/**
 * Business Taxes & Filings: every tax, return and renewal one business owes through the year
 * (sales, use, city/county, liquor, lodging, Business Privilege Tax, payroll returns, property tax,
 * licenses...), with its agency, account number and schedule, and a log of each period filed and
 * what was paid. Staff-only; nothing here files anything or contacts an agency.
 *
 * Due dates come from the schedule set on each item (frequency + due day). The catalog fills in the
 * usual Alabama/federal schedule; staff change it when the agency gave the business another one.
 * Licenses go to the existing Business Licenses records (renewal dates), shown on the same page.
 */

export const FREQUENCIES = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMIANNUAL: "Twice a year", ANNUAL: "Yearly" } as const;
export type Frequency = keyof typeof FREQUENCIES;

export type TaxFacts = {
  entityType: string | null;
  payroll: boolean;
  state: string | null;
  city: string | null;
  /** Names of the business's ledger accounts, deadlines and earlier documents, for keyword hints. */
  words: string[];
  contractors: boolean;
};

type CatalogItem = {
  key: string;
  label: string;
  group: "Sales & excise" | "Licenses" | "Annual business filings" | "Payroll" | "Property";
  agency: string;
  frequency: Frequency;
  dueDay: number;
  dueMonth?: number;
  coversPriorYear?: boolean;
  /** Goes to Business Licenses (renewal date) instead of the tax list. */
  license?: boolean;
  help: string;
  suggest: (f: TaxFacts) => string | null;
};

const has = (f: TaxFacts, re: RegExp) => f.words.some((w) => re.test(w));
const isBusinessEntity = (f: TaxFacts) => !!f.entityType && f.entityType !== "NONPROFIT" && f.entityType !== "TRUST_ESTATE";
const inAlabama = (f: TaxFacts) => !f.state || /^(AL|alabama)$/i.test(f.state.trim());
const sellsTaxable = (f: TaxFacts) => has(f, /sales tax/i);

/** Usual schedules (Alabama and federal). Every one can be changed per business. */
export const TAX_CATALOG: CatalogItem[] = [
  { key: "STATE_SALES", label: "State sales tax", group: "Sales & excise", agency: "Alabama Department of Revenue (My Alabama Taxes)", frequency: "MONTHLY", dueDay: 20, help: "Due the 20th of the next month. Some small accounts file quarterly or yearly; change the schedule if so.", suggest: (f) => (sellsTaxable(f) ? "The books or deadlines show sales tax." : null) },
  { key: "LOCAL_SALES", label: "City / county sales tax", group: "Sales & excise", agency: "City or county (self-administered, or through ONE SPOT)", frequency: "MONTHLY", dueDay: 20, help: "Local sales tax where the business sells. Many Alabama cities collect it themselves.", suggest: (f) => (sellsTaxable(f) && inAlabama(f) ? `Local sales tax usually goes with state sales tax${f.city ? ` (${f.city})` : ""}.` : null) },
  { key: "USE_TAX", label: "Consumer use tax", group: "Sales & excise", agency: "Alabama Department of Revenue", frequency: "MONTHLY", dueDay: 20, help: "Tax on taxable items bought without sales tax (out-of-state or online purchases).", suggest: (f) => (has(f, /use tax/i) ? "The books show use tax." : null) },
  { key: "RENTAL_TAX", label: "Rental / leasing tax", group: "Sales & excise", agency: "Alabama Department of Revenue and the city/county", frequency: "MONTHLY", dueDay: 20, help: "On rentals of tangible personal property (equipment, vehicles).", suggest: (f) => (has(f, /equipment rental income|rental tax|leasing tax/i) ? "The books show rental or leasing income or tax." : null) },
  { key: "LODGING_TAX", label: "Lodgings tax", group: "Sales & excise", agency: "Alabama Department of Revenue and the city/county", frequency: "MONTHLY", dueDay: 20, help: "Hotels, short-term rentals and other lodging.", suggest: (f) => (has(f, /lodging|hotel|motel|airbnb|short[- ]term rental/i) ? "The books mention lodging or short-term rentals." : null) },
  { key: "LIQUOR_TAX", label: "Local liquor / beer / wine tax", group: "Sales & excise", agency: "City or county (and ABC Board where it applies)", frequency: "MONTHLY", dueDay: 20, help: "Local alcoholic beverage taxes. Due dates vary by city and county — confirm the schedule.", suggest: (f) => (has(f, /liquor|alcohol|beer|wine|spirits|\bbar\b/i) ? "The books mention alcohol sales." : null) },
  { key: "TOBACCO_TAX", label: "Tobacco tax", group: "Sales & excise", agency: "Alabama Department of Revenue and the city/county", frequency: "MONTHLY", dueDay: 20, help: "Tobacco and vapor products.", suggest: (f) => (has(f, /tobacco|cigar|vape|vapor/i) ? "The books mention tobacco or vapor products." : null) },

  { key: "CITY_LICENSE", label: "City business license", group: "Licenses", agency: "City", frequency: "ANNUAL", dueDay: 31, dueMonth: 1, coversPriorYear: false, license: true, help: "Most Alabama cities renew by January 31 (penalties after).", suggest: (f) => (isBusinessEntity(f) ? `Every business in a city needs one${f.city ? ` (${f.city})` : ""}.` : null) },
  { key: "COUNTY_LICENSE", label: "County / state business license", group: "Licenses", agency: "County Probate Judge or License Commissioner", frequency: "ANNUAL", dueDay: 31, dueMonth: 10, coversPriorYear: false, license: true, help: "Alabama county licenses run October 1 to September 30; renew by October 31.", suggest: (f) => (isBusinessEntity(f) && inAlabama(f) ? "Alabama businesses usually need a county license too." : null) },
  { key: "ABC_LICENSE", label: "ABC Board alcohol license", group: "Licenses", agency: "Alabama Alcoholic Beverage Control Board", frequency: "ANNUAL", dueDay: 30, dueMonth: 9, coversPriorYear: false, license: true, help: "Alabama ABC licenses expire September 30 each year.", suggest: (f) => (has(f, /liquor|alcohol|beer|wine|spirits|\bbar\b/i) ? "The books mention alcohol sales." : null) },

  { key: "BPT", label: "Business Privilege Tax (and Annual Report)", group: "Annual business filings", agency: "Alabama Department of Revenue", frequency: "ANNUAL", dueDay: 15, dueMonth: 4, help: "Form PPT (LLCs, partnerships, S corporations) or CPT with the Annual Report (C corporations). Due with the income tax return: March 15 for partnerships and S corporations, April 15 for C corporations and single-member LLCs. Required of LLCs and corporations even when no tax is owed.", suggest: (f) => (inAlabama(f) && f.entityType && ["PARTNERSHIP", "S_CORP", "C_CORP"].includes(f.entityType) ? "Alabama LLCs and corporations file it every year." : inAlabama(f) && f.entityType === "SOLE_PROPRIETOR" ? "Needed if this sole proprietor is a single-member LLC." : null) },
  { key: "INCOME_TAX", label: "Business income tax returns (federal and Alabama)", group: "Annual business filings", agency: "IRS and Alabama Department of Revenue", frequency: "ANNUAL", dueDay: 15, dueMonth: 3, help: "1065 / Form 65 and 1120-S / Form 20S: March 15. 1120 / Form 20C and Schedule C: April 15. Change the month for this business.", suggest: (f) => (isBusinessEntity(f) ? "Every business files a yearly income tax return." : null) },
  { key: "FORM_1099", label: "1099-NEC / 1099-MISC to contractors and the IRS", group: "Annual business filings", agency: "IRS (and Alabama Department of Revenue)", frequency: "ANNUAL", dueDay: 31, dueMonth: 1, help: "Due January 31 for the year before.", suggest: (f) => (f.contractors ? "The business pays contractors." : null) },

  { key: "FED_941", label: "Federal payroll tax return (941)", group: "Payroll", agency: "IRS", frequency: "QUARTERLY", dueDay: 31, help: "Due the last day of the month after each quarter (deposits are separate, through EFTPS).", suggest: (f) => (f.payroll ? "The business runs payroll." : null) },
  { key: "FED_940", label: "Federal unemployment (940)", group: "Payroll", agency: "IRS", frequency: "ANNUAL", dueDay: 31, dueMonth: 1, help: "Due January 31 for the year before.", suggest: (f) => (f.payroll ? "The business runs payroll." : null) },
  { key: "W2_W3", label: "W-2s / W-3 (and Alabama A-3)", group: "Payroll", agency: "Social Security Administration and Alabama Department of Revenue", frequency: "ANNUAL", dueDay: 31, dueMonth: 1, help: "W-2s to employees and the SSA, and the Alabama A-3 reconciliation, by January 31.", suggest: (f) => (f.payroll ? "The business runs payroll." : null) },
  { key: "AL_WITHHOLDING", label: "Alabama withholding (A-6 monthly / A-1 quarterly)", group: "Payroll", agency: "Alabama Department of Revenue", frequency: "MONTHLY", dueDay: 15, help: "A-6 monthly filers: the 15th of the next month. A-1 quarterly filers: the last day of the month after the quarter.", suggest: (f) => (f.payroll && inAlabama(f) ? "The business runs payroll in Alabama." : null) },
  { key: "AL_UNEMPLOYMENT", label: "Alabama unemployment (state UI)", group: "Payroll", agency: "Alabama Department of Workforce", frequency: "QUARTERLY", dueDay: 31, help: "Contribution and wage report, due the last day of the month after each quarter.", suggest: (f) => (f.payroll && inAlabama(f) ? "The business runs payroll in Alabama." : null) },
  { key: "OCCUPATIONAL_TAX", label: "City occupational tax", group: "Payroll", agency: "City (e.g. Birmingham, Bessemer, Gadsden)", frequency: "QUARTERLY", dueDay: 31, help: "Some Alabama cities tax wages earned in the city. Confirm the city's schedule.", suggest: (f) => (f.payroll && f.city && /birmingham|bessemer|gadsden|auburn|opelika|macon|brighton|fairfield|leeds|midfield|lipscomb|irondale|pell city/i.test(f.city) ? `${f.city} may have an occupational tax on wages.` : null) },

  { key: "PROPERTY_TAX", label: "Business personal property tax return", group: "Property", agency: "County Revenue Commissioner / Tax Assessor", frequency: "ANNUAL", dueDay: 31, dueMonth: 12, coversPriorYear: false, help: "Furniture, equipment and other business property, listed with the county each year by December 31.", suggest: (f) => (isBusinessEntity(f) && inAlabama(f) ? "Alabama businesses list their equipment with the county." : null) },
];

export const CATALOG_BY_KEY = Object.fromEntries(TAX_CATALOG.map((c) => [c.key, c]));

// --- Dates ---------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Day `day` of month m (1–12) of year y, clamped to the month's last day. */
export const dayOf = (y: number, m: number, day: number) => `${y}-${pad(m)}-${pad(Math.min(day, lastDay(y, m)))}`;
const nextMonth = (y: number, m: number) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });

type Schedule = { frequency: string; dueDay: number; dueMonth: number | null; coversPriorYear: boolean };
export type Period = { period: string; label: string; dueDate: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every period of this schedule whose due date falls in the year range, in due-date order. */
function periodsInYears(s: Schedule, fromYear: number, toYear: number): Period[] {
  const out: Period[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    if (s.frequency === "MONTHLY") {
      for (let m = 1; m <= 12; m++) { const n = nextMonth(y, m); out.push({ period: `${y}-${pad(m)}`, label: `${MONTHS[m - 1]} ${y}`, dueDate: dayOf(n.y, n.m, s.dueDay) }); }
    } else if (s.frequency === "QUARTERLY") {
      for (let q = 1; q <= 4; q++) { const n = nextMonth(y, q * 3); out.push({ period: `${y}-Q${q}`, label: `Q${q} ${y}`, dueDate: dayOf(n.y, n.m, s.dueDay) }); }
    } else if (s.frequency === "SEMIANNUAL") {
      for (let h = 1; h <= 2; h++) { const n = nextMonth(y, h * 6); out.push({ period: `${y}-H${h}`, label: `${h === 1 ? "Jan–Jun" : "Jul–Dec"} ${y}`, dueDate: dayOf(n.y, n.m, s.dueDay) }); }
    } else {
      const due = dayOf(y, s.dueMonth ?? 12, s.dueDay);
      const py = s.coversPriorYear ? y - 1 : y;
      out.push({ period: String(py), label: s.coversPriorYear ? `${py} tax year` : `${py}`, dueDate: due });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** Periods due between two dates (inclusive). */
export function periodsDue(s: Schedule, from: string, to: string): Period[] {
  return periodsInYears(s, Number(from.slice(0, 4)) - 1, Number(to.slice(0, 4)) + 1).filter((p) => p.dueDate >= from && p.dueDate <= to);
}

/** The first period due on or after a date. */
export function nextPeriod(s: Schedule, from: string): Period {
  return periodsInYears(s, Number(from.slice(0, 4)) - 1, Number(from.slice(0, 4)) + 2).find((p) => p.dueDate >= from)!;
}

// --- Facts and suggestions -----------------------------------------------------------------------

export async function taxFacts(clientId: string): Promise<TaxFacts> {
  const [client, ledger, deadlines, docs, ye] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: { entityType: true, bookkeepingProfile: { select: { payroll: true, businessCity: true, businessState: true } } } }),
    prisma.ledgerAccount.findMany({ where: { clientId }, select: { name: true } }),
    prisma.clientDeadline.findMany({ where: { clientId }, select: { title: true }, take: 200 }),
    prisma.document.findMany({ where: { clientId, docType: { in: ["SALES_TAX_RETURN", "FORM_1099_NEC_ISSUED"] } }, select: { docType: true }, distinct: ["docType"] }),
    prisma.yearEndFiling.count({ where: { clientId } }),
  ]);
  const p = client?.bookkeepingProfile;
  const words = [...ledger.map((a) => a.name), ...deadlines.map((d) => d.title), ...(docs.some((d) => d.docType === "SALES_TAX_RETURN") ? ["sales tax return"] : [])];
  return {
    entityType: client?.entityType ?? null,
    payroll: !!p?.payroll,
    state: p?.businessState ?? null,
    city: p?.businessCity ?? null,
    words,
    contractors: ye > 0 || docs.some((d) => d.docType === "FORM_1099_NEC_ISSUED") || ledger.some((a) => /contract (labor|labour|work)|contractors?\b|subcontract/i.test(a.name)),
  };
}

// --- The page ------------------------------------------------------------------------------------

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export async function businessTaxesView(actor: Actor, clientId: string, today = todayCentral()) {
  await assertLedger(actor, clientId, "ledger", "view");
  const [items, licenses, facts] = await Promise.all([
    prisma.businessTaxObligation.findMany({ where: { clientId, archivedAt: null }, include: { filings: { orderBy: { dueDate: "desc" } } }, orderBy: { createdAt: "asc" } }),
    prisma.businessLicense.findMany({ where: { clientId, archivedAt: null }, orderBy: [{ renewalDate: "asc" }, { name: "asc" }] }),
    taxFacts(clientId),
  ]);
  const year = today.slice(0, 4);
  const rows = items.map((o) => {
    const s = { frequency: o.frequency, dueDay: o.dueDay, dueMonth: o.dueMonth, coversPriorYear: o.coversPriorYear };
    const done = new Map(o.filings.map((f) => [f.period, f]));
    const trackFrom = ymd(o.trackFrom);
    const overdue = periodsDue(s, trackFrom, ymd(new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000))).filter((p) => !done.has(p.period));
    let next = nextPeriod(s, today > trackFrom ? today : trackFrom);
    // A period already marked filed early: show the one after it.
    for (let i = 0; i < 24 && done.has(next.period); i++) next = nextPeriod(s, ymd(new Date(Date.parse(`${next.dueDate}T00:00:00Z`) + 86_400_000)));
    const paidThisYear = o.filings.filter((f) => f.status === "FILED" && ymd(f.dueDate).startsWith(year)).reduce((a, f) => a + (f.amountCents ?? 0), 0);
    return {
      id: o.id, kind: o.kind, name: o.name, agency: o.agency, accountNumber: o.accountNumber, note: o.note,
      frequency: o.frequency, frequencyLabel: FREQUENCIES[o.frequency as Frequency] ?? o.frequency, dueDay: o.dueDay, dueMonth: o.dueMonth, coversPriorYear: o.coversPriorYear, trackFrom,
      group: CATALOG_BY_KEY[o.kind]?.group ?? "Other",
      overdue, next, nextInDays: daysBetween(today, next.dueDate), paidThisYear,
      history: o.filings.slice(0, 12).map((f) => ({ id: f.id, period: f.period, dueDate: ymd(f.dueDate), status: f.status, amountCents: f.amountCents, confirmation: f.confirmation, filedOn: f.filedOn ? ymd(f.filedOn) : null, note: f.note })),
    };
  });
  const added = new Set(items.map((o) => o.kind));
  const licenseNames = licenses.map((l) => l.name.toLowerCase());
  const licenseAdded = (c: CatalogItem) =>
    c.key === "CITY_LICENSE" ? licenseNames.some((n) => /city|municipal/.test(n) || (!!facts.city && n.includes(facts.city.toLowerCase())))
    : c.key === "COUNTY_LICENSE" ? licenseNames.some((n) => /county|state/.test(n))
    : c.key === "ABC_LICENSE" ? licenseNames.some((n) => /abc|alcohol|liquor|beer|wine/.test(n))
    : false;
  const catalog = TAX_CATALOG.map((c) => ({ key: c.key, label: c.label, group: c.group, agency: c.agency, frequency: c.frequency, dueDay: c.dueDay, dueMonth: c.dueMonth ?? null, help: c.help, license: !!c.license, added: c.license ? licenseAdded(c) : added.has(c.key), why: c.suggest(facts) }));
  const licenseRows = licenses.map((l) => ({ id: l.id, name: l.name, jurisdiction: l.jurisdiction, licenseNumber: l.licenseNumber, note: l.note, renewal: l.renewalDate ? ymd(l.renewalDate) : null, expired: !!l.renewalDate && ymd(l.renewalDate) < today }));
  return {
    today,
    rows,
    licenses: licenseRows,
    suggestions: catalog.filter((c) => c.why && !c.added),
    catalog,
    facts: { entityType: facts.entityType, payroll: facts.payroll, city: facts.city, state: facts.state },
    totals: { items: rows.length + licenseRows.length, overdue: rows.reduce((a, r) => a + r.overdue.length, 0) + licenseRows.filter((l) => l.expired).length, dueIn30: rows.filter((r) => r.nextInDays <= 30).length + licenseRows.filter((l) => l.renewal && !l.expired && daysBetween(today, l.renewal) <= 30).length },
  };
}

/** Upcoming and overdue items for the client overview's deadline list. */
export async function businessTaxDeadlines(clientId: string, today: string, withinDays = 45) {
  const items = await prisma.businessTaxObligation.findMany({ where: { clientId, archivedAt: null }, include: { filings: { select: { period: true } } } });
  const out: { date: string; title: string }[] = [];
  for (const o of items) {
    const s = { frequency: o.frequency, dueDay: o.dueDay, dueMonth: o.dueMonth, coversPriorYear: o.coversPriorYear };
    const done = new Set(o.filings.map((f) => f.period));
    const end = ymd(new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86_400_000));
    for (const p of periodsDue(s, ymd(o.trackFrom), end)) if (!done.has(p.period)) out.push({ date: p.dueDate, title: `${o.name} — ${p.label}` });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// --- Changes ------------------------------------------------------------------------------------

const clean = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) || null : null);
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

type ItemInput = { kind?: string; name?: string; agency?: string; accountNumber?: string; frequency?: string; dueDay?: string | number; dueMonth?: string | number; coversPriorYear?: boolean; trackFrom?: string; note?: string };

function schedule(input: ItemInput, base?: CatalogItem) {
  const frequency = (input.frequency || base?.frequency || "") as Frequency;
  if (!(frequency in FREQUENCIES)) throw new ValidationError("Choose how often it is filed.");
  const dueDay = Number(input.dueDay || base?.dueDay);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new ValidationError("Enter the day of the month it is due (1–31).");
  const dueMonth = frequency === "ANNUAL" ? Number(input.dueMonth || base?.dueMonth || 0) : null;
  if (frequency === "ANNUAL" && (!Number.isInteger(dueMonth) || dueMonth! < 1 || dueMonth! > 12)) throw new ValidationError("Choose the month it is due.");
  return { frequency, dueDay, dueMonth };
}

/** Add a tax or filing to a business's list (from the catalog or written in). Licenses go to Business Licenses. */
export async function addBusinessTax(actor: Actor, clientId: string, input: ItemInput, today = todayCentral()) {
  await assertLedger(actor, clientId, "ledger", "edit");
  const base = input.kind ? CATALOG_BY_KEY[input.kind] : undefined;
  if (input.kind && input.kind !== "OTHER" && !base) throw new ValidationError("Unknown tax type.");
  const name = clean(input.name, 120) ?? base?.label ?? null;
  if (!name) throw new ValidationError("Enter the name of the tax or filing.");
  let dueMonth = input.dueMonth;
  if (!dueMonth && (base?.key === "BPT" || base?.key === "INCOME_TAX")) {
    // Partnerships and S corporations: March 15; C corporations and single-member LLCs: April 15.
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { entityType: true } });
    dueMonth = c?.entityType === "PARTNERSHIP" || c?.entityType === "S_CORP" ? 3 : 4;
  }
  const s = schedule({ ...input, dueMonth }, base);
  if (base?.license) {
    const renewal = nextPeriod({ ...s, coversPriorYear: false }, today).dueDate;
    const l = await addBusinessLicense(actor, clientId, { name, jurisdiction: clean(input.agency, 120) ?? undefined, licenseNumber: clean(input.accountNumber, 60) ?? undefined, renewalDate: renewal, note: clean(input.note, 300) ?? undefined });
    return { license: true as const, id: l.id, name };
  }
  const trackFrom = input.trackFrom && isYmd(input.trackFrom) ? input.trackFrom : today;
  const o = await prisma.businessTaxObligation.create({
    data: {
      clientId, kind: base?.key ?? "OTHER", name, agency: clean(input.agency, 160) ?? base?.agency ?? null, accountNumber: clean(input.accountNumber, 60),
      frequency: s.frequency, dueDay: s.dueDay, dueMonth: s.dueMonth, coversPriorYear: input.coversPriorYear ?? base?.coversPriorYear ?? true,
      trackFrom: new Date(`${trackFrom}T00:00:00Z`), note: clean(input.note, 300), createdById: actor.id,
    },
  });
  await audit(prisma, { actorId: actor.id, action: "business_tax.added", entityType: "BusinessTaxObligation", entityId: o.id, clientId, details: { kind: o.kind, name, frequency: s.frequency } });
  return { license: false as const, id: o.id, name };
}

/** Add several catalog items at once with their usual schedules. */
export async function addSuggestedTaxes(actor: Actor, clientId: string, keys: string[], today = todayCentral()) {
  const out = [];
  for (const k of [...new Set(keys)].slice(0, 40)) if (CATALOG_BY_KEY[k]) out.push(await addBusinessTax(actor, clientId, { kind: k }, today));
  return out;
}

async function ownItem(actor: Actor, id: string, action: "view" | "edit" = "edit") {
  const o = await prisma.businessTaxObligation.findUnique({ where: { id } });
  if (!o || o.archivedAt) throw new ValidationError("That tax isn't on the list.");
  await assertLedger(actor, o.clientId, "ledger", action);
  return o;
}

export async function updateBusinessTax(actor: Actor, id: string, input: ItemInput) {
  const o = await ownItem(actor, id);
  const s = schedule({ frequency: input.frequency || o.frequency, dueDay: input.dueDay || o.dueDay, dueMonth: input.dueMonth || o.dueMonth || undefined });
  const data = {
    name: clean(input.name, 120) ?? o.name, agency: input.agency !== undefined ? clean(input.agency, 160) : o.agency, accountNumber: input.accountNumber !== undefined ? clean(input.accountNumber, 60) : o.accountNumber,
    frequency: s.frequency, dueDay: s.dueDay, dueMonth: s.dueMonth, note: input.note !== undefined ? clean(input.note, 300) : o.note,
    ...(input.trackFrom && isYmd(input.trackFrom) ? { trackFrom: new Date(`${input.trackFrom}T00:00:00Z`) } : {}),
  };
  await prisma.businessTaxObligation.update({ where: { id }, data });
  await audit(prisma, { actorId: actor.id, action: "business_tax.updated", entityType: "BusinessTaxObligation", entityId: id, clientId: o.clientId, details: { from: { frequency: o.frequency, dueDay: o.dueDay, dueMonth: o.dueMonth }, to: { frequency: s.frequency, dueDay: s.dueDay, dueMonth: s.dueMonth } } });
}

/** Removing keeps the item and its filings (archived). */
export async function removeBusinessTax(actor: Actor, id: string) {
  const o = await ownItem(actor, id);
  await prisma.businessTaxObligation.update({ where: { id }, data: { archivedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "business_tax.removed", entityType: "BusinessTaxObligation", entityId: id, clientId: o.clientId, details: { name: o.name } });
}

const money = (v: unknown) => {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ValidationError("Enter the amount like 1234.56.");
  return Math.round(Number(s) * 100);
};

/** Mark one period filed (or not required), with what was paid and the confirmation number. Saving again updates it. */
export async function recordTaxFiling(actor: Actor, obligationId: string, input: { period: string; status?: string; amount?: string; confirmation?: string; filedOn?: string; note?: string }, today = todayCentral()) {
  const o = await ownItem(actor, obligationId);
  const s = { frequency: o.frequency, dueDay: o.dueDay, dueMonth: o.dueMonth, coversPriorYear: o.coversPriorYear };
  const p = periodsInYears(s, 2000, Number(today.slice(0, 4)) + 2).find((x) => x.period === input.period);
  if (!p) throw new ValidationError("Choose the period.");
  const status = input.status === "NOT_REQUIRED" ? "NOT_REQUIRED" : "FILED";
  if (input.filedOn && !isYmd(input.filedOn)) throw new ValidationError("Enter a valid filed date.");
  const data = { dueDate: new Date(`${p.dueDate}T00:00:00Z`), status, amountCents: status === "FILED" ? money(input.amount) : null, confirmation: clean(input.confirmation, 80), filedOn: input.filedOn ? new Date(`${input.filedOn}T00:00:00Z`) : status === "FILED" ? new Date(`${today}T00:00:00Z`) : null, note: clean(input.note, 300) };
  const f = await prisma.businessTaxFiling.upsert({ where: { obligationId_period: { obligationId, period: p.period } }, create: { obligationId, period: p.period, recordedById: actor.id, ...data }, update: { ...data, recordedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "business_tax.filed", entityType: "BusinessTaxFiling", entityId: f.id, clientId: o.clientId, details: { name: o.name, period: p.period, status, amountCents: data.amountCents } });
  return f;
}

/** Undo a period marked by mistake. */
export async function undoTaxFiling(actor: Actor, filingId: string) {
  const f = await prisma.businessTaxFiling.findUnique({ where: { id: filingId }, include: { obligation: true } });
  if (!f) throw new ValidationError("That filing isn't recorded.");
  await assertLedger(actor, f.obligation.clientId, "ledger", "edit");
  await prisma.businessTaxFiling.delete({ where: { id: filingId } });
  await audit(prisma, { actorId: actor.id, action: "business_tax.filing_undone", entityType: "BusinessTaxFiling", entityId: filingId, clientId: f.obligation.clientId, details: { name: f.obligation.name, period: f.period, status: f.status, amountCents: f.amountCents } });
}
