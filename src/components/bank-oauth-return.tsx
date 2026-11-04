"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { BankConnect } from "@/components/bank-connect";

const read = () => {
  try {
    return sessionStorage.getItem("plaid-link-resume") ?? "";
  } catch {
    return "";
  }
};

/** Resumes a Plaid Link session after a bank's OAuth sign-in, for the business it was started for. */
export function BankOAuthReturn({ consentText }: { consentText: string }) {
  const raw = useSyncExternalStore(() => () => {}, read, () => "");
  let saved: { clientId?: string; reauthConnectionId?: string } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  if (!saved?.clientId) return <p className="text-sm">Nothing to resume here. Start the connection again from the business&apos;s <Link className="underline" href="/bookkeeping">Books &amp; Ledger → Bank &amp; reconcile</Link>.</p>;
  return (
    <div className="space-y-3">
      <BankConnect clientId={saved.clientId} consentText={consentText} reauthConnectionId={saved.reauthConnectionId} live resume />
      <p className="text-sm"><Link className="underline" href={`/bookkeeping/${saved.clientId}/books?tab=bank`}>Back to the business&apos;s bank page</Link></p>
    </div>
  );
}
