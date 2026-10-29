import { SmsConsentForm } from "@/components/sms-consent-form";
import { BUSINESS, SMS_CONSENT_TEXT } from "@/lib/business";

export const metadata = { title: "Stay Connected with TTurner" };

export default function SmsConsentPage() {
  return (
    <div className="rounded-2xl border border-ivory-200 bg-white p-6 shadow-sm sm:p-10">
      <h1 className="text-3xl font-bold sm:text-4xl">Stay Connected with TTurner</h1>
      <p className="mt-3 text-[17px] text-slate-700">
        Receive updates from {BUSINESS.legalName} through {BUSINESS.platformName}. Choose the messages you would like to receive.
      </p>
      <p className="mt-1 text-sm text-slate-500">{BUSINESS.platformIdentity}.</p>
      <div className="mt-8">
        <SmsConsentForm serviceText={SMS_CONSENT_TEXT.SERVICE} marketingText={SMS_CONSENT_TEXT.MARKETING} />
      </div>
    </div>
  );
}
