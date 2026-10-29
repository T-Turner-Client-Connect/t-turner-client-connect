"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Notice } from "@/components/ui";
import { setExclusionsAction } from "@/app/actions/campaigns";
import type { ExcludedRecipient, Recipient } from "@/lib/campaigns/recipients";

const CH = { EMAIL: "Email", SMS: "Text" } as const;

export function RecipientReview({
  campaignId,
  eligible,
  excluded,
  editable,
}: {
  campaignId: string;
  eligible: Recipient[];
  excluded: ExcludedRecipient[];
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  const needle = q.trim().toLowerCase();
  const match = (r: { name: string; clientName: string; addressDisplay: string | null }) =>
    !needle || r.name.toLowerCase().includes(needle) || r.clientName.toLowerCase().includes(needle) || (r.addressDisplay ?? "").toLowerCase().includes(needle);
  const shownEligible = useMemo(() => eligible.filter(match), [eligible, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownExcluded = useMemo(() => excluded.filter(match), [excluded, needle]); // eslint-disable-line react-hooks/exhaustive-deps

  function apply(clientIds: string[], exclude: boolean) {
    setError(null);
    start(async () => {
      const res = await setExclusionsAction(campaignId, clientIds, exclude, exclude ? reason : undefined);
      if (res?.error) setError(res.error);
      setPicked(new Set());
      setReason("");
      router.refresh();
    });
  }

  const emailCount = eligible.filter((r) => r.channel === "EMAIL").length;
  const smsCount = eligible.filter((r) => r.channel === "SMS").length;
  const manual = excluded.filter((x) => x.manual);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge tone="green">{emailCount} email{emailCount === 1 ? "" : "s"}</Badge>
        <Badge tone="green">{smsCount} text{smsCount === 1 ? "" : "s"}</Badge>
        <Badge tone="red">{excluded.length} not sending</Badge>
        {manual.length > 0 && <Badge tone="gray">{manual.length} removed by staff</Badge>}
      </div>
      <input className="input max-w-md" placeholder="Search recipients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search recipients" />
      {error && <Notice tone="error">{error}</Notice>}

      <section className="rounded-xl border border-navy-100 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-100 p-3">
          <h3 className="font-semibold">Will receive ({eligible.length})</h3>
          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => setPicked(new Set(shownEligible.map((r) => r.clientId)))} disabled={!shownEligible.length}>Select all</Button>
              <Button variant="secondary" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</Button>
              <input className="input w-48" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for removal" />
              <Button variant="danger" disabled={!picked.size || pending} onClick={() => apply([...picked], true)}>
                Remove {picked.size || ""} from campaign
              </Button>
            </div>
          )}
        </div>
        {shownEligible.length === 0 ? (
          <p className="p-4 text-sm text-slate-600">{eligible.length ? "No matches." : "Nobody is eligible yet. Check the audience and the reasons below."}</p>
        ) : (
          <ul className="max-h-[26rem] divide-y divide-navy-100 overflow-y-auto">
            {shownEligible.map((r) => (
              <li key={r.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                {editable && (
                  <input
                    type="checkbox"
                    className="size-4 accent-navy-900"
                    aria-label={`Select ${r.name}`}
                    checked={picked.has(r.clientId)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(r.clientId);
                      else next.delete(r.clientId);
                      setPicked(next);
                    }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}{r.contactId ? ` (${r.clientName})` : ""}</span>
                  <span className="text-slate-600">{r.addressDisplay}</span>
                </span>
                <Badge tone="navy">{CH[r.channel]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-navy-100 bg-white">
        <h3 className="border-b border-navy-100 p-3 font-semibold">Not sending ({excluded.length})</h3>
        {shownExcluded.length === 0 ? (
          <p className="p-4 text-sm text-slate-600">{excluded.length ? "No matches." : "Everyone selected is eligible."}</p>
        ) : (
          <ul className="max-h-[26rem] divide-y divide-navy-100 overflow-y-auto">
            {shownExcluded.map((r, i) => (
              <li key={`${r.clientId}-${r.contactId}-${r.channel}-${i}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.name}{r.contactId ? ` (${r.clientName})` : ""}</span>
                  <span className="text-slate-600">{[r.channel && CH[r.channel], r.addressDisplay].filter(Boolean).join(" · ")}</span>
                  <span className="block text-red-800">{r.reason}</span>
                </span>
                {editable && r.manual && <Button variant="secondary" disabled={pending} onClick={() => apply([r.clientId], false)}>Add back</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-slate-600">
        Each person gets their own message, so recipients never see each other&apos;s email address or phone number. Opt-outs and missing permissions can&apos;t be overridden
        here — record a permission on the client&apos;s page if they&apos;ve given it.
      </p>
    </div>
  );
}
