import { requireUser } from "@/lib/auth/session";
import { BANK_CONSENT_TEXT } from "@/lib/services/banking";
import { BankOAuthReturn } from "@/components/bank-oauth-return";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Finish connecting the bank" };

// PLAID_REDIRECT_URI points here (https://<site>/bookkeeping/plaid-oauth). Banks that use OAuth
// send the client to their own sign-in page and back here; Link then resumes where it left off.
export default async function PlaidOAuthReturnPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Finish connecting the bank" subtitle="The bank sent you back here. Plaid will finish the connection in a moment." />
      <BankOAuthReturn consentText={BANK_CONSENT_TEXT} />
    </>
  );
}
