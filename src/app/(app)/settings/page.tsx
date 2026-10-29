import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { addSuppressionAction, liftSuppressionAction } from "@/app/actions/clients";
import { inviteAction, resetLinkAction, revokeInviteAction, updateStaffAction } from "@/app/actions/users";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { integrationStatus } from "@/lib/integrations";
import { storageDriverName } from "@/lib/storage";
import { formatPhone } from "@/lib/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Settings" };

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-slate-600">{detail}</p>
      </div>
      <Badge tone={ok ? "green" : "gray"}>{ok ? "Configured" : "Not set up"}</Badge>
    </li>
  );
}

export default async function SettingsPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const [staff, invites, suppressions, logs] = await Promise.all([
    prisma.user.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    isAdmin ? prisma.invite.findMany({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }) : [],
    prisma.suppression.findMany({ where: { liftedAt: null }, orderBy: { createdAt: "desc" }, take: 200 }),
    isAdmin ? prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 75, include: { actor: { select: { name: true } } } }) : [],
  ]);
  const i = integrationStatus();

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Staff accounts">
          <ul className="divide-y divide-navy-100">
            {staff.map((s) => (
              <li key={s.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">{s.name} {s.id === user.id && <span className="text-sm font-normal text-slate-600">(you)</span>}</p>
                    <p className="text-sm text-slate-600">{s.email} · last sign-in {s.lastLoginAt ? fmtDateTime(s.lastLoginAt) : "never"}</p>
                  </div>
                  <div className="flex gap-1">
                    <Badge tone={s.role === "ADMIN" ? "gold" : "navy"}>{s.role === "ADMIN" ? "Admin" : "Staff"}</Badge>
                    {!s.active && <Badge tone="red">Deactivated</Badge>}
                  </div>
                </div>
                {isAdmin && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm underline">Manage</summary>
                    <div className="mt-2 space-y-3">
                      <ActionForm action={updateStaffAction.bind(null, s.id)} className="flex flex-wrap items-end gap-2">
                        <Field label="Role">
                          <select className="input" name="role" defaultValue={s.role}><option value="STAFF">Staff</option><option value="ADMIN">Admin</option></select>
                        </Field>
                        <Field label="Access">
                          <select className="input" name="active" defaultValue={String(s.active)}><option value="true">Active</option><option value="false">Deactivated</option></select>
                        </Field>
                        <Button type="submit" variant="secondary">Save</Button>
                      </ActionForm>
                      <ActionForm action={resetLinkAction.bind(null, s.id)}>
                        <Button type="submit" variant="ghost">Create password reset link</Button>
                      </ActionForm>
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <>
              <h3 className="mt-4 mb-2 font-semibold">Invite a staff member</h3>
              <ActionForm action={inviteAction} className="grid gap-3 sm:grid-cols-2" resetOnSuccess>
                <Field label="Name"><input className="input" name="name" required /></Field>
                <Field label="Email"><input className="input" type="email" name="email" required /></Field>
                <Field label="Role">
                  <select className="input" name="role" defaultValue="STAFF"><option value="STAFF">Staff</option><option value="ADMIN">Admin</option></select>
                </Field>
                <div className="flex items-end"><Button type="submit">Create invitation</Button></div>
              </ActionForm>
              {invites.length > 0 && (
                <ul className="mt-3 space-y-2 text-sm">
                  {invites.map((inv) => (
                    <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-navy-50 px-3 py-2">
                      <span>Pending: {inv.name} ({inv.email}) · expires {fmtDate(inv.expiresAt)}</span>
                      <ActionForm action={revokeInviteAction.bind(null, inv.id)}><Button variant="ghost">Revoke</Button></ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {!isAdmin && <p className="mt-3 text-sm text-slate-600">Only Admins can invite or change staff accounts.</p>}
        </Card>

        <Card title="Integrations">
          <ul className="divide-y divide-navy-100">
            <Status ok={i.database} label="Database" detail="PostgreSQL via DATABASE_URL" />
            <Status ok label="File storage" detail={storageDriverName()} />
            <Status ok={i.appUrl} label="Site address" detail="APP_URL, used in invitation, reset and unsubscribe links" />
            <Status ok={i.email} label="Email (Resend)" detail="RESEND_API_KEY and EMAIL_FROM_ADDRESS. Password-reset emails work once set; campaign email arrives in the next stage." />
            <Status ok={i.twilio} label="Text messages (Twilio)" detail="TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and a Messaging Service SID or from-number. Used from the next stage." />
            <li className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div>
                <p className="font-medium">Live sending</p>
                <p className="text-sm text-slate-600">Stays off until sign-in, permissions, providers and a verified test delivery are in place.</p>
              </div>
              <Badge tone="red">Off</Badge>
            </li>
          </ul>
        </Card>

        <Card title="Do-not-contact list" className="lg:col-span-2">
          <p className="mb-3 text-sm text-slate-600">
            Opt-outs apply to the email address or phone number everywhere in the CRM, including future imports. Anyone can add one; only an Admin can lift one, with a reason.
          </p>
          <ActionForm action={addSuppressionAction} className="mb-4 grid gap-3 sm:grid-cols-5" resetOnSuccess>
            <Field label="Channel">
              <select className="input" name="channel"><option value="SMS">Text</option><option value="EMAIL">Email</option></select>
            </Field>
            <Field label="Phone or email" className="sm:col-span-2"><input className="input" name="address" required /></Field>
            <Field label="Reason">
              <select className="input" name="reason" defaultValue="MANUAL">
                <option value="MANUAL">Asked not to be contacted</option>
                <option value="STOP">Replied STOP</option>
                <option value="UNSUBSCRIBE">Unsubscribed (promotions)</option>
              </select>
            </Field>
            <div className="flex items-end"><Button type="submit">Add</Button></div>
          </ActionForm>
          {suppressions.length === 0 ? (
            <p className="text-sm text-slate-600">No opt-outs recorded.</p>
          ) : (
            <ul className="divide-y divide-navy-100 text-sm">
              {suppressions.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <Badge tone="navy">{s.channel === "SMS" ? "Text" : "Email"}</Badge>{" "}
                    {s.channel === "SMS" ? formatPhone(s.addressNormalized) : s.addressNormalized} · {s.reason.toLowerCase()} · {fmtDate(s.createdAt)}
                  </span>
                  {isAdmin && (
                    <details>
                      <summary className="cursor-pointer underline">Lift</summary>
                      <ActionForm action={liftSuppressionAction.bind(null, s.id)} className="mt-2 flex flex-wrap gap-2">
                        <input className="input w-64" name="note" placeholder="Why? e.g. Texted START on 3/2" required />
                        <Button type="submit" variant="danger">Lift opt-out</Button>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {isAdmin && (
          <Card title="Audit history" className="lg:col-span-2">
            <p className="mb-2 text-sm text-slate-600">Most recent 75 events: imports, contact and permission changes, campaign edits, and account activity.</p>
            <ul className="divide-y divide-navy-100 text-sm">
              {logs.map((l) => (
                <li key={l.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span><code className="text-navy-800">{l.action}</code> · {l.entityType}{l.clientId && <> · <a className="underline" href={`/clients/${l.clientId}`}>client</a></>}</span>
                  <span className="text-slate-600">{l.actor?.name ?? "system"} · {fmtDateTime(l.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {!i.email && isAdmin && (
        <div className="mt-4"><Notice>Until email is configured, password resets work through Admin-created links (Staff accounts → Manage).</Notice></div>
      )}
    </>
  );
}
