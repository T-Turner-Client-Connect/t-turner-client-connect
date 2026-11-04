// Single source for the business identity shown on public pages, in emails
// and in text messages. Must match the brand registered for SMS (A2P 10DLC).
// Values supplied by the business owner — see docs/SMS-PROGRAM.md for which
// items still need confirmation.

// The owner's staff sign-in. Used once, to bind the Owner's Office to that
// account's ID; afterwards access follows the account ID, not the email.
export const OWNER_EMAIL = "tabitha@tturnerassociates.com";

export const BUSINESS = {
  // Legal business name as on the EIN and Secretary of State filing (confirmed by the owner).
  legalName: "T. Turner & Associates, LLC",
  // Client-facing business name on statements and packets (the owner's choice).
  // The registered legal name stays in document metadata and legal pages.
  displayName: "TTurner & Associates",
  // How messages identify the sender (e.g. "T. Turner & Associates: …").
  shortName: "T. Turner & Associates",
  platformName: "TTurner Client Connect",
  // How the platform is identified on the consent form, Privacy Policy and Terms.
  platformIdentity: "TTurner Client Connect, operated by T. Turner & Associates, LLC",
  officePhoneDisplay: "205-639-1000",
  officePhoneTel: "+12056391000",
  // Privacy questions and requests (Privacy Policy contact).
  privacyEmail: "info@tturnerassociates.com",
} as const;

/** Date the Terms were published. Update when the text changes. */
export const LEGAL_EFFECTIVE_DATE = "October 29, 2026";

/**
 * Date the current Privacy Policy text takes effect. Set it to the publication
 * date when the owner approves and the update is deployed.
 */
export const PRIVACY_EFFECTIVE_DATE = "November 4, 2026";

// Exact consent wording. Any change must get a new version so stored
// consents always point at the text the person actually saw.
export const SMS_CONSENT_VERSION = "sms-consent-2026-10-29-v2";

export const SMS_CONSENT_TEXT = {
  SERVICE: `I agree to receive recurring automated SMS and MMS messages from ${BUSINESS.legalName} through ${BUSINESS.platformName} about appointments, document requests, account updates, secure portal notifications, and customer support. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help.`,
  MARKETING: `I agree to receive recurring automated promotional SMS and MMS messages from ${BUSINESS.legalName} through ${BUSINESS.platformName}, including service announcements, offers, and flyers. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Consent is not a condition of purchase.`,
} as const;

/** Reply sent for HELP (when the app answers keywords itself). */
export const SMS_HELP_REPLY = `${BUSINESS.shortName} (${BUSINESS.platformName}): for help call ${BUSINESS.officePhoneDisplay}. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe.`;
export const SMS_STOP_REPLY = `${BUSINESS.shortName}: You are unsubscribed and will receive no further text messages. Reply START to resume. Essential account notices will still come by email and in your portal.`;
export const SMS_START_REPLY = `${BUSINESS.shortName}: You are resubscribed to the text messages you had agreed to. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.`;
