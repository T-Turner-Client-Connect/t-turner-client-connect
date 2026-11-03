"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { bankLinkTokenAction, completeBankLinkAction } from "@/app/actions/ledger";

type PlaidHandler = { open: () => void };
declare global {
  interface Window {
    Plaid?: { create: (o: { token: string; onSuccess: (publicToken: string, meta: { institution?: { name?: string } | null }) => void; onExit?: () => void }) => PlaidHandler };
  }
}

const SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
function loadPlaid(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load Plaid"));
    document.head.appendChild(s);
  });
}

/**
 * Connect a bank through Plaid Link (sandbox in this phase), then record who authorized
 * read-only access and how. The token stays on the server; this page never sees it.
 */
export function BankConnect({ clientId, consentText }: { clientId: string; consentText: string }) {
  const [linked, setLinked] = useState<{ publicToken: string; institution: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const r = await bankLinkTokenAction(clientId);
      if (!r.token) throw new Error(r.error ?? "Couldn't start the bank connection.");
      await loadPlaid();
      window.Plaid!.create({
        token: r.token,
        onSuccess: (publicToken, meta) => setLinked({ publicToken, institution: meta.institution?.name ?? "" }),
        onExit: () => setBusy(false),
      }).open();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the bank connection.");
      setBusy(false);
    }
  }

  if (linked) {
    return (
      <ActionForm action={completeBankLinkAction.bind(null, clientId, linked.publicToken, linked.institution)} className="space-y-2 rounded-lg border border-gold-500 bg-gold-100/30 p-3 text-sm">
        <p className="font-semibold">Record the client&apos;s authorization{linked.institution ? ` for ${linked.institution}` : ""}</p>
        <p className="text-xs text-slate-700">&ldquo;{consentText}&rdquo;</p>
        <Field label="Authorized by (client's name)"><input className="input" name="authorizedByName" required /></Field>
        <Field label="How"><select className="input" name="method"><option value="CLIENT_PRESENT">Client signed in with staff present</option><option value="CLIENT_PORTAL">Client connected from the portal</option><option value="WRITTEN_AUTHORIZATION">Written authorization on file</option></select></Field>
        <label className="flex items-start gap-2"><input type="checkbox" name="confirm" className="mt-1" /> The client authorized read-only access as stated above.</label>
        <Button type="submit">Save connection</Button>
      </ActionForm>
    );
  }
  return (
    <div>
      <Button type="button" variant="secondary" onClick={start} disabled={busy} data-testid="bank-connect">{busy ? "Opening…" : "Connect a bank (sandbox)"}</Button>
      {error && <p className="mt-1 text-sm text-red-700" role="alert">{error}</p>}
    </div>
  );
}
