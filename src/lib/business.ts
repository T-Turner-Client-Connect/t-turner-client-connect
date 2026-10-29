// Single source for the business identity shown on public pages, in emails
// and in text messages. Must match the brand registered for SMS (A2P 10DLC).
// Values supplied by the business owner — see docs/SMS-PROGRAM.md for which
// items still need confirmation.

export const BUSINESS = {
  // Existing legal business name (confirmed by the owner).
  legalName: "T. Turner & Associates, LLC",
  // How messages identify the sender (e.g. "T. Turner & Associates: …").
  shortName: "T. Turner & Associates",
  platformName: "TTurner Client Connect",
  // How the platform is identified on the consent form, Privacy Policy and Terms.
  platformIdentity: "TTurner Client Connect, operated by T. Turner & Associates, LLC",
  officePhoneDisplay: "205-659-5448",
  officePhoneTel: "+12056595448",
} as const;

/** Date the Privacy Policy and Terms were published. Update when the text changes. */
export const LEGAL_EFFECTIVE_DATE = "October 29, 2026";

// Exact consent wording. Any change must get a new version so stored
// consents always point at the text the person actually saw.
export const SMS_CONSENT_VERSION = "sms-consent-2026-10-29-v1";

export const SMS_CONSENT_TEXT = {
  SERVICE: `I agree to receive recurring automated SMS and MMS messages from ${BUSINESS.legalName} through ${BUSINESS.platformName} about appointments, document requests, account updates, secure portal notifications, and customer support. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help.`,
  MARKETING: `I agree to receive recurring automated promotional SMS and MMS messages from ${BUSINESS.legalName} through ${BUSINESS.platformName}, including service announcements, offers, and flyers. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help. Consent is not a condition of purchase.`,
} as const;

/** Reply sent for HELP (when the app answers keywords itself). */
export const SMS_HELP_REPLY = `${BUSINESS.shortName} (${BUSINESS.platformName}): for help call ${BUSINESS.officePhoneDisplay}. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe.`;
export const SMS_STOP_REPLY = `${BUSINESS.shortName}: You are unsubscribed and will receive no further messages. To resume, opt in again at our SMS consent page.`;
