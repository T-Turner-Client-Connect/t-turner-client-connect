import Link from "next/link";
import { LegalDoc } from "@/components/legal-doc";
import { BUSINESS, LEGAL_EFFECTIVE_DATE } from "@/lib/business";

export const metadata = { title: "Terms & Conditions" };

export default function Terms() {
  return (
    <LegalDoc title="Terms & Conditions" effective={LEGAL_EFFECTIVE_DATE}>
      <p>{BUSINESS.platformName} is a client communication platform operated by {BUSINESS.legalName} ({BUSINESS.platformIdentity}).</p>
      <section>
        <h2>Portal use</h2>
        <p>Keep your login credentials private and access only accounts and documents you are authorized to use. Provide accurate information and notify our office if you suspect unauthorized access.</p>
      </section>
      <section>
        <h2>Professional services</h2>
        <p>
          Use of this platform does not by itself establish an engagement or guarantee a filing, acceptance, refund, deadline extension, or other outcome. The scope and fees of professional services
          are governed by the applicable engagement agreement.
        </p>
      </section>
      <section>
        <h2>SMS program</h2>
        <p>
          If you opt in, you may receive recurring SMS and MMS messages about appointments, document requests, account updates, secure portal notifications, and customer support. Promotional
          messages, offers, announcements, and flyers require separate marketing consent.
        </p>
        <p className="mt-3">Message frequency varies. Message and data rates may apply. Consent to text messages is optional and is not a condition of purchase.</p>
        <p className="mt-3">
          Reply STOP to unsubscribe. You may receive a final confirmation of your opt-out. Reply HELP for assistance or contact our office at{" "}
          <a className="font-semibold text-navy-800 underline" href={`tel:${BUSINESS.officePhoneTel}`}>{BUSINESS.officePhoneDisplay}</a>. To resume messages, provide a new opt-in through our{" "}
          <Link className="underline" href="/sms-consent">consent form</Link>.
        </p>
        <p className="mt-3">
          Delivery depends on mobile networks and service availability. Carriers are not liable for delayed or undelivered messages. Text messages are not an emergency service. Do not send
          sensitive tax documents, Social Security numbers, passwords, or bank details by text; use the secure portal.
        </p>
      </section>
      <section>
        <h2>Privacy</h2>
        <p>Our <Link className="underline" href="/privacy-policy">Privacy Policy</Link> explains how we handle information and messaging consent.</p>
      </section>
    </LegalDoc>
  );
}
