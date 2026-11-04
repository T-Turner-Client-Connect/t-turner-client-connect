import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice } from "@/components/ui";
import {
  approveBusinessAccessAction,
  cancelBusinessAccessAction,
  declineBusinessAccessAction,
  removeBusinessAccessAction,
  requestBusinessAccessAction,
} from "@/app/actions/business-access";
import { businessAccessFor, canRequestConversion, MANAGED_SERVICES } from "@/lib/services/business-access";
import { ownerAccessFor } from "@/lib/auth/owner";
import { fmtDateTime } from "@/lib/format";
import type { Actor } from "@/lib/auth/actor";

const LABEL = { OFF: "Regular Tax Client", ACTIVE: "Managed Business Client", REMOVED: "Business access removed" } as const;
const TONE = { OFF: "gray", ACTIVE: "green", REMOVED: "red" } as const;
const ACTION: Record<string, string> = {
  REQUESTED: "Requested conversion",
  APPROVED: "Approved — Managed Business",
  DECLINED: "Declined",
  CANCELLED: "Request withdrawn",
  REMOVED: "Business access removed",
  LOGIN_VIEW_ON: "Business view turned on for a login",
  LOGIN_VIEW_OFF: "Business view turned off for a login",
};

/**
 * Client classification and the owner-approved conversion. Shown on the client's Portal tab.
 * The buttons are conveniences — every decision is re-checked on the server.
 */
export async function BusinessAccessPanel({ clientId, actor }: { clientId: string; actor: Actor }) {
  const [{ client, pending, events }, mayRequest, owner] = await Promise.all([businessAccessFor(clientId), canRequestConversion(actor), ownerAccessFor(actor.id)]);
  if (!client) return null;
  const isOwner = owner?.scope === "FULL";
  const status = client.businessAccess;
  return (
    <Card title="Client classification" className="lg:col-span-2">
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="business-access-status" data-status={status}>
        <Badge tone={TONE[status]}>{LABEL[status]}</Badge>
        {client.businessAccessChangedAt && <span className="text-xs text-slate-500">since {fmtDateTime(client.businessAccessChangedAt)}</span>}
      </div>
      <p className="mb-3 text-sm text-slate-600">
        Every client is a Regular Tax Client unless Tabitha approves Managed Business access for this business. Choosing &ldquo;Business&rdquo; at sign-up, the client type, or owning an LLC, corporation or nonprofit never changes this.
      </p>

      {pending ? (
        <div className="rounded-lg border border-gold-300 bg-gold-50 p-3 text-sm" data-testid="business-access-pending">
          <p><strong>Waiting for Tabitha:</strong> requested by {pending.requestedBy.name} on {fmtDateTime(pending.createdAt)}</p>
          <p className="mt-1">Services: {pending.services.join(", ")}</p>
          <p className="mt-1 text-slate-700">{pending.reason}</p>
          {isOwner && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <ActionForm action={approveBusinessAccessAction.bind(null, pending.id, clientId)} className="space-y-2">
                <Field label="Note (optional)"><input className="input" name="note" maxLength={500} /></Field>
                <Button type="submit" data-testid="approve-business">Approve Managed Business access</Button>
              </ActionForm>
              <ActionForm action={declineBusinessAccessAction.bind(null, pending.id, clientId)} className="space-y-2">
                <Field label="Reason"><input className="input" name="note" required maxLength={500} /></Field>
                <Button type="submit" variant="secondary">Decline</Button>
              </ActionForm>
            </div>
          )}
          {(isOwner || pending.requestedById === actor.id) && (
            <ActionForm action={cancelBusinessAccessAction.bind(null, pending.id, clientId)} className="mt-2">
              <Button type="submit" variant="secondary">Withdraw request</Button>
            </ActionForm>
          )}
        </div>
      ) : status !== "ACTIVE" && mayRequest ? (
        <ActionForm action={requestBusinessAccessAction.bind(null, clientId)} className="space-y-3">
          <fieldset>
            <legend className="mb-1 text-sm font-semibold text-navy-900">Business services our firm actively provides</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {MANAGED_SERVICES.map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" name="services" value={s} className="accent-navy-900" /> {s}</label>)}
            </div>
          </fieldset>
          <Field label="Why this business should be managed" hint="Tabitha sees this when she decides."><textarea className="input" name="reason" rows={2} required minLength={10} maxLength={1000} /></Field>
          <Button type="submit">Request Managed Business access</Button>
        </ActionForm>
      ) : status !== "ACTIVE" ? (
        <Notice>Only Tabitha, or staff she authorizes, can request Managed Business access.</Notice>
      ) : null}

      {status === "ACTIVE" && isOwner && (
        <details className="mt-3 rounded-lg border border-red-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-red-800">Remove business access</summary>
          <ActionForm action={removeBusinessAccessAction.bind(null, clientId)} className="mt-2 space-y-2">
            <p className="text-sm text-slate-600">Blocks the Business side for every login right away. The ledger, bank records, invoices, statements, tax history, documents and messages are all kept.</p>
            <Field label="Reason"><input className="input" name="reason" required maxLength={500} /></Field>
            <Field label='Type "REMOVE" to confirm'><input className="input" name="confirm" required /></Field>
            <Button type="submit" variant="danger">Remove business access</Button>
          </ActionForm>
        </details>
      )}

      {events.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-navy-900">Access history ({events.length})</summary>
          <ul className="mt-2 divide-y divide-navy-100 text-sm" data-testid="business-access-history">
            {events.map((e) => (
              <li key={e.id} className="py-1.5">
                <strong>{ACTION[e.action] ?? e.action}</strong> · {e.actor?.name ?? "—"} · {fmtDateTime(e.createdAt)}
                {e.note && <span className="block text-slate-600">{e.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
