import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { InvitesSwitchCard } from "../switch-card";
import {
  approveInviteRowsAction,
  confirmSharedEmailAction,
  editInviteRowAction,
  removeInviteRowAction,
  sendInviteBatchAction,
  unapproveInviteRowAction,
} from "@/app/actions/prepared-invitations";
import { requireUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/actor";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { portalInvitesAuthorized } from "@/lib/services/owner-switches";
import { batchCounts, blockingFlags, inviteBatchDetail, ON_HOLD_MESSAGE, rowStatusLabel } from "@/lib/services/prepared-invitations";
import { INVITE_PERMISSION_FLAGS, INVITE_PERMISSION_LABEL, permissionsInWords } from "@/lib/portal/invite-permissions";
import { CLIENT_TYPE_LABELS, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Invitation batch" };

const ROLE_LABEL = { OWNER: "Owner", AUTHORIZED_CONTACT: "Authorized contact" } as const;

export default async function InviteBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireUser();
  const { id } = await params;
  const [detail, owner, authorized] = await Promise.all([inviteBatchDetail(id), isReportApprover(actor), portalInvitesAuthorized()]);
  if (!detail) notFound();
  const { batch, rows } = detail;
  const counts = batchCounts(rows);
  const admin = isAdmin(actor);

  return (
    <>
      <PageHeader
        title={batch.title}
        subtitle={`Prepared by ${batch.createdBy.name} · ${fmtDateTime(batch.createdAt)}${batch.lastSentAt ? ` · last sent ${fmtDateTime(batch.lastSentAt)}` : ""}`}
        actions={<LinkButton href={`/clients/invitations${batch.importBatchId ? `?import=${batch.importBatchId}` : ""}`} variant="secondary">Add more clients</LinkButton>}
      />
      <div className="mb-4">
        <InvitesSwitchCard back={`/clients/invitations/${batch.id}`} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="batch-counts">
        {[
          ["Rows", counts.total],
          ["Need fixing", counts.blocked],
          ["Ready to approve", counts.ready],
          ["Approved, not sent", counts.approved],
          ["Sent", counts.sent],
        ].map(([label, n]) => (
          <div key={label} className="rounded-xl border border-navy-100 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</p>
            <p className="font-serif text-2xl font-bold text-navy-900">{n}</p>
          </div>
        ))}
      </div>

      {owner ? (
        <Card title="Review & approve" className="mb-4">
          <p className="mb-3 text-sm text-navy-800">
            Check every row below: the client, the email address the invitation goes to, the role and what they&apos;ll be able to see. Nothing is sent when you approve. Approved invitations go out only when you press Send
            {authorized ? "." : ", and Send stays on hold until you authorize portal invitations above."}
          </p>
          <div className="flex flex-wrap items-start gap-3">
            <ActionForm action={approveInviteRowsAction.bind(null, batch.id)} id="approve" className="flex flex-wrap gap-2">
              <Button type="submit" name="scope" value="selected" variant="secondary" data-testid="approve-selected">Approve selected</Button>
              <Button type="submit" name="scope" value="all" variant="secondary" data-testid="approve-all" disabled={counts.blocked + counts.ready === 0}>
                Approve whole batch ({counts.blocked + counts.ready})
              </Button>
            </ActionForm>
            <ActionForm action={sendInviteBatchAction.bind(null, batch.id)} confirm={`Send ${counts.approved} approved portal invitation${counts.approved === 1 ? "" : "s"} by email now?`}>
              <Button type="submit" variant="gold" data-testid="send-batch" disabled={counts.approved === 0}>Send {counts.approved} approved</Button>
            </ActionForm>
          </div>
          {!authorized && counts.approved > 0 && <p className="mt-2 text-sm font-medium text-gold-800" data-testid="on-hold-note">{ON_HOLD_MESSAGE}</p>}
        </Card>
      ) : (
        <div className="mb-4">
          <Notice tone="info" title="Tabitha approves and sends">
            You can prepare this batch: fix emails, choose roles and permissions, and remove rows. Only Tabitha can approve rows and send the invitations. Nothing goes out until she does.
          </Notice>
        </div>
      )}

      <ul className="space-y-3" data-testid="batch-rows">
        {rows.map((r) => {
          const blocks = blockingFlags(r.flags);
          const status = rowStatusLabel(r, r.invite);
          const locked = !!r.sendStartedAt;
          const onBk = r.flags.some((f) => f.code === "BOOKKEEPING_YES");
          return (
            <li key={r.id} className="rounded-xl border border-navy-100 bg-white p-4" data-testid="batch-row" data-blocked={blocks.length ? "true" : "false"}>
              <div className="flex flex-wrap items-start gap-3">
                {owner && !locked && (
                  <input type="checkbox" form="approve" name="rowIds" value={r.id} disabled={blocks.length > 0} aria-label={`Approve ${r.client.displayName}`} className="mt-1 size-4 shrink-0 accent-navy-900" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-navy-900">
                      <Link href={`/clients/${r.clientId}?tab=portal`} className="underline decoration-gold-500 underline-offset-4">{r.client.displayName}</Link>{" "}
                      <span className="text-xs font-normal text-slate-600">{CLIENT_TYPE_LABELS[r.client.clientType]}</span>
                    </p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-slate-600">Invitee</dt>
                    <dd className="text-navy-900">{r.inviteeName} · {ROLE_LABEL[r.role]}</dd>
                    <dt className="text-slate-600">Email</dt>
                    <dd className="break-all text-navy-900">{r.email ?? <em className="text-red-800">none</em>}</dd>
                    <dt className="text-slate-600">Permissions</dt>
                    <dd className="text-navy-900">{permissionsInWords(r.perms)}</dd>
                  </dl>
                  {r.flags.length > 0 && !locked && (
                    <p className="mt-2 flex flex-wrap gap-1">
                      {r.flags.map((f) => <Badge key={f.code + f.label} tone={f.tone}>{f.blocking ? "Blocks approval: " : ""}{f.label}</Badge>)}
                    </p>
                  )}
                  {blocks.length > 0 && !locked && <p className="mt-1 text-xs text-red-800">This row can&apos;t be approved until it&apos;s fixed or removed.</p>}
                  {r.approvedAt && !locked && <p className="mt-1 text-xs text-slate-600">Approved by {r.approvedByName ?? "Tabitha"} {fmtDateTime(r.approvedAt)}</p>}
                  {locked && (r.resultDetail || r.invite?.emailError) && <p className="mt-1 text-xs text-slate-700">{r.resultDetail}{r.resultAt ? ` · ${fmtDateTime(r.resultAt)}` : ""}</p>}
                  {!locked && (
                    <div className="mt-2 flex flex-wrap items-start gap-2">
                      <details className="w-full sm:w-auto">
                        <summary className="cursor-pointer text-sm font-semibold underline">Edit</summary>
                        <ActionForm action={editInviteRowAction.bind(null, batch.id, r.id)} className="mt-2 grid gap-2 rounded-lg border border-ivory-200 p-3 sm:grid-cols-2">
                          <Field label="Invitee name"><input className="input" name="inviteeName" defaultValue={r.inviteeName} required maxLength={120} /></Field>
                          <Field label="Email"><input className="input" name="email" type="email" defaultValue={r.email ?? ""} inputMode="email" /></Field>
                          <Field label="Role">
                            <select className="input" name="role" defaultValue={r.role}>
                              <option value="OWNER">Owner</option>
                              <option value="AUTHORIZED_CONTACT">Authorized contact</option>
                            </select>
                          </Field>
                          <fieldset className="sm:col-span-2">
                            <legend className="mb-1 text-sm font-semibold text-navy-900">Portal permissions</legend>
                            <div className="flex flex-wrap gap-3 text-sm">
                              {INVITE_PERMISSION_FLAGS.map((f) =>
                                f === "canViewIdentity" && !admin ? (
                                  <label key={f} className="flex items-center gap-1 text-slate-500">
                                    <input type="checkbox" checked={r.perms[f]} disabled readOnly /> {INVITE_PERMISSION_LABEL[f]} (Admin only; follows the role)
                                  </label>
                                ) : (
                                  <label key={f} className="flex items-center gap-1">
                                    <input type="hidden" name="shown" value={f} />
                                    <input type="checkbox" name={f} defaultChecked={r.perms[f]} className="accent-navy-900" /> {INVITE_PERMISSION_LABEL[f]}
                                  </label>
                                ),
                              )}
                            </div>
                            <p className="mt-2 text-xs text-slate-600">
                              Business (bookkeeping) view: <strong>off</strong> — it is never part of an invitation.{" "}
                              {onBk ? "This client is on the Bookkeeping Clients list, so Tabitha can turn it on for this login after they accept." : "This client isn't on the Bookkeeping Clients list."}
                            </p>
                          </fieldset>
                          <div className="sm:col-span-2"><Button type="submit" variant="secondary">Save row</Button></div>
                        </ActionForm>
                      </details>
                      {r.flags.some((f) => f.code === "SHARED_EMAIL") && (
                        <ActionForm action={confirmSharedEmailAction.bind(null, batch.id, r.id)} confirm={`Confirm that ${r.email} belongs to ${r.inviteeName} on every record that uses it?`}>
                          <Button type="submit" variant="secondary">Same person — confirm shared email</Button>
                        </ActionForm>
                      )}
                      {owner && r.approvedAt && (
                        <ActionForm action={unapproveInviteRowAction.bind(null, batch.id, r.id)}>
                          <Button type="submit" variant="ghost">Remove approval</Button>
                        </ActionForm>
                      )}
                      <ActionForm action={removeInviteRowAction.bind(null, batch.id, r.id)} confirm={`Remove ${r.client.displayName} from this batch?`}>
                        <Button type="submit" variant="danger">Remove</Button>
                      </ActionForm>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="rounded-xl border border-navy-100 bg-white p-4 text-sm text-slate-600">This batch is empty. <Link className="underline" href="/clients/invitations">Add clients</Link>.</li>}
      </ul>
      <p className="mt-4 text-xs text-slate-600">
        “Sent” means the email provider accepted the email. “Delivered” or “Not delivered” appears only when Resend reports it. Each invitation link works once and expires in 7 days; the full history is on each client&apos;s Portal tab.
      </p>
    </>
  );
}
