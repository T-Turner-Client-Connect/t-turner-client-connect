// The client master record's street address and, when it differs, its mailing address.

type AddressFields = {
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

export function streetAddressOf(c: AddressFields): PostalAddress {
  return { line1: c.addressLine1 ?? null, line2: c.addressLine2 ?? null, city: c.city ?? null, state: c.state ?? null, postalCode: c.postalCode ?? null };
}

/** Where mail goes: the separate mailing address when one is recorded, otherwise the street address. */
export function mailingAddressOf(c: AddressFields): PostalAddress {
  if (c.mailingSameAsAddress === false && c.mailingAddressLine1) {
    return { line1: c.mailingAddressLine1, line2: c.mailingAddressLine2 ?? null, city: c.mailingCity ?? null, state: c.mailingState ?? null, postalCode: c.mailingPostalCode ?? null };
  }
  return streetAddressOf(c);
}

export function formatAddress(a: PostalAddress): string {
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" · ");
}
