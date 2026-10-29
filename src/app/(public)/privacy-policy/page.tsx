import Link from "next/link";
import { LegalDoc } from "@/components/legal-doc";
import { BUSINESS, LEGAL_EFFECTIVE_DATE } from "@/lib/business";

export const metadata = { title: "Privacy Policy" };

export default function PrivacyPolicy() {
  return (
    <LegalDoc title="Privacy Policy" effective={LEGAL_EFFECTIVE_DATE}>
      <p>{BUSINESS.legalName} operates {BUSINESS.platformName} to communicate with clients and support our professional services. This policy applies to {BUSINESS.platformIdentity}.</p>
      <section>
        <h2>Information we collect</h2>
        <p>
          We collect information you provide, such as your name, contact information, communication preferences, messages, and information submitted for requested services. The platform may
          also collect technical information needed for security and operation, including access logs and device or browser information.
        </p>
      </section>
      <section>
        <h2>How we use information</h2>
        <p>
          We use information to provide requested services, manage client accounts, respond to inquiries, request documents, deliver account notifications, maintain communication preferences,
          protect the platform, and meet applicable recordkeeping obligations. Promotional text messages are sent only to recipients who separately consent to them.
        </p>
      </section>
      <section>
        <h2>Service providers and disclosures</h2>
        <p>
          We may disclose information to service providers that support hosting, secure storage, communications, and other business operations, only as needed for those functions. We may also
          disclose information when required by law or necessary to protect legal rights and security.
        </p>
      </section>
      <section>
        <h2>SMS privacy</h2>
        <p>
          We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes. Mobile opt-in information and consent will not be shared with affiliates or
          lead generators for promotional purposes. Information may be provided to messaging service providers solely to deliver and operate our text messaging program.
        </p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>
          You may decline optional messaging. Reply STOP to unsubscribe from texts or HELP for assistance. To request access to, correction of, or deletion of your information, contact our office.
          Some records may need to be retained for professional, legal, or operational reasons.
        </p>
      </section>
      <section>
        <h2>Security and retention</h2>
        <p>
          We use safeguards appropriate to the information we handle. No electronic system can guarantee absolute security. We retain information as needed to provide services, maintain consent
          and suppression records, and satisfy applicable obligations. Please use the secure client portal for sensitive documents rather than sending them by text.
        </p>
      </section>
      <section>
        <h2>Updates and contact</h2>
        <p>
          We may update this policy and will display the revised effective date. For privacy questions, contact our office at{" "}
          <a className="font-semibold text-navy-800 underline" href={`tel:${BUSINESS.officePhoneTel}`}>{BUSINESS.officePhoneDisplay}</a>.
        </p>
      </section>
      <p className="text-sm text-slate-600">
        See also our <Link className="underline" href="/terms">Terms &amp; Conditions</Link> and <Link className="underline" href="/sms-consent">SMS consent page</Link>.
      </p>
    </LegalDoc>
  );
}
