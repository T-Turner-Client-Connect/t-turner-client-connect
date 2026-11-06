import { fieldsOf, type FieldDef, type FormCode } from "./line-map";

/**
 * Reads the amount printed after each label of one form. Pure: text in,
 * readings out. Nothing is guessed — a value is either read from the
 * text, left blank on the form, missing (label not found) or ambiguous.
 */

export type Reading =
  | { status: "found"; value: number; printedLine: string | null; snippet: string }
  | { status: "blank"; printedLine: string | null; snippet: string }
  | { status: "missing" }
  | { status: "ambiguous"; note: string };

type Hit = { field: FieldDef; start: number; end: number };

const globalOf = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

function hitsFor(text: string, f: FieldDef): Hit[] {
  let from = 0;
  if (f.after) {
    const a = f.after.exec(text);
    if (!a) return [];
    from = a.index + a[0].length;
  }
  const out: Hit[] = [];
  for (const re of f.re) {
    const g = globalOf(re);
    g.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      if (!m[0].length) {
        g.lastIndex++;
        continue;
      }
      const h = { field: f, start: m.index, end: m.index + m[0].length };
      // A longer wording of the same label already covers this spot.
      if (!out.some((o) => h.start >= o.start && h.end <= o.end)) out.push(h);
    }
  }
  return out;
}

const TOKEN = /(?<![A-Za-z0-9.,$])(?:-0-|\(?-?\$?\d[\d,]*(?:\.\d{0,2})?\)?(?:[a-z](?![a-z]))?)/gi;
const isTag = (t: string) => /^\d{1,2}[a-z]?$/i.test(t);
const strong = (t: string) => /[,.$()]/.test(t) || /^-?\d{3,}$/.test(t) || t === "-0-";

/** "4,935." → 493500 · "(1,200)" → -120000 · "-0-" → 0. Commas and spaces are ignored. */
export function amountCents(raw: string): number | null {
  if (raw === "-0-") return 0;
  const t = raw.replace(/[\s,$]/g, "");
  const m = /^(\()?(-)?(\d+)(?:\.(\d{0,2}))?\.?(\))?$/.exec(t);
  if (!m) return null;
  const cents = Number(m[3]) * 100 + Number((m[4] ?? "").padEnd(2, "0") || 0);
  return (m[1] && m[5]) || m[2] ? -cents : cents;
}

const sameLine = (a: string | null, b: string) => !!a && a.replace(/^0+/, "").toLowerCase() === b.toLowerCase();

function readWindow(f: FieldDef, window: string): Reading {
  const clean = window.replace(/(?:\s*\.){2,}/g, " ").replace(/[☐☒☑■□✔✓]/g, " ");
  const toks = [...clean.matchAll(TOKEN)].map((m) => m[0].trim()).filter(Boolean);
  const snippet = window.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!toks.length) return { status: "blank", printedLine: null, snippet };
  const last = toks[toks.length - 1];
  const prev = toks.length > 1 ? toks[toks.length - 2] : null;
  const value = (t: string): Reading => {
    if (f.kind === "count") {
      if (!/^\d{1,2}\.?$/.test(t)) return { status: "ambiguous", note: `“${t}” isn't a count of people` };
      return { status: "found", value: Number(t.replace(".", "")), printedLine: prev && isTag(prev) ? prev : null, snippet };
    }
    const c = amountCents(t);
    if (c === null) return { status: "ambiguous", note: `“${t}” isn't an amount` };
    return { status: "found", value: c, printedLine: prev && isTag(prev) ? prev : null, snippet };
  };
  if (toks.length === 1) {
    // Only the line number is printed: the line was left blank.
    if (isTag(last) && (sameLine(last, f.line) || /[a-z]$/i.test(last))) return { status: "blank", printedLine: last, snippet };
    return { ...value(last), printedLine: null } as Reading;
  }
  if (/[a-z]$/i.test(last) && isTag(last)) return { status: "ambiguous", note: `found the line label “${last}” where the amount should be` };
  const strongCount = toks.filter(strong).length;
  if (toks.length === 2) {
    if (prev && isTag(prev) && !strong(prev)) return value(last);
    return { status: "ambiguous", note: `two amounts printed (${toks.join(", ")})` };
  }
  if (strongCount <= 1 && (strong(last) || f.kind === "count")) return value(last);
  return { status: "ambiguous", note: `several amounts printed (${toks.slice(0, 4).join(", ")})` };
}

/** Readings for every field of `form` in `text` (that form's pages, joined). */
export function readForm(text: string, form: FormCode): Record<string, Reading> {
  const fields = fieldsOf(form);
  const hits = fields.flatMap((f) => hitsFor(text, f));
  // A hit inside another field's label (e.g. a short wording inside a longer one) doesn't count.
  const real = hits.filter((h) => !hits.some((o) => o !== h && o.field.id !== h.field.id && h.start >= o.start && h.end <= o.end && o.end - o.start > h.end - h.start));
  const out: Record<string, Reading> = {};
  for (const f of fields) {
    const mine = real.filter((h) => h.field.id === f.id);
    if (!mine.length) {
      out[f.id] = { status: "missing" };
      continue;
    }
    const readings = mine.map((h) => {
      const eol = text.indexOf("\n", h.end);
      let stop = eol === -1 ? text.length : eol;
      for (const o of real) if (o.start >= h.end && o.start < stop) stop = o.start;
      let r = readWindow(f, text.slice(h.end, stop));
      // The amount can wrap onto the next line when nothing else is printed there.
      if (r.status === "blank" && !r.printedLine && stop === eol && eol !== -1) {
        const next = text.slice(eol + 1).split("\n")[0] ?? "";
        if (/^\s*(?:\d{1,2}[a-z]?\s+)?[-($]*\d[\d,]*(?:\.\d{0,2})?\)?\.?\s*$/i.test(next)) r = readWindow(f, next);
      }
      return r;
    });
    const found = readings.filter((r) => r.status === "found") as Extract<Reading, { status: "found" }>[];
    const amb = readings.find((r) => r.status === "ambiguous");
    if (new Set(found.map((r) => r.value)).size > 1) out[f.id] = { status: "ambiguous", note: `printed more than once with different amounts` };
    else if (found.length) out[f.id] = found[0];
    else if (amb) out[f.id] = amb;
    else out[f.id] = readings[0];
  }
  return out;
}
