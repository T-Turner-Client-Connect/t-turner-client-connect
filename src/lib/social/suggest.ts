import type { ContentCategory, SocialPlatform } from "@prisma/client";
import { chicagoLocalToUtc, chicagoParts } from "@/lib/tz";

/**
 * Built-in suggestion helper (no AI service, no cost). Captions are assembled
 * only from an approved content topic's own words plus neutral connecting
 * phrases — it never adds prices, promotions, deadlines, testimonials, hours
 * or tax facts. Staff edit everything before approval.
 */

export const CATEGORY_LABELS: Record<ContentCategory, string> = {
  SERVICE: "Our services",
  TAX_SEASON: "Tax-season preparation",
  BOOKKEEPING_TIP: "Bookkeeping tip",
  BUSINESS_SETUP: "Business setup",
  NONPROFIT: "Nonprofit services",
  OFFICE_ANNOUNCEMENT: "Office announcement",
  HOLIDAY: "Holiday",
};

// Neutral openers: no claims, numbers, dates or offers.
const HOOKS: Record<ContentCategory, string[]> = {
  SERVICE: ["How we can help:", "Did you know we can help with this?", "Here for you:"],
  TAX_SEASON: ["Getting ready for tax season?", "Tax-season prep:", "A tax-season reminder:"],
  BOOKKEEPING_TIP: ["Bookkeeping tip:", "Small habit, big difference:", "Keep your books tidy:"],
  BUSINESS_SETUP: ["Starting a business?", "Thinking about launching your business?", "New business owners:"],
  NONPROFIT: ["Running a nonprofit?", "For nonprofit leaders:", "Supporting nonprofits:"],
  OFFICE_ANNOUNCEMENT: ["Office update:", "Please note:", "An update from our office:"],
  HOLIDAY: ["Warm wishes from our team.", "From all of us at TTurner & Associates Group:", "Happy holidays from our office."],
};

const BASE_TAGS: Record<ContentCategory, string[]> = {
  SERVICE: ["SmallBusiness", "Accounting"],
  TAX_SEASON: ["TaxSeason", "TaxPrep"],
  BOOKKEEPING_TIP: ["Bookkeeping", "SmallBusinessTips"],
  BUSINESS_SETUP: ["NewBusiness", "Entrepreneur"],
  NONPROFIT: ["Nonprofit", "NonprofitLeaders"],
  OFFICE_ANNOUNCEMENT: [],
  HOLIDAY: [],
};

const TAG_LIMIT: Record<SocialPlatform, number> = { FACEBOOK: 3, INSTAGRAM: 10, TIKTOK: 5 };
const DEFAULT_CTA = "Questions? Send us a message through your client portal.";

export type TopicInput = { category: ContentCategory; title: string; keyMessage: string; callToAction: string | null; hashtags: string[] };

export function normalizeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function parseHashtags(text: string): string[] {
  return normalizeHashtags(text.split(/[\s,]+/));
}

export const hashtagLine = (tags: string[]) => tags.map((t) => `#${t}`).join(" ");

/** Caption text plus hashtags, the way it should be pasted on the platform. */
export function captionWithHashtags(caption: string, tags: string[]) {
  return tags.length ? `${caption.trimEnd()}\n\n${hashtagLine(tags)}` : caption;
}

/** Platform-specific caption + hashtags. `variant` rotates wording for "Regenerate". */
export function suggestCaption(topic: TopicInput, platform: SocialPlatform, variant: number) {
  const hooks = HOOKS[topic.category];
  const hook = hooks[((variant % hooks.length) + hooks.length) % hooks.length];
  const key = topic.keyMessage.trim();
  const cta = topic.callToAction?.trim() || DEFAULT_CTA;
  const firstSentence = key.split(/(?<=[.!?])\s/)[0];
  let caption: string;
  if (platform === "FACEBOOK") caption = variant % 2 ? `${topic.title}\n\n${key}\n\n${cta}` : `${hook}\n\n${key}\n\n${cta}`;
  else if (platform === "INSTAGRAM") caption = `${hook} ${topic.title}\n\n${key}\n\n${cta}`;
  else caption = `${hook} ${firstSentence}`.slice(0, 300);
  const hashtags = normalizeHashtags([...topic.hashtags, ...BASE_TAGS[topic.category]]).slice(0, TAG_LIMIT[platform]);
  return { caption, hashtags };
}

/**
 * Recommended posting slots (America/Chicago). These are general starting
 * points, not guaranteed best times — no account analytics are connected.
 */
const SLOTS: Record<SocialPlatform, { days: number[]; time: string }> = {
  FACEBOOK: { days: [2, 3, 4], time: "11:30" }, // Tue–Thu late morning
  INSTAGRAM: { days: [2, 3, 4], time: "12:00" }, // Tue–Thu midday
  TIKTOK: { days: [2, 4], time: "18:30" }, // Tue/Thu early evening
};
export const TIME_SUGGESTION_NOTE = "Recommended time, not a guaranteed best time. Based on general posting patterns because no account analytics are connected.";

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

/** Next recommended slot for the earliest-listed platform, at least `leadMinutes` from `after`. */
export function nextRecommendedSlot(platforms: SocialPlatform[], after: Date, leadMinutes = 60): Date {
  const slot = SLOTS[platforms[0] ?? "FACEBOOK"];
  const start = new Date(after.getTime() + leadMinutes * 60_000);
  for (let i = 0; i < 21; i++) {
    const day = new Date(start.getTime() + i * 86400_000);
    const p = chicagoParts(day);
    if (!slot.days.includes(WEEKDAY[p.weekday as keyof typeof WEEKDAY])) continue;
    const z = (n: number) => String(n).padStart(2, "0");
    const at = chicagoLocalToUtc(`${p.year}-${z(p.month)}-${z(p.day)}T${slot.time}`)!;
    if (at.getTime() >= start.getTime()) return at;
  }
  return start;
}

export type ClaimFlag = { kind: string; text: string };

const CHECKS: { kind: string; re: RegExp }[] = [
  { kind: "Date or deadline", re: /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\bdeadlines?\b|\bdue (date|by)\b|\bextension\b/gi },
  { kind: "Tax year or tax rule", re: /\b20\d{2}\b|\b(irs|refund|credit|deduction|deductible|write[- ]?off|penalt(y|ies)|tax (law|rate|bracket)|new law|standard deduction|w-?2|1099|estimated tax)\b/gi },
  { kind: "Price or promotion", re: /\$\s?\d|\b\d+\s?%|\b(free|discount|promo(tion)?|special offer|sale|coupon|% off|limited time|save \$?\d)\b/gi },
  { kind: "Guarantee or outcome", re: /\b(guarantee[ds]?|maximum refund|biggest refund|no audit|audit[- ]proof)\b/gi },
  { kind: "Testimonial or review", re: /[“"][^”"]{8,}[”"]|\b(testimonial|review(s|ed)?|5[- ]star|★)\b|\bsaid\b/gi },
  { kind: "Hours or availability", re: /\b(open|closed|hours|walk[- ]?ins?)\b|\b\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)\b/gi },
];

/** Things a person must verify before approval. Empty = nothing flagged. */
export function flagClaims(text: string): ClaimFlag[] {
  const flags: ClaimFlag[] = [];
  for (const { kind, re } of CHECKS) {
    const found = new Set((text.match(re) ?? []).map((m) => m.trim()));
    for (const f of found) flags.push({ kind, text: f });
  }
  return flags;
}
