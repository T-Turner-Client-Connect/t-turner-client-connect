import Link from "next/link";
import { LegalDoc } from "@/components/legal-doc";
import { BUSINESS, PRIVACY_EFFECTIVE_DATE } from "@/lib/business";

export const metadata = { title: "Privacy Policy" };

const PLAID_PRIVACY_URL = "https://plaid.com/legal/#end-user-privacy-policy";
const list = "list-disc space-y-1 pl-6";
const status = "rounded-lg border border-gold-300 bg-gold-50 px-4 py-3 text-[15px]";

/**
 * The effective date shown on the policy. A production build fails until the owner's
 * publication date is set, so the updated text can't go live with a placeholder date.
 */
function effectiveDate(): string {
  if (PRIVACY_EFFECTIVE_DATE) return PRIVACY_EFFECTIVE_DATE;
  if ((process.env.BUILD_CONTEXT || process.env.CONTEXT) === "production") {
    throw new Error("Set PRIVACY_EFFECTIVE_DATE in src/lib/business.ts to the publication date before publishing the Privacy Policy.");
  }
  return "Pending publication (draft)";
}

export default function PrivacyPolicy() {
  return (
    <LegalDoc title="Privacy Policy" effective={effectiveDate()}>
      <p>{BUSINESS.legalName} operates {BUSINESS.platformName} to communicate with clients and support our professional services. This policy applies to {BUSINESS.platformIdentity}.</p>
      <section>
        <h2>Information we collect</h2>
        <p>
          We collect information you provide, such as your name, contact information, communication preferences, messages, and information submitted for requested services. The platform may
          also collect technical information needed for security and operation, including access logs and device or browser information. If you authorize a bank account connection for
          bookkeeping, we also receive the account information described under &ldquo;Bank account connections through Plaid&rdquo; below.
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
        <h2>Bank account connections through Plaid</h2>
        <p className={status}>
          <strong>Status:</strong> bank account connections are not yet active. When we begin offering them, they will work as described in this section.
        </p>
        <p className="mt-3">
          For bookkeeping clients, we plan to use Plaid Inc. (&ldquo;Plaid&rdquo;) to retrieve read-only information from business bank and credit card accounts, with the client&rsquo;s
          authorization.
        </p>
        <ul className={`${list} mt-3`}>
          <li>
            <strong>How a connection is made.</strong> A member of our staff starts the connection from {BUSINESS.platformName} after signing in with a password and a verification code. During
            that assisted session, you review our read-only consent wording, authorize the connection, and sign in to your financial institution directly within Plaid. We never see or store
            your bank username or password.
          </li>
          <li>
            <strong>Your authorization.</strong> Each connection requires your authorization. We record who authorized it, how it was authorized, and the version of the consent wording shown.
          </li>
          <li>
            <strong>Information we receive.</strong> The name and type of each connected account, your financial institution&rsquo;s name, the last four digits of the account number, account
            balances, and transactions (date, amount, and description, which may include merchant or payee names). We do not request full account or routing numbers.
          </li>
          <li>
            <strong>Account statements.</strong> We have requested Plaid&rsquo;s Statements product, which provides copies of account statements. It will not be used until consent wording
            that covers statements has been approved, added to the connection process, and tested, and you have separately authorized it.
          </li>
          <li>
            <strong>Read-only use.</strong> Bank connections are read-only. We cannot move money, make payments, or change your accounts through them. Each connection belongs to one client
            business, and its information is used only to prepare and reconcile that business&rsquo;s bookkeeping records. We do not sell this information or use it for marketing.
          </li>
          <li>
            <strong>Disconnecting.</strong> You may ask us to disconnect a bank connection at any time. Our staff disconnect it in {BUSINESS.platformName}, which tells Plaid to end our access.
            When a bookkeeping engagement ends, we disconnect the client&rsquo;s bank connections within 30 days. Records already entered in your books are kept under &ldquo;Retention&rdquo;
            below.
          </li>
          <li>
            <strong>Plaid&rsquo;s privacy policy.</strong> Plaid&rsquo;s handling of your information is described in the{" "}
            <a className="font-semibold text-navy-800 underline" href={PLAID_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
              Plaid End User Privacy Policy
            </a>
            .
          </li>
        </ul>
      </section>
      <section>
        <h2>AI-assisted bookkeeping (Coetha)</h2>
        <p className={status}>
          <strong>Status:</strong> AI-assisted bookkeeping is not yet active and is not used with any client&rsquo;s records.
        </p>
        <p className="mt-3">
          We plan to offer Coetha, an AI-assisted bookkeeping tool that drafts transaction categories and bookkeeping entries for our staff to review. It uses an AI service provided by Anthropic.
        </p>
        <ul className={`${list} mt-3`}>
          <li>
            <strong>Your authorization first.</strong> Coetha will not be used with your records unless we have notified you and you have authorized it. You may decline, or withdraw your
            authorization later; if you do, our staff will continue preparing your books without it.
          </li>
          <li>
            <strong>Information sent to the AI service.</strong> Coetha works on one client business at a time. Client names are not sent. Before transaction information is sent, email
            addresses, telephone numbers, and numbers formatted like Social Security or Employer Identification Numbers are removed, and long numbers such as full account numbers are shortened to
            their last four digits. Transaction amounts, dates, and descriptions are sent, and descriptions may still include merchant or payee names.
          </li>
          <li>
            <strong>Human review.</strong> Coetha only drafts. Our owner reviews and approves its work, and nothing it drafts is sent to you or becomes part of your released financial statements
            without that approval.
          </li>
        </ul>
      </section>
      <section>
        <h2>Service providers and disclosures</h2>
        <p>
          We use service providers to operate {BUSINESS.platformName}. Each receives only the information its function requires, and we do not sell personal information.
        </p>
        <ul className={`${list} mt-3`}>
          <li><strong>Netlify</strong> &mdash; hosts {BUSINESS.platformName}, including its database and file storage.</li>
          <li><strong>Plaid</strong> &mdash; bank account connections (not yet active; described above).</li>
          <li><strong>Square</strong> &mdash; invoices and payments.</li>
          <li><strong>Anthropic</strong> &mdash; the AI service for AI-assisted bookkeeping (not yet active; used only with your authorization, as described above).</li>
          <li><strong>Resend</strong> &mdash; email delivery.</li>
          <li><strong>Twilio</strong> &mdash; text message delivery for our SMS program.</li>
          <li><strong>Jotform</strong> &mdash; online forms and questionnaires.</li>
          <li><strong>Cloudmersive</strong> &mdash; virus scanning of uploaded files.</li>
        </ul>
        <p className="mt-3">We may also disclose information when required by law or necessary to protect legal rights and security.</p>
      </section>
      <section>
        <h2>SMS privacy</h2>
        <p>
          We do not sell or share your SMS opt-in data or personal information with third parties for marketing purposes. Mobile opt-in information and consent will not be shared with affiliates or
          lead generators for promotional purposes. Information may be provided to messaging service providers solely to deliver and operate our text messaging program.
        </p>
      </section>
      <section>
        <h2>Security</h2>
        <p>
          Staff and client portal sign-ins require a password and a verification code. Information is encrypted in transit, and our hosting provider encrypts stored data. When bank connections become
          available, their access credentials will also be encrypted by {BUSINESS.platformName}. Client document uploads are subject to malware scanning and access controls designed to prevent staff and clients from opening files until scanning succeeds. Access to client records is limited to authorized
          personnel and is logged. No electronic system can guarantee absolute security. Please use the secure client portal for sensitive documents rather than sending them by text.
        </p>
      </section>
      <section>
        <h2>Retention</h2>
        <p>
          Our records retention policy keeps client records for the following periods, or longer when required by law or a legal hold:
        </p>
        <ul className={`${list} mt-3`}>
          <li>Tax returns, workpapers, and signed e-file authorization and due-diligence forms: seven years after the tax year.</li>
          <li>Tax source documents (such as W-2s, 1099s, and statements): seven years after the tax year.</li>
          <li>Bookkeeping and payroll records, including any bank transaction information entered in your books: seven years after the end of the year they cover.</li>
          <li>Identity documents: while you are an active client, then seven years.</li>
          <li>Engagement letters, contracts, invoices, and payment records: seven years after the engagement ends.</li>
          <li>Security and access logs: seven years.</li>
        </ul>
        <p className="mt-3">
          These periods meet or exceed the federal record-keeping minimums that apply to tax return preparers. Records are not deleted automatically; deletion requires our owner&rsquo;s
          approval. We also keep consent and opt-out records as needed to honor your choices.
        </p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>
          You may decline optional messaging. Reply STOP to unsubscribe from texts or HELP for assistance. To request access to, correction of, or deletion of your information, contact our office.
          Some records must be retained for professional, legal, or operational reasons, as described under &ldquo;Retention.&rdquo; You may ask us at any time to disconnect a bank connection or,
          once offered, to withdraw your authorization for AI-assisted bookkeeping.
        </p>
      </section>
      <section>
        <h2>Updates and contact</h2>
        <p>
          We may update this policy and will display the revised effective date. For privacy questions or requests, email{" "}
          <a className="font-semibold text-navy-800 underline" href={`mailto:${BUSINESS.privacyEmail}`}>{BUSINESS.privacyEmail}</a> or call{" "}
          <a className="font-semibold text-navy-800 underline" href={`tel:${BUSINESS.officePhoneTel}`}>{BUSINESS.officePhoneDisplay}</a>.
        </p>
      </section>
      <p className="text-sm text-slate-600">
        See also our <Link className="underline" href="/terms">Terms &amp; Conditions</Link> and <Link className="underline" href="/sms-consent">SMS consent page</Link>.
      </p>
    </LegalDoc>
  );
}
