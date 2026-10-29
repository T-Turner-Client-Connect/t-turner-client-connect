import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { SMS_CONSENT_TEXT } from "@/lib/business";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { portalPrefsAction, removeAuthenticatorAction, revokeDeviceAction } from "@/app/actions/portal";
import { clientEmailCodesActive } from "@/lib/auth/client-auth";
import { maskEmail } from "@/lib/services/mfa";
import { fmtDateTime } from "@/lib/format";
import { requirePortalUser } from "@/lib/portal/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Account" };

export default async function PortalSettings() {
  const actor = await requirePortalUser();
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: actor.id } });
  const [emailCodes, devices] = await Promise.all([
    clientEmailCodesActive(),
    prisma.trustedDevice.findMany({ where: { portalUserId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <>
      <PageHeader title="Account" subtitle="Notification preferences and sign-in security." />
      <Card title="Notifications" className="max-w-xl">
        <p className="mb-3 text-sm text-slate-600">
          We&apos;ll let you know when there&apos;s a new message, document or request in your portal. Notices only contain a sign-in link — never your documents or account details.
          These are account notices, separate from any marketing preferences.
        </p>
        <ActionForm action={portalPrefsAction} className="space-y-3">
          <label className="flex items-center gap-2"><input type="checkbox" name="notifyByEmail" defaultChecked={user.notifyByEmail} className="size-4 accent-navy-900" /> Email me at {user.email}</label>
          <Field label="Mobile number for texts"><input className="input" type="tel" name="phone" defaultValue={user.phone ?? ""} /></Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="notifyBySms" defaultChecked={user.notifyBySms} className="mt-1 size-4 shrink-0 accent-navy-900" />
            <span>{SMS_CONSENT_TEXT.SERVICE}</span>
          </label>
          <p className="text-xs text-slate-600">
            Optional. See our <Link className="underline" href="/privacy-policy">Privacy Policy</Link> and <Link className="underline" href="/terms">Terms &amp; Conditions</Link>. Promotional texts are
            managed separately on the <Link className="underline" href="/sms-consent">SMS consent page</Link>.
          </p>
          <Button type="submit">Save</Button>
        </ActionForm>
      </Card>
      <Card title="Sign-in security" className="mt-4 max-w-xl">
        <p className="text-sm text-slate-700">
          {emailCodes
            ? `You sign in with your password and a one-time code emailed to ${maskEmail(user.email)}.`
            : "You sign in with your password and a code from your authenticator app."}
        </p>
        {emailCodes && user.mfaEnabledAt && (
          <ActionForm action={removeAuthenticatorAction} className="mt-3" confirm="Stop using your authenticator app? You'll get sign-in codes by email instead.">
            <p className="mb-2 text-sm text-slate-600">You also have an authenticator app set up. You can keep it as a backup or remove it.</p>
            <Button type="submit" variant="secondary">Remove authenticator app</Button>
          </ActionForm>
        )}
        <h3 className="mt-4 mb-1 font-semibold">Remembered devices</h3>
        {devices.length === 0 ? (
          <p className="text-sm text-slate-600">None. Choose &ldquo;Remember this device&rdquo; when entering an emailed code to skip it on that device for 30 days.</p>
        ) : (
          <ul className="divide-y divide-navy-100 text-sm" data-testid="trusted-devices">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{d.label} · added {fmtDateTime(d.createdAt)} · expires {fmtDateTime(d.expiresAt)}</span>
                <ActionForm action={revokeDeviceAction.bind(null, d.id)}><Button variant="ghost">Remove</Button></ActionForm>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-600">Changing your password removes all remembered devices.</p>
      </Card>
    </>
  );
}
