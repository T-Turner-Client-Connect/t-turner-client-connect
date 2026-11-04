"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { bankLinkTokenAction, completeBankLinkAction, completeBankReauthAction } from "@/app/actions/ledger";

type PlaidHandler = { open: () => void };
type PlaidCreate = {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, meta: { institution?: { name?: string } | null }) => void;
  onExit?: () => void;
};
declare global {
  interface Window {
    Plaid?: { create: (o: PlaidCreate) => PlaidHandler };
  }
}

const SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
// Kept for the OAuth return trip: some banks send the client to their own site and back to
// PLAID_REDIRECT_URI (/bookkeeping/plaid-oauth), where Link resumes with the same token.
const RESUME_KEY = "plaid-link-resume";
type Resume = { token: string; clientId: string; reauthConnectionId?: string };

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
 * Connect one client business's bank through Plaid Link, then record who authorized read-only
 * access and how. With `reauthConnectionId`, opens Link in update mode so the client signs in
 * again to repair a connection. The access token stays on the server; this page never sees it.
 */
export function BankConnect({ clientId, consentText, live = false, reauthConnectionId, resume }: { clientId: string; consentText: string; live?: boolean; reauthConnectionId?: string; resume?: boolean }) {
  const [linked, setLinked] = useState<{ publicToken: string; institution: string } | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resumed = useRef(false);

  function open(token: string, receivedRedirectUri?: string) {
    window.Plaid!.create({
      token,
      receivedRedirectUri,
      onSuccess: (publicToken, meta) => {
        try { sessionStorage.removeItem(RESUME_KEY); } catch { /* storage may be unavailable */ }
        if (reauthConnectionId) setRepaired(true);
        else setLinked({ publicToken, institution: meta.institution?.name ?? "" });
      },
      onExit: () => setBusy(false),
    }).open();
  }

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const r = await bankLinkTokenAction(clientId, reauthConnectionId);
      if (!r.token) throw new Error(r.error ?? "Couldn't start the bank connection.");
      try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ token: r.token, clientId, reauthConnectionId } satisfies Resume)); } catch { /* storage may be unavailable */ }
      await loadPlaid();
      open(r.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the bank connection.");
      setBusy(false);
    }
  }

  // Back from a bank's own sign-in page (OAuth): resume the same Link session.
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    let saved: Resume | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null"); } catch { saved = null; }
    if (!saved || saved.clientId !== clientId) return;
    loadPlaid().then(() => open(saved!.token, window.location.href)).catch(() => setError("Couldn't load Plaid"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, clientId]);

  if (repaired && reauthConnectionId) {
    return (
      <ActionForm action={completeBankReauthAction.bind(null, clientId, reauthConnectionId)} className="space-y-2">
        <p className="font-semibold">The client signed in again.</p>
        <Button type="submit">Resume automatic retrieval</Button>
      </ActionForm>
    );
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
      <Button type="button" variant={reauthConnectionId ? "primary" : "secondary"} onClick={start} disabled={busy} data-testid={reauthConnectionId ? "bank-reconnect" : "bank-connect"}>
        {busy ? "Opening…" : reauthConnectionId ? "Reconnect (client signs in again)" : live ? "Connect a bank" : "Connect a bank (sandbox)"}
      </Button>
      {error && <p className="mt-1 text-sm text-red-700" role="alert">{error}</p>}
    </div>
  );
}
