/**
 * Approved flyer images an announcement can show (staff pick one by name).
 * The choice is kept in the announcement's body as a marker
 * "[[flyer:<key>]]" so no database change is needed; every reader strips
 * it with splitFlyer(). Only keys in FLYERS ever render: an unknown
 * marker is dropped, so a message can never point at an outside image.
 */
export const FLYERS = {
  "welcome-client-connect": {
    label: "Welcome Back, Clients! (TTurner Client Connect)",
    src: "/brand/flyers/welcome-client-connect.webp",
    alt: "Welcome Back, Clients! TTurner Client Connect, your secure client portal: access your tax information anytime, upload documents securely, retrieve current and prior year returns, schedule appointments, receive updates and reminders, and use the Resource Center.",
  },
  "welcome-bookkeeping": {
    label: "Welcome to TTurner Client Connect — Your Business Bookkeeping Portal",
    src: "/brand/flyers/welcome-bookkeeping.webp",
    alt: "Welcome to TTurner Client Connect, your business bookkeeping portal: monthly financials (P&L and balance sheet), bank balances at a glance, upload statements and receipts securely, payroll reports and approvals, secure messages with our office, and a document vault for every month and year. Know your numbers. Grow your business. All in one place!",
  },
} as const;

export type FlyerKey = keyof typeof FLYERS;
export type Flyer = (typeof FLYERS)[FlyerKey] & { key: FlyerKey };

const MARKER = /\s*\[\[flyer:([a-z0-9-]+)\]\]\s*/gi;

export const isFlyerKey = (k: string): k is FlyerKey => Object.prototype.hasOwnProperty.call(FLYERS, k);

/** The message text without any marker, and the approved flyer it names (if any). */
export function splitFlyer(body: string): { text: string; flyer: Flyer | null } {
  let flyer: Flyer | null = null;
  const text = body.replace(MARKER, (_m, key: string) => {
    const k = key.toLowerCase();
    if (!flyer && isFlyerKey(k)) flyer = { ...FLYERS[k], key: k };
    return "\n";
  }).trim();
  return { text, flyer };
}

/** Saves the chosen flyer with the message (or none). */
export function joinFlyer(text: string, key: string | null | undefined): string {
  const clean = splitFlyer(text).text;
  return key && isFlyerKey(key) ? `${clean}\n\n[[flyer:${key}]]` : clean;
}
