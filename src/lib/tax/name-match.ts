// Matching a TaxAct e-file row to a client by the taxpayer or business name, when the row has
// no TaxAct client ID the CRM already knows. Pure functions (no database).
//
// TaxAct writes names several ways: "DOE, JOHN A & JANE B", "John A. & Jane B. Doe",
// "John Doe", "Doe John", or a business name ("Willow Example Agency, LLC"). A person is
// compared by first + last name in any order (middle names, initials and suffixes ignored);
// a business by its name without the entity ending (LLC, Inc., Corp…). A name that fits more
// than one client is never applied automatically: it goes to review.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const ENTITY = new Set(["llc", "l", "c", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "pllc", "pc", "pa", "lp", "llp", "the"]);

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9&,\s]/g, " ")
    .split(/[\s]+/)
    .filter(Boolean);

/** "first last" in a fixed order, so "Doe John" and "John Doe" agree. */
const personKey = (first: string | null | undefined, last: string | null | undefined) => {
  const f = words(first ?? "").filter((w) => w.length > 1 && !SUFFIXES.has(w) && w !== "&" && w !== ",")[0];
  const l = words(last ?? "").filter((w) => !SUFFIXES.has(w) && w !== "&" && w !== ",").join(" ");
  return f && l ? `p:${[f, l].sort().join("|")}` : null;
};

export const businessKey = (name: string | null | undefined) => {
  const w = words((name ?? "").replace(/,/g, " ")).filter((x) => x !== "&" && x !== "and" && !ENTITY.has(x));
  return w.length ? `b:${w.join(" ")}` : null;
};

/** The keys one client can be found by: the taxpayer, the spouse (joint returns), and the business name. */
export function clientNameKeys(c: { firstName?: string | null; lastName?: string | null; spouseFirstName?: string | null; spouseLastName?: string | null; displayName?: string | null; businessName?: string | null }): string[] {
  const keys = new Set<string>();
  const add = (k: string | null) => k && keys.add(k);
  add(personKey(c.firstName, c.lastName));
  add(personKey(c.spouseFirstName, c.spouseLastName ?? c.lastName));
  add(businessKey(c.businessName));
  add(businessKey(c.displayName));
  // "First Last" display names of individuals.
  const d = words(c.displayName ?? "").filter((w) => w !== "&" && w !== ",");
  if (d.length >= 2) add(personKey(d[0], d[d.length - 1]));
  return [...keys];
}

/** The keys a TaxAct row's name could mean. */
export function rowNameKeys(name: string | null | undefined): string[] {
  const raw = (name ?? "").trim();
  if (!raw) return [];
  const keys = new Set<string>();
  const add = (k: string | null) => k && keys.add(k);
  add(businessKey(raw));
  const primary = raw.split(/\s+(?:&|and)\s+|&/i)[0];
  if (primary.includes(",")) {
    // "DOE, JOHN A" (last, first).
    const [last, rest] = primary.split(",", 2);
    add(personKey(rest, last));
  } else {
    // "John A. Doe & Jane B. Doe" or "John A. & Jane B. Doe": the last name is the last word.
    const w = words(primary).filter((x) => !SUFFIXES.has(x));
    const all = words(raw).filter((x) => !SUFFIXES.has(x) && x !== "&" && x !== "and");
    if (w.length >= 2) add(personKey(w[0], w[w.length - 1]));
    if (w.length >= 1 && all.length >= 2) add(personKey(w[0], all[all.length - 1]));
  }
  return [...keys];
}

/** Index: key → client IDs. */
export function nameIndex(clients: ({ id: string } & Parameters<typeof clientNameKeys>[0])[]) {
  const idx = new Map<string, Set<string>>();
  for (const c of clients) for (const k of clientNameKeys(c)) (idx.get(k) ?? idx.set(k, new Set()).get(k)!).add(c.id);
  return idx;
}

/** The clients a row's name fits (none, one, or several). */
export function matchByName(idx: Map<string, Set<string>>, name: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const k of rowNameKeys(name)) for (const id of idx.get(k) ?? []) out.add(id);
  return [...out];
}

/** The second person on a joint row ("DOE, JOHN & JANE" or "John & Jane Doe"), as a person key. */
export function spouseKeyOf(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim();
  const parts = raw.split(/\s+(?:&|and)\s+|&/i);
  if (parts.length < 2) return null;
  const second = words(parts[1]).filter((x) => !SUFFIXES.has(x) && x !== ",");
  if (!second.length) return null;
  const primary = parts[0];
  // Last name: the row's last-first surname, else the second person's own last word, else the row's last word.
  const last = primary.includes(",") ? primary.split(",")[0] : second.length >= 2 ? second[second.length - 1] : words(raw).at(-1) ?? "";
  return personKey(second[0], last);
}

/** True when the row names both spouses and both match this client's taxpayer and spouse. */
export function bothSpousesMatch(c: Parameters<typeof clientNameKeys>[0], rowName: string | null | undefined): boolean {
  const s = spouseKeyOf(rowName);
  const mine = personKey(c.spouseFirstName, c.spouseLastName ?? c.lastName);
  const taxpayer = personKey(c.firstName, c.lastName);
  return !!s && !!mine && !!taxpayer && s === mine && rowNameKeys(rowName).includes(taxpayer);
}

const INDIVIDUAL_FORM = /^1040/i;
const BUSINESS_FORM = /^(1120|1065|990|1041|706|709|5500)/i;
/** False when the form plainly belongs to the other kind of client (a 1040 for a business record, an 1120-S for a person). */
export function formFitsClient(returnType: string | null | undefined, clientType: string): boolean {
  const f = (returnType ?? "").trim();
  if (clientType === "INDIVIDUAL") return !BUSINESS_FORM.test(f);
  return !INDIVIDUAL_FORM.test(f);
}
