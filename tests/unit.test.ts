import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone, looksLikeTaxId } from "@/lib/normalize";
import { estimateSegments } from "@/lib/sms";
import { currentConsent, ineligibilityReason, type EligibilityInput } from "@/lib/consent";
import { guessField, isSensitiveHeader } from "@/lib/import/fields";
import { cleanRow } from "@/lib/import/rows";
import { sniffType } from "@/lib/files";

const day = 24 * 3600 * 1000;
const rec = (kind: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ kind, status, effectiveAt: new Date(Date.now() - day), createdAt: new Date(Date.now() - day), expiresAt: null, reviewedAt: null, evidenceFileId: null, ...extra }) as never;

const base: EligibilityInput = {
  channel: "EMAIL",
  purpose: "SERVICE",
  address: "a@example.com",
  archived: false,
  taxReturnDerived: false,
  personConsents: [],
  clientConsents: [],
  suppressions: [],
};

describe("normalization", () => {
  it("normalizes US phone formats to E.164", () => {
    expect(normalizePhone("(555) 010-0101")).toBe("+15550100101");
    expect(normalizePhone("1-555-010-0101")).toBe("+15550100101");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("555-0101")).toBeNull();
    expect(normalizePhone("555 010 0101 x22")).toBe("+15550100101");
  });
  it("normalizes emails case-insensitively", () => {
    expect(normalizeEmail("  Avery@Example.COM ")).toBe("avery@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
  it("spots SSN/EIN patterns", () => {
    expect(looksLikeTaxId("SSN 123-45-6789")).toBe(true);
    expect(looksLikeTaxId("EIN 12-3456789")).toBe(true);
    expect(looksLikeTaxId("Call after 5pm")).toBe(false);
  });
});

describe("SMS segments", () => {
  it("counts GSM-7 and UCS-2", () => {
    expect(estimateSegments("a".repeat(160)).segments).toBe(1);
    expect(estimateSegments("a".repeat(161)).segments).toBe(2);
    expect(estimateSegments("Hi 😀").encoding).toBe("UCS-2");
    expect(estimateSegments("x".repeat(71) + "’").segments).toBe(2);
  });
});

describe("consent rules", () => {
  it("treats no records as unknown and blocks promotions", () => {
    expect(ineligibilityReason({ ...base, purpose: "TAX_PREP_PROMO" })).toMatch(/No promotional email permission/);
    expect(ineligibilityReason({ ...base, channel: "SMS", address: "+15550100101" })).toMatch(/No text-message permission/);
  });
  it("allows service email without marketing consent", () => {
    expect(ineligibilityReason(base)).toBeNull();
  });
  it("STOP blocks every text, even with consent on file", () => {
    expect(
      ineligibilityReason({ ...base, channel: "SMS", address: "+15550100101", personConsents: [rec("SMS_SERVICE", "GRANTED")], suppressions: [{ reason: "STOP" }] }),
    ).toMatch(/STOP/);
  });
  it("a promotional unsubscribe doesn't block service email, but blocks promos", () => {
    const s = { suppressions: [{ reason: "UNSUBSCRIBE" as const }], personConsents: [rec("EMAIL_MARKETING", "GRANTED")] };
    expect(ineligibilityReason({ ...base, ...s })).toBeNull();
    expect(ineligibilityReason({ ...base, ...s, purpose: "TAX_PREP_PROMO" })).toMatch(/Unsubscribed/);
  });
  it("latest record wins", () => {
    const older = rec("EMAIL_MARKETING", "GRANTED", { effectiveAt: new Date(Date.now() - 3 * day) });
    const newer = rec("EMAIL_MARKETING", "REVOKED");
    expect(currentConsent([older, newer], "EMAIL_MARKETING")).toBe("REVOKED");
  });
  it("7216 grants count only when reviewed with evidence", () => {
    expect(currentConsent([rec("TAX_INFO_USE", "GRANTED")], "TAX_INFO_USE")).toBe("UNKNOWN");
    expect(currentConsent([rec("TAX_INFO_USE", "GRANTED", { reviewedAt: new Date(), evidenceFileId: "f" })], "TAX_INFO_USE")).toBe("GRANTED");
  });
  it("tax-derived contacts need a 7216 consent for promotions of other services", () => {
    const input = { ...base, purpose: "OTHER_SERVICES_PROMO" as const, taxReturnDerived: true, personConsents: [rec("EMAIL_MARKETING", "GRANTED")] };
    expect(ineligibilityReason(input)).toMatch(/7216/);
    expect(
      ineligibilityReason({ ...input, clientConsents: [rec("TAX_INFO_USE", "GRANTED", { reviewedAt: new Date(), evidenceFileId: "f" })] }),
    ).toBeNull();
  });
  it("expired consent no longer counts", () => {
    expect(currentConsent([rec("SMS_MARKETING", "GRANTED", { expiresAt: new Date(Date.now() - 1000) })], "SMS_MARKETING")).toBe("UNKNOWN");
  });
});

describe("import field safety", () => {
  it("blocks sensitive headers and never guesses them", () => {
    for (const h of ["SSN", "Taxpayer SSN", "Date of Birth", "DOB", "AGI", "Bank Routing", "Dependents", "Refund Amount", "Spouse SSN", "EIN"]) {
      expect(isSensitiveHeader(h), h).toBe(true);
      expect(guessField(h), h).toBeNull();
    }
    expect(guessField("Email Address")).toBe("email");
    expect(guessField("First Name")).toBe("firstName");
    expect(guessField("Cell Phone")).toBe("phone");
  });
  it("drops non-allow-listed fields and blocks SSNs in notes", () => {
    const { row, errors, warnings } = cleanRow({ firstName: "A", lastName: "B", ssn: "123-45-6789" });
    expect(row).not.toHaveProperty("ssn");
    expect(warnings.join()).toMatch(/Ignored 1/);
    expect(errors).toEqual([]);
    expect(cleanRow({ firstName: "A", notes: "ssn 123-45-6789" }).errors.join()).toMatch(/SSN/);
  });
  it("splits 'Last, First' full names", () => {
    const { row } = cleanRow({ fullName: "Lindqvist, Avery" });
    expect(row.firstName).toBe("Avery");
    expect(row.lastName).toBe("Lindqvist");
  });
});

describe("upload sniffing", () => {
  it("trusts file signatures, not names", () => {
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])))?.toBeTruthy();
    expect(sniffType(new TextEncoder().encode("<html><script>"))).toBeNull();
  });
});
