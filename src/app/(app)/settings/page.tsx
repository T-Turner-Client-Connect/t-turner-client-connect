import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field, LinkButton, Notice, PageHeader } from "@/components/ui";
import { addSuppressionAction, liftSuppressionAction } from "@/app/actions/clients";
import { inviteAction, privateInviteLinkAction, resendInviteAction, resetLinkAction, revokeInviteAction, updateStaffAction } from "@/app/actions/users";
import { identityAccessAction } from "@/app/actions/identity";
import { billingAccessAction } from "@/app/actions/bookkeeping-clients";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { IdentityReminderPanel } from "@/components/identity-reminder-panel";
import { inviteState, recentInvites, type InviteState } from "@/lib/services/staff-invitations";
import { VerifyEmailCard } from "@/components/verification";
import { clientEmailCodesAction, confirmVerifyEmailAction, sendVerifyEmailAction } from "@/app/actions/verification";
import { authSettings, clientEmailCodesActive, emailProviderConfigured } from "@/lib/auth/client-auth";
import { maskEmail } from "@/lib/services/mfa";
import { resetStaffMfaAction, retentionAction, sendTestTextAction, staffAlertSettingsAction } from "@/app/actions/workspace";
import { testResults } from "@/lib/services/staff-alerts";
import { twilioConfigured } from "@/lib/twilio";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { jotformStatus } from "@/lib/services/contracts";
import { signingProviderStatus } from "@/lib/services/signatures";
import { scanConfigured } from "@/lib/scan";
import { directPublishingStatus, PLATFORM_LABELS } from "@/lib/social/rules";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { appUrl, integrationStatus } from "@/lib/integrations";
import { storageDriverName } from "@/lib/storage";
import { formatPhone } from "@/lib/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Settings" };

const INVITE_STATUS: Record<InviteState, { label: string; tone: "green" | "gold" | "navy" | "red" | "gray"; detail: string }> = {
  CREATED: { label: "Invitation created", tone: "navy", detail: "Not emailed yet. Resend once email is set up, or copy a private link." },
  SENDING: { label: "Sending…", tone: "navy", detail: "Handing the email to the provider." },
  ACCEPTED: { label: "Email accepted by provider", tone: "gold", detail: "Resend accepted the email. Delivery isn't confirmed yet." },
  DELIVERED: { label: "Delivered", tone: "green", detail: "Resend confirmed delivery to their mail server." },
  FAILED: { label: "Delivery failed", tone: "red", detail: "The email didn't go out or bounced." },
  ACTIVATED: { label: "Account activated", tone: "green", detail: "They created their account. The link no longer works." },
  EXPIRED: { label: "Expired", tone: "gray", detail: "The 7-day link expired. Resend to send a new one." },
  REVOKED: { label: "Revoked", tone: "gray", detail: "The link no longer works." },
  REPLACED: { label: "Replaced", tone: "gray", detail: "A newer link replaced this one." },
};

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
  const isTabitha = await isReportApprover(user);
  const isAdmin = user.role === "ADMIN";
  const [staff, invites, suppressions, logs] = await Promise.all([
    prisma.user.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
    isAdmin ? recentInvites() : [],
    prisma.suppression.findMany({ where: { liftedAt: null }, orderBy: { createdAt: "desc" }, take: 200 }),
    isAdmin ? prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 75, include: { actor: { select: { name: true } } } }) : [],
  ]);
  const i = integrationStatus();
  const [consentSubs, unmatchedTexts] = await Promise.all([
    prisma.smsConsentSubmission.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.inboundSms.findMany({ where: { matchedClientId: null }, orderBy: { receivedAt: "desc" }, take: 25 }),
  ]);
  const consentClients = new Map(
    (await prisma.client.findMany({ where: { id: { in: consentSubs.flatMap((c) => c.matchedClientIds) } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]),
  );
  const retention = new Map((await prisma.retentionPolicy.findMany()).map((r) => [r.category, r.years]));
  const social = directPublishingStatus(new Set((await prisma.socialAccount.findMany({ where: { disconnectedAt: null } })).map((a) => a.platform)));

  return (
    <>
      <PageHeader title="Settings" actions={isAdmin ? <LinkButton href="#invite-staff" data-testid="add-staff-button">+ Add Staff / Invite Employee</LinkButton> : undefined} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Staff accounts" actions={isAdmin ? <LinkButton href="#invite-staff" variant="secondary">+ Invite Employee</LinkButton> : undefined}>
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
                    {s.role !== "ADMIN" && s.identityAccessAll && <Badge tone="amber">Licenses: all clients</Badge>}
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
                      {s.role !== "ADMIN" && (
                        <ActionForm
                          action={identityAccessAction.bind(null, s.id, !s.identityAccessAll)}
                          confirm={s.identityAccessAll ? undefined : `Let ${s.name} open driver's licenses for every client? Social Security cards and birth certificates stay Admin-only, and this does not open your Owner's Office.`}
                          className="rounded-lg bg-ivory-50 p-2 text-sm"
                        >
                          <p className="mb-1">
                            Driver&apos;s licenses: {s.identityAccessAll ? <strong>all clients</strong> : <>only clients assigned to {s.name.split(" ")[0]}</>}
                            <span className="block text-xs text-slate-600">Social Security cards and birth certificates are Admin-only. Never includes the Owner&apos;s Office.</span>
                          </p>
                          <Button type="submit" variant="ghost">{s.identityAccessAll ? "Limit to assigned clients" : "Allow for all clients"}</Button>
                        </ActionForm>
                      )}
                      {isTabitha && s.id !== user.id && (
                        <ActionForm
                          action={billingAccessAction.bind(null, s.id, !s.bookkeepingBillingAccess)}
                          confirm={s.bookkeepingBillingAccess ? undefined : `Let ${s.name} view and change bookkeeping billing (charges, Square references, recurring-charge authorizations)? This does not open your Owner's Office.`}
                          className="rounded-lg bg-ivory-50 p-2 text-sm"
                        >
                          <p className="mb-1">
                            Bookkeeping billing: {s.bookkeepingBillingAccess ? <strong>allowed</strong> : <>Tabitha only</>}
                            <span className="block text-xs text-slate-600">Payment methods stay in Square. Never includes the Owner&apos;s Office.</span>
                          </p>
                          <Button type="submit" variant="ghost">{s.bookkeepingBillingAccess ? "Remove billing access" : "Allow billing access"}</Button>
                        </ActionForm>
                      )}
                      <ActionForm action={resetLinkAction.bind(null, s.id)}>
                        <Button type="submit" variant="ghost">Create password reset link</Button>
                      </ActionForm>
                      {s.mfaEnabledAt && s.id !== user.id && (
                        <ActionForm action={resetStaffMfaAction.bind(null, s.id)} confirm="Reset two-step verification? Confirm their identity in person or by phone first.">
                          <Button type="submit" variant="ghost">Reset two-step verification (lost phone)</Button>
                        </ActionForm>
                      )}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <>
              <h3 id="invite-staff" className="mt-4 mb-2 scroll-mt-6 font-semibold">Add Staff / Invite Employee</h3>
              <p className="mb-2 text-xs text-slate-600">Staff accounts are invitation-only. They choose their own password from the emailed link and must set up two-step verification before they can sign in.</p>
              <ActionForm action={inviteAction} className="grid gap-3 sm:grid-cols-2" resetOnSuccess idempotent>
                <Field label="Name"><input className="input" name="name" required /></Field>
                <Field label="Email"><input className="input" type="email" name="email" required /></Field>
                <Field label="Role">
                  <select className="input" name="role" defaultValue="STAFF"><option value="STAFF">Staff</option><option value="ADMIN">Admin</option></select>
                </Field>
                <fieldset className="rounded-lg border border-ivory-200 p-2 text-sm sm:col-span-2">
                  <legend className="px-1 text-xs font-semibold">Permissions (Staff role; applied when they accept)</legend>
                  <label className="flex items-center gap-2"><input type="checkbox" name="grantIdentityAccessAll" /> Driver&apos;s licenses for all clients (otherwise only clients assigned to them). Social Security cards and birth certificates stay Admin-only.</label>
                  {isTabitha && <label className="flex items-center gap-2"><input type="checkbox" name="grantBillingAccess" /> Bookkeeping billing (charges, Square references, recurring-charge authorizations)</label>}
                  <span className="block text-xs text-slate-600">Never includes the Owner&apos;s Office. Bookkeeping client assignment stays Admin-only.</span>
                </fieldset>
                <div className="flex items-end"><Button type="submit">Send invitation</Button></div>
              </ActionForm>
              <p className="mt-2 text-xs text-slate-600">
                Sends a branded invitation email with a one-time “Create Your Staff Account” link (valid 7 days). Staff invitations are separate from client invitations and campaigns.
              </p>
              {invites.length > 0 && (
                <>
                  <h3 className="mt-4 mb-2 font-semibold">Staff invitations (last 30 days)</h3>
                  <ul className="space-y-2 text-sm" data-testid="staff-invites">
                    {invites.map((inv) => {
                      const state = inviteState(inv);
                      const meta = INVITE_STATUS[state];
                      const canResend = state !== "ACTIVATED" && state !== "REVOKED" && state !== "REPLACED";
                      const canRevoke = canResend && state !== "EXPIRED";
                      return (
                        // One "current" invitation per address keeps the same row (and its result, such as a new private link) across a resend.
                        <li key={inv.revokedAt || inv.acceptedAt ? inv.id : `current:${inv.email}`} className="rounded-lg bg-navy-50 px-3 py-2" data-invite-email={inv.email}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium">
                              {inv.name} ({inv.email}) · {inv.role === "ADMIN" ? "Admin" : "Staff"}{inv.grantIdentityAccessAll ? " · licenses: all clients" : ""}{inv.grantBillingAccess ? " · billing" : ""}
                            </span>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-slate-600">
                            {meta.detail} Created {fmtDateTime(inv.createdAt)} by {inv.invitedBy.name}
                            {inv.emailAcceptedAt && ` · accepted by provider ${fmtDateTime(inv.emailAcceptedAt)}`}
                            {inv.emailDeliveredAt && ` · delivered ${fmtDateTime(inv.emailDeliveredAt)}`}
                            {inv.acceptedAt && ` · activated ${fmtDateTime(inv.acceptedAt)}`}
                            {canRevoke && ` · expires ${fmtDate(inv.expiresAt)}`}
                            {inv.linkCopiedAt && " · private link given"}
                          </p>
                          {state === "FAILED" && inv.emailError && <p className="mt-1 text-xs font-medium text-red-800">{inv.emailError}</p>}
                          {state === "CREATED" && inv.emailError && <p className="mt-1 text-xs text-slate-700">{inv.emailError}</p>}
                          {canResend && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              <ActionForm action={resendInviteAction.bind(null, inv.id)} confirm={`Send ${inv.email} a new invitation email? Any earlier link stops working.`}>
                                <Button variant="ghost">Resend invitation</Button>
                              </ActionForm>
                              <ActionForm action={privateInviteLinkAction.bind(null, inv.id)} confirm="Create a new private link to share yourself? Any earlier link (including an emailed one) stops working.">
                                <Button variant="ghost">Copy private link instead</Button>
                              </ActionForm>
                              {canRevoke && (
                                <ActionForm action={revokeInviteAction.bind(null, inv.id)} confirm={`Revoke ${inv.name}'s invitation? The link stops working immediately.`}>
                                  <Button variant="ghost">Revoke</Button>
                                </ActionForm>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
          {!isAdmin && <p className="mt-3 text-sm text-slate-600">Only Admins can invite or change staff accounts.</p>}
        </Card>

        {isAdmin && (
          <Card title="Client sign-in">
            {await (async () => {
              const [auth, active, me] = await Promise.all([authSettings(), clientEmailCodesActive(), prisma.user.findUniqueOrThrow({ where: { id: user.id } })]);
              return (
                <div className="space-y-3 text-sm" data-testid="client-signin-card">
                  <p>
                    Clients now sign in with:{" "}
                    <Badge tone={active ? "green" : "navy"}>{active ? "Password + emailed code" : "Password + authenticator app"}</Badge>
                  </p>
                  <p className="text-slate-700">Staff always use an authenticator app and recovery codes. Emailed codes for clients turn on only after email delivery is proven.</p>
                  <ol className="list-decimal space-y-2 pl-5">
                    <li>Email set up (Resend): {emailProviderConfigured() ? <Badge tone="green">Configured</Badge> : <Badge tone="gray">Not set up</Badge>}</li>
                    <li>
                      Prove delivery: send yourself a test code and enter it.{" "}
                      {auth.emailDeliveryVerifiedAt ? <Badge tone="green">Delivery confirmed {fmtDateTime(auth.emailDeliveryVerifiedAt)}</Badge> : null}
                      <div className="mt-2">
                        <VerifyEmailCard
                          verified={!!auth.emailDeliveryVerifiedAt && !!me.emailVerifiedAt}
                          masked={maskEmail(me.email)}
                          emailReady={emailProviderConfigured()}
                          sendAction={sendVerifyEmailAction.bind(null, "staff")}
                          confirmAction={confirmVerifyEmailAction.bind(null, "staff")}
                        />
                      </div>
                    </li>
                    <li data-testid="signup-status">
                      Online client sign-up (Create Client Account page):{" "}
                      {emailProviderConfigured() && auth.emailDeliveryVerifiedAt ? (
                        <Badge tone="green">Open</Badge>
                      ) : (
                        <>
                          <Badge tone="amber">Closed — clients see “Online sign-up opens soon”</Badge>
                          <span className="block text-xs text-slate-600">
                            Opens automatically when {!emailProviderConfigured() ? "RESEND_API_KEY and EMAIL_FROM_ADDRESS are set in Netlify (then redeploy) and " : ""}email delivery is proven in step 2. Verification codes are never skipped.
                          </span>
                        </>
                      )}
                    </li>
                    <li>
                      Switch clients to emailed codes:{" "}
                      {auth.clientEmailCodes ? (
                        <ActionForm action={clientEmailCodesAction.bind(null, false)} className="inline-block"><Button variant="ghost">Turn off</Button></ActionForm>
                      ) : (
                        <ActionForm action={clientEmailCodesAction.bind(null, true)} className="inline-block" confirm="Switch clients to password + emailed code? Existing authenticator users can keep theirs as a backup.">
                          <Button variant="secondary">Turn on</Button>
                        </ActionForm>
                      )}
                    </li>
                  </ol>
                </div>
              );
            })()}
          </Card>
        )}

        <Card title="Integrations">
          <ul className="divide-y divide-navy-100">
            <Status ok={i.database} label="Database" detail="PostgreSQL via DATABASE_URL" />
            <Status ok label="File storage" detail={storageDriverName()} />
            <Status ok={i.appUrl} label="Site address" detail="APP_URL, used in invitation, reset and unsubscribe links" />
            <Status ok={i.email} label="Email (Resend)" detail="RESEND_API_KEY and EMAIL_FROM_ADDRESS (a verified sender). Staff invitations and password resets send once set; campaign email arrives in the next stage." />
            <Status ok={i.emailWebhook} label="Email delivery confirmations" detail={`RESEND_WEBHOOK_SECRET, from a Resend webhook pointed at ${appUrl()}/api/webhooks/resend (events: email.delivered, email.bounced, email.failed, email.complained). Without it invitations stop at “accepted by provider”.`} />
            <Status ok={i.twilio} label="Text messages (Twilio)" detail="TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and a Messaging Service SID or from-number. Used from the next stage." />
            <Status ok={(process.env.APP_ENCRYPTION_KEY?.length ?? 0) >= 32} label="Encryption key" detail="APP_ENCRYPTION_KEY protects two-step secrets and signs download links" />
            <Status ok={process.env.NOTIFICATIONS_ENABLED === "true"} label="Client portal notifications" detail="NOTIFICATIONS_ENABLED=true plus email/Twilio. Notices carry a sign-in link only." />
            <Status ok={scanConfigured()} label="Malware scanning" detail="MALWARE_SCAN_URL (e.g. a ClamAV REST service) for uploaded files" />
            <Status ok={jotformStatus().verifiedCompletion} label="Jotform" detail="JOTFORM_API_KEY + JOTFORM_WEBHOOK_SECRET for verified completion. Form links work without them." />
            <Status ok={false} label="Tax e-signatures" detail={`${signingProviderStatus().label}. Needs a provider verified for the specific tax forms, identity checks and joint signers.`} />
            <Status ok={false} label="TaxAct" detail="No public TaxAct API. E-file statuses arrive by staff import of TaxAct's E-file Details CSV (Clients → Imports)." />
            <Status ok={Boolean(process.env.CRON_SECRET)} label="Scheduled automations" detail="CRON_SECRET lets the hourly Netlify function run reminders" />
            {social.map((p) => <Status key={p.platform} ok={p.available} label={`${PLATFORM_LABELS[p.platform]} direct publishing`} detail={p.reason} />)}
            <li className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div>
                <p className="font-medium">Live sending</p>
                <p className="text-sm text-slate-600">Stays off until sign-in, permissions, providers and a verified test delivery are in place.</p>
              </div>
              <Badge tone="red">Off</Badge>
            </li>
          </ul>
        </Card>

        {isAdmin && (
          <Card title="Document retention" className="scroll-mt-6 lg:col-span-2">
            <span id="retention" />
            <p className="mb-3 text-sm text-slate-600">&ldquo;Identity document&rdquo; covers driver&apos;s licenses, birth certificates and Social Security cards. Sets a keep-until date on new documents. Nothing is deleted automatically — expired documents are listed on the Documents page for an Admin to review, and every deletion is logged with a reason.</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {(Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((cat) => (
                <ActionForm key={cat} action={retentionAction} className="space-y-2 rounded-xl border border-ivory-200 p-3">
                  <input type="hidden" name="category" value={cat} />
                  <Field label={CATEGORY_LABELS[cat]} hint="Years (blank = keep until deleted)"><input className="input" name="years" inputMode="numeric" defaultValue={retention.get(cat) ?? ""} /></Field>
                  <Button type="submit" variant="secondary">Save</Button>
                </ActionForm>
              ))}
            </div>
          </Card>
        )}

        {isAdmin && <IdentityReminderPanel />}

        <Card title="SMS consent & incoming texts" className="lg:col-span-2">
          {await (async () => {
            const t = await testResults();
            const configured = twilioConfigured();
            return (
              <div className="mb-4 space-y-3 rounded-lg bg-ivory-50 p-3 text-sm" data-testid="twilio-card">
                <p className="font-semibold">
                  Text messages (Twilio): {configured ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not set up</Badge>}{" "}
                  <span className="font-normal text-slate-600">Bulk campaign texting stays off (LIVE_SENDING_ENABLED).</span>
                </p>
                <div>
                  <p className="font-semibold">Webhook addresses — Twilio Console → Messaging → Services → your service → Integration</p>
                  <p>Incoming messages (&ldquo;Send a webhook&rdquo;, HTTP POST): <code className="break-all">{appUrl()}/api/webhooks/twilio/inbound</code></p>
                  <p>Delivery status (HTTP POST): <code className="break-all">{appUrl()}/api/webhooks/twilio/status</code> — included automatically with every text this app sends; you may also enter it as the service&apos;s Delivery Status Callback.</p>
                  <p className="text-xs text-slate-600">These must match the live site address exactly (APP_URL), or Twilio&apos;s signature check fails and the request is refused.</p>
                </div>
                {isAdmin && (
                  <>
                    <ActionForm action={staffAlertSettingsAction} className="grid gap-2 sm:grid-cols-4">
                      <label className="flex items-center gap-2 sm:col-span-4"><input type="checkbox" name="smsEnabled" defaultChecked={t.settings.smsEnabled} /> Text the office when a client sends a message or uploads a document (no contents)</label>
                      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="emailEnabled" defaultChecked={t.settings.emailEnabled} /> Also email a link-only summary to</label>
                      <Field label="Office email" className="sm:col-span-2"><input className="input" type="email" name="email" defaultValue={t.settings.email} /></Field>
                      <Field label="Office phone (receives alerts)"><input className="input" name="phone" defaultValue={formatPhone(t.settings.phone)} /></Field>
                      <Field label="Mon–Fri from (Central)"><input className="input" type="time" name="windowStart" defaultValue={t.settings.windowStart} /></Field>
                      <Field label="until"><input className="input" type="time" name="windowEnd" defaultValue={t.settings.windowEnd} /></Field>
                      <div className="flex items-end"><Button type="submit" variant="secondary">Save</Button></div>
                      <p className="text-xs text-slate-600 sm:col-span-4">After-hours alerts wait for the next weekday window; several become one text; ones already read or resolved are skipped. In-site notices are not limited by these hours.</p>
                    </ActionForm>
                    <div>
                      <p className="font-semibold">Controlled test</p>
                      <p className="mb-2 text-slate-700">Sends one text to {formatPhone(t.settings.phone)}: &ldquo;TTurner Client Connect test… Reply YES to confirm two-way texting.&rdquo; Results below come from Twilio, not from this page.</p>
                      <ActionForm action={sendTestTextAction}><Button type="submit" variant="secondary" disabled={!configured}>Send test text</Button></ActionForm>
                      {t.tests.length > 0 && (
                        <ul className="mt-2 space-y-1" data-testid="twilio-tests">
                          {t.tests.map((x) => (
                            <li key={x.id}>
                              {fmtDateTime(x.createdAt)} · {x.status === "FAILED" ? <Badge tone="red">Not accepted</Badge> : <Badge tone={x.deliveryStatus === "delivered" ? "green" : x.deliveryStatus === "undelivered" || x.deliveryStatus === "failed" ? "red" : "gold"}>{x.deliveryStatus === "delivered" ? "Delivered (Twilio confirmed)" : x.deliveryStatus ? `Twilio: ${x.deliveryStatus}` : "Waiting for Twilio"}</Badge>}
                              {x.statusDetail && <span className="ml-1 text-xs text-slate-600">{x.statusDetail}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {t.tests.length > 0 && (
                        <p className="mt-2">Replies from the office phone: {t.replies.length === 0 ? "none yet" : t.replies.map((r) => `“${r.body.slice(0, 40)}” at ${fmtDateTime(r.receivedAt)}`).join("; ")}</p>
                      )}
                    </div>
                  </>
                )}
                <p className="text-slate-600">Public consent page: <a className="underline" href="/sms-consent" target="_blank">{appUrl()}/sms-consent</a></p>
              </div>
            );
          })()}
          <h3 className="mb-2 font-semibold">Recent consent form submissions</h3>
          {consentSubs.length === 0 ? (
            <p className="mb-4 text-sm text-slate-600">None yet.</p>
          ) : (
            <ul className="mb-4 divide-y divide-ivory-200 text-sm">
              {consentSubs.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <strong>{c.name}</strong> · {formatPhone(c.phoneNormalized)} ·{" "}
                    {c.matchedClientIds.length ? c.matchedClientIds.map((id) => <a key={id} className="underline" href={`/clients/${id}`}>{consentClients.get(id) ?? "client"}</a>) : <span className="text-amber-800">No matching client — add this number to a client to link it</span>}
                  </span>
                  <span className="flex items-center gap-1">
                    <Badge tone={c.serviceOptIn ? "green" : "gray"}>Service {c.serviceOptIn ? "yes" : "no"}</Badge>
                    <Badge tone={c.marketingOptIn ? "green" : "gray"}>Marketing {c.marketingOptIn ? "yes" : "no"}</Badge>
                    <span className="text-xs text-slate-500">{fmtDateTime(c.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mb-2 font-semibold">Incoming texts not matched to a client</h3>
          {unmatchedTexts.length === 0 ? (
            <p className="text-sm text-slate-600">None.</p>
          ) : (
            <ul className="divide-y divide-ivory-200 text-sm">
              {unmatchedTexts.map((t) => (
                <li key={t.id} className="py-2">
                  <span className="font-semibold">{formatPhone(t.fromNormalized)}</span> {t.keyword && <Badge tone={t.keyword === "STOP" ? "red" : "gray"}>{t.keyword}</Badge>} · {fmtDateTime(t.receivedAt)}
                  <p className="text-slate-700">{t.body}</p>
                </li>
              ))}
            </ul>
          )}
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
