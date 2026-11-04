// The client master record's physical (street) address and, when it differs,
// its mailing address. Everything that MAILS something (invoices and their
// bill-to, letters, envelopes, statement or packet "mail to" blocks) reads
// billingAddressOf(); anything about where the client lives or works (tax
// return residence, the profile's "Physical address") reads streetAddressOf().

export type AddressFields = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  mailingSameAsAddress?: boolean | null;
  mailingAddressLine1?: string | null;
  mailingAddressLine2?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingPostalCode?: string | null;
};

export type PostalAddress = { line1: string | null; line2: string | null; city: string | null; state: string | null; postalCode: string | null };

export const STATE_RE = /^[A-Za-z]{2}$/;
export const ZIP_RE = /^\d{5}(-?\d{4})?$/;

/** Street, city, a 2-letter state and a 5- or 9-digit ZIP. Line 2 is optional. */
export function isCompleteAddress(a: PostalAddress): boolean {
  return !!a.line1?.trim() && !!a.city?.trim() && STATE_RE.test(a.state?.trim() ?? "") && ZIP_RE.test(a.postalCode?.trim() ?? "");
}

export function streetAddressOf(c: AddressFields): PostalAddress {
  return { line1: c.addressLine1 ?? null, line2: c.addressLine2 ?? null, city: c.city ?? null, state: c.state ?? null, postalCode: c.postalCode ?? null };
}

export function separateMailingOf(c: AddressFields): PostalAddress {
  return { line1: c.mailingAddressLine1 ?? null, line2: c.mailingAddressLine2 ?? null, city: c.mailingCity ?? null, state: c.mailingState ?? null, postalCode: c.mailingPostalCode ?? null };
}

/** True when the record has its own, complete mailing address that differs from the physical one. */
export function hasSeparateMailing(c: AddressFields): boolean {
  return c.mailingSameAsAddress === false && isCompleteAddress(separateMailingOf(c));
}

/**
 * Where mail goes: the separate mailing address when one is recorded and
 * complete, otherwise the physical address (older records, "same as
 * physical", or an incomplete mailing address).
 */
export function mailingAddressOf(c: AddressFields): PostalAddress {
  return hasSeparateMailing(c) ? separateMailingOf(c) : streetAddressOf(c);
}

/** Bill-to address for invoices, quotes and statements. Same rule as mail. */
export const billingAddressOf = mailingAddressOf;

/** Is the record's address complete (and its mailing address, if separate)? Drives "Address Needed". */
export function addressComplete(c: AddressFields): boolean {
  if (!isCompleteAddress(streetAddressOf(c))) return false;
  return c.mailingSameAsAddress !== false || isCompleteAddress(separateMailingOf(c));
}

/** One line: "21 Example Ave · Apt 2 · Hoover, AL · 35244". */
export function formatAddress(a: PostalAddress): string {
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" · ");
}

/** Envelope / bill-to block: "21 Example Ave\nApt 2\nHoover, AL 35244". */
export function formatAddressBlock(a: PostalAddress): string {
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine].filter(Boolean).join("\n");
}
