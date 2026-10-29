import type {
  CampaignPurpose,
  Channel,
  ConsentKind,
  ConsentRecord,
  ConsentStatus,
  SuppressionReason,
} from "@prisma/client";

/**
 * Communication-permission rules. These run on the server when recipients
 * are previewed, and again immediately before anything is sent.
 *
 * Legal note: these rules are a conservative starting point, not legal
 * advice. Final consent wording and the 7216 policy must be reviewed by
 * counsel before production use.
 */
export const POLICY = {
  // Contacts whose details came from tax-preparation data (e.g. a TaxAct
  // export) need a reviewed Section 7216 "use" consent before they receive
  // promotions for services other than tax preparation.
  requireTaxInfoUseForOtherServicesPromo: true,
  // Conservative default: also require it for tax-prep promotions. Counsel
  // may advise that some tax-preparation solicitations are permitted without
  // it; change only after that review.
  requireTaxInfoUseForTaxPrepPromo: true,
} as const;

export const CONSENT_LABELS: Record<ConsentKind, string> = {
  SMS_MARKETING: "Text messages — promotions",
  SMS_SERVICE: "Text messages — service updates",
  EMAIL_MARKETING: "Email — promotions",
  TAX_INFO_USE: "Section 7216 — use of tax information",
  TAX_INFO_DISCLOSURE: "Section 7216 — disclosure of tax information",
};

export const PURPOSE_LABELS: Record<CampaignPurpose, string> = {
  SERVICE: "Service message (appointments, documents, deadlines)",
  TAX_PREP_PROMO: "Promotion — tax preparation",
  OTHER_SERVICES_PROMO: "Promotion — other services (bookkeeping, payroll, nonprofit…)",
};

export const TAX_INFO_KINDS: ConsentKind[] = ["TAX_INFO_USE", "TAX_INFO_DISCLOSURE"];

type ConsentLike = Pick<
  ConsentRecord,
  "kind" | "status" | "effectiveAt" | "createdAt" | "expiresAt" | "reviewedAt" | "evidenceFileId"
>;

/**
 * Latest status for one kind. A 7216 grant only counts once an Admin has
 * reviewed it and a signed document is attached. Expired grants are UNKNOWN.
 */
export function currentConsent(records: ConsentLike[], kind: ConsentKind, now = new Date()): ConsentStatus {
  const latest = records
    .filter((r) => r.kind === kind && r.effectiveAt <= now)
    .sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime() || b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!latest) return "UNKNOWN";
  if (latest.status !== "GRANTED") return latest.status;
  if (latest.expiresAt && latest.expiresAt <= now) return "UNKNOWN";
  if (TAX_INFO_KINDS.includes(kind) && (!latest.reviewedAt || !latest.evidenceFileId)) return "UNKNOWN";
  return "GRANTED";
}

export type ActiveSuppression = { reason: SuppressionReason };

export type EligibilityInput = {
  channel: Channel;
  purpose: CampaignPurpose;
  address: string | null;
  archived: boolean;
  taxReturnDerived: boolean;
  // Consent records for the person who owns this address.
  personConsents: ConsentLike[];
  // Client-level consent records (Section 7216 is always client-level).
  clientConsents: ConsentLike[];
  suppressions: ActiveSuppression[];
  now?: Date;
};

const SUPPRESSION_TEXT: Record<SuppressionReason, string> = {
  STOP: "Replied STOP (opted out of texts)",
  UNSUBSCRIBE: "Unsubscribed from promotional email",
  BOUNCE: "Email address bounced",
  COMPLAINT: "Marked a message as spam",
  MANUAL: "On the do-not-contact list",
};

/** Returns null when the address may be messaged, otherwise the reason it can't. */
export function ineligibilityReason(input: EligibilityInput): string | null {
  const { channel, purpose, now = new Date() } = input;
  const isPromo = purpose !== "SERVICE";

  if (input.archived) return "Client is archived";
  if (!input.address) return channel === "EMAIL" ? "No valid email address" : "No valid mobile number";

  for (const s of input.suppressions) {
    // Promotional-email unsubscribes don't block service emails; every other
    // suppression (including SMS STOP) blocks all messages on that channel.
    if (channel === "EMAIL" && s.reason === "UNSUBSCRIBE" && !isPromo) continue;
    return SUPPRESSION_TEXT[s.reason];
  }

  if (channel === "SMS") {
    const marketing = currentConsent(input.personConsents, "SMS_MARKETING", now);
    if (isPromo) {
      if (marketing === "REVOKED") return "Revoked text-message promotions";
      if (marketing !== "GRANTED") return "No text-message promotion permission on file";
    } else {
      const service = currentConsent(input.personConsents, "SMS_SERVICE", now);
      if (service === "REVOKED") return "Revoked service text messages";
      if (service !== "GRANTED" && marketing !== "GRANTED") return "No text-message permission on file";
    }
  }

  if (channel === "EMAIL" && isPromo) {
    const marketing = currentConsent(input.personConsents, "EMAIL_MARKETING", now);
    if (marketing === "REVOKED") return "Opted out of promotional email";
    if (marketing !== "GRANTED") return "No promotional email permission on file";
  }

  const needs7216 =
    input.taxReturnDerived &&
    ((purpose === "OTHER_SERVICES_PROMO" && POLICY.requireTaxInfoUseForOtherServicesPromo) ||
      (purpose === "TAX_PREP_PROMO" && POLICY.requireTaxInfoUseForTaxPrepPromo));
  if (needs7216 && currentConsent(input.clientConsents, "TAX_INFO_USE", now) !== "GRANTED") {
    return "Tax-preparation contact without a reviewed Section 7216 consent";
  }

  return null;
}
