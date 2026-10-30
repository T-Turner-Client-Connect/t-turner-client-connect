import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Field } from "@/components/ui";
import { confirmReminderReceivedAction, identityReminderTestAction } from "@/app/actions/identity";
import { identityReminderStatus } from "@/lib/services/identity";
import { emailProviderConfigured } from "@/lib/auth/client-auth";
import { twilioConfigured } from "@/lib/twilio";
import { fmtDateTime } from "@/lib/format";

/** Admin check that identity reminders really reach a phone or inbox before calling them active. */
export async function IdentityReminderPanel() {
  const st = await identityReminderStatus();
  const email = emailProviderConfigured();
  const sms = twilioConfigured();
  const active = st.enabled && ((email && st.emailConfirmedAt) || (sms && st.smsConfirmedAt));
  return (
    <Card title="Identity document reminders — delivery check" className="lg:col-span-2">
      <div className="space-y-3 text-sm" data-testid="identity-reminder-panel">
        <p>
          Status:{" "}
          {active ? <Badge tone="green">Active — delivery confirmed</Badge> : <Badge tone="amber">Not confirmed yet</Badge>}{" "}
          <span className="text-slate-600">Reminders are recorded either way; they are only called active after a test is received.</span>
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Client notices switched on (<code>NOTIFICATIONS_ENABLED=true</code> in Netlify): {st.enabled ? <Badge tone="green">On</Badge> : <Badge tone="red">Off</Badge>}</li>
          <li>Email provider (Resend): {email ? <Badge tone="green">Configured</Badge> : <Badge tone="gray">Not set up</Badge>} {st.emailConfirmedAt ? <Badge tone="green">Receipt confirmed {fmtDateTime(st.emailConfirmedAt)}</Badge> : <Badge tone="amber">Receipt not confirmed</Badge>}</li>
          <li>Texts (Twilio): {sms ? <Badge tone="green">Configured</Badge> : <Badge tone="gray">Not set up</Badge>} {st.smsConfirmedAt ? <Badge tone="green">Receipt confirmed {fmtDateTime(st.smsConfirmedAt)}</Badge> : <Badge tone="amber">Receipt not confirmed</Badge>}</li>
        </ul>
        <ActionForm action={identityReminderTestAction} className="flex flex-wrap items-end gap-2">
          <Field label="Send the real reminder notice to a portal login you can check" hint="Use your own test client login. The notice is generic: no names, document types or images.">
            <input className="input w-80" type="email" name="email" placeholder="you@example.com" required />
          </Field>
          <Button type="submit" variant="secondary">Send test reminder</Button>
        </ActionForm>
        <div className="flex flex-wrap gap-2">
          <ActionForm action={confirmReminderReceivedAction.bind(null, "EMAIL")}><Button type="submit" variant="ghost">I received the test email</Button></ActionForm>
          <ActionForm action={confirmReminderReceivedAction.bind(null, "SMS")}><Button type="submit" variant="ghost">I received the test text</Button></ActionForm>
        </div>
        {st.recent.length > 0 && (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th>When</th><th>To</th><th>Channel</th><th>Result</th></tr></thead>
            <tbody>
              {st.recent.map((n) => (
                <tr key={n.id} className="border-t border-navy-100">
                  <td className="py-1">{fmtDateTime(n.createdAt)}</td>
                  <td>{n.portalUser.email}</td>
                  <td>{n.channel === "EMAIL" ? "Email" : "Text"}</td>
                  <td>{n.status}{n.deliveryStatus && ` · ${n.deliveryStatus}`}{n.statusDetail && ` · ${n.statusDetail}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
