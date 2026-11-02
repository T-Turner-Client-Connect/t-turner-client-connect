import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { removeFromClientAction } from "@/app/actions/related-businesses";
import { businessFamily, linkImpact } from "@/lib/services/related-businesses";

/**
 * Admin-only "Remove From This Client" for a wrongly linked business or
 * nonprofit. Shows what else connects the two records (flagged for review, not
 * changed), asks for a reason, and — for the organization's original or only
 * owner link — the organization's name typed out.
 */
export async function RemoveFromClient({ clientId, businessId, businessName, isAdmin }: { clientId: string; businessId: string; businessName: string; isAdmin: boolean }) {
  if (!isAdmin) return null;
  const fam = await businessFamily(clientId);
  if (!fam || fam.anchor.id === businessId) return null;
  const impact = await linkImpact(fam.anchor.id, businessId);
  if (!impact) return null;
  const protectedLink = impact.isPrimary || impact.onlyOwner;
  return (
    <details className="text-xs" data-testid="remove-from-client">
      <summary className="cursor-pointer font-semibold text-red-800 underline">Remove From This Client</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-red-200 bg-red-50/50 p-2">
        <p>Removes only the link between {fam.anchor.displayName}&apos;s records and {businessName}. The organization, its owner, EIN, documents, contracts, filings and history are not changed.</p>
        {impact.flags.length > 0 && <ul className="list-disc pl-4 text-amber-900" data-testid="remove-flags">{impact.flags.map((f) => <li key={f}>{f}</li>)}</ul>}
        {protectedLink && <p className="font-semibold text-red-900">This is {businessName}&apos;s {impact.onlyOwner ? "only" : "original"} owner link — most likely the legitimate one.</p>}
        <ActionForm action={removeFromClientAction.bind(null, clientId, businessId)} confirm={`Remove ${businessName} from ${fam.anchor.displayName}'s records? The organization and its records stay; the removal is logged.`} className="space-y-1">
          <input className="input w-full" name="reason" placeholder="Why this link is wrong (what you checked)" required minLength={10} />
          {protectedLink && <input className="input w-full" name="confirmName" placeholder={`Type “${businessName}” to confirm`} required />}
          <Button type="submit" variant="ghost">Remove From This Client</Button>
        </ActionForm>
      </div>
    </details>
  );
}
