import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { recoveryAction } from "@/app/actions/account-recovery";
import type { Actor } from "@/lib/auth/actor";
import { accountAccessView, STATUS_LABELS } from "@/lib/services/account-recovery";
import { fmtDateTime } from "@/lib/format";

const ACTION_LABELS: Record<string, string> = {
  "portal.recovery.password_reset_emailed": "Password reset emailed",
  "portal.recovery.verification_code_sent": "Verification code sent",
  "portal.recovery.attempt_limit_reset": "Attempt limit reset",
  "portal.recovery.two_step_reset": "Two-step verification reset",
  "portal.recovery.sessions_revoked": "Sessions and devices revoked",
  "portal.recovery.private_recovery_link_created": "Private recovery link created",
  "portal.activation_resent_by_admin": "Activation link emailed",
  "portal.activation_resend_failed": "Activation email failed",
  "portal.activation_sent": "Activation link emailed (from queue)",
  "portal.activation_limit_reset": "Activation limit reset",
  "portal.private_activation_link_created": "Private activation link created",
};

/** Identity check fields required for sensitive steps. */
function VerifyFields() {
  return (
    <>
      <Field label="How you verified their identity"><input className="input w-72" name="note" placeholder="e.g. In person with photo ID" /></Field>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="verified" /> I verified this person directly (not by email or text)</label>
    </>
  );
}

/**
 * Admins only: status of each client portal login and the recovery actions.
 * Never shows passwords or codes. Staff accounts of the same person are separate and untouched.
 */
export async function AccountRecoveryPanel({ clientId, actor }: { clientId: string; actor: Actor }) {
  const v = await accountAccessView(actor, clientId);
  return (
    <div className="mb-4 rounded-xl border-2 border-navy-100 p-3" data-testid="account-recovery">
      <h3 className="mb-1 font-semibold">Account Access &amp; Recovery <Badge tone="navy">Admin only</Badge></h3>
      <p className="mb-2 text-xs text-slate-600">Passwords and codes are never shown. Links go to the client&apos;s own address, or — after you verify them directly — a single-use expiring link for private delivery. Every action is logged.</p>
      {v.logins.length === 0 && v.pending.length === 0 && <p className="text-sm">Portal: <Badge tone={STATUS_LABELS.NOT_ACTIVATED.tone}>{STATUS_LABELS.NOT_ACTIVATED.label}</Badge> — no login or open invitation yet. Use “Send activation link” below.</p>}
      {v.pending.map((i) => (
        <p key={i.id} className="text-sm" data-testid="not-activated">
          <strong>{i.email}</strong> <Badge tone={STATUS_LABELS.NOT_ACTIVATED.tone}>{STATUS_LABELS.NOT_ACTIVATED.label}</Badge> · invitation expires {fmtDateTime(i.expiresAt)}
          {i.sentByEmail && <> · email {i.emailStatus === "DELIVERED" ? "delivered" : i.emailStatus === "SENT" ? "sent (awaiting delivery report)" : i.emailStatus === "FAILED" ? `failed${i.emailError ? `: ${i.emailError}` : ""}` : "not sent"}</>}
          {!i.sentByEmail && " · private link (not emailed)"}
        </p>
      ))}
      {v.expired.length > 0 && <p className="text-xs text-slate-600">{v.expired.length} expired invitation{v.expired.length === 1 ? "" : "s"} — expired links no longer work; send a new one.</p>}
      <ul className="mt-2 space-y-3">
        {v.logins.map((l) => (
          <li key={l.id} className="rounded-lg bg-ivory-50 p-3 text-sm" data-login={l.email}>
            <p className="flex flex-wrap items-center gap-2">
              <strong>{l.name}</strong> · {l.email} {l.emailVerified ? <Badge tone="green">Email verified</Badge> : <Badge tone="amber">Email not verified</Badge>}
              <Badge tone={STATUS_LABELS[l.status].tone} data-testid="login-status">{STATUS_LABELS[l.status].label}</Badge>
              {l.alsoStaff && <Badge tone="gold">Also has a separate staff login — not affected here</Badge>}
            </p>
            <p className="text-xs text-slate-600">
              Phone {l.phone ?? "not on file"} · two-step {l.mfaEnrolled ? "set up" : "not set up"} · last sign-in {l.lastLoginAt ? fmtDateTime(l.lastLoginAt) : "never"} · {l.sessions} session{l.sessions === 1 ? "" : "s"}, {l.devices} remembered device{l.devices === 1 ? "" : "s"}{l.failures ? ` · ${l.failures} failed sign-in${l.failures === 1 ? "" : "s"} in the last 15 minutes` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <ActionForm action={recoveryAction.bind(null, clientId, l.id, "reset_email")} confirm={`Email a password-reset link to ${l.email}?`}><Button type="submit" variant="secondary">Send Password Reset</Button></ActionForm>
              {!l.emailVerified && <ActionForm action={recoveryAction.bind(null, clientId, l.id, "verify_code")} confirm={`Email a new verification code to ${l.email}?`}><Button type="submit" variant="ghost">Resend Email Verification Code</Button></ActionForm>}
              <ActionForm action={recoveryAction.bind(null, clientId, l.id, "sessions")} confirm="Sign this login out everywhere and forget its remembered devices?"><Button type="submit" variant="ghost">Revoke Sessions / Remembered Devices</Button></ActionForm>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm underline">Sensitive recovery (identity verification required)</summary>
              <div className="mt-2 grid gap-3">
                <ActionForm action={recoveryAction.bind(null, clientId, l.id, "limit")} confirm={`Clear failed attempts for ${l.email} only?`} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="email" value={l.email} />
                  <VerifyFields />
                  <Button type="submit" variant="secondary">Reset This Client&apos;s Attempt Limit</Button>
                </ActionForm>
                <ActionForm action={recoveryAction.bind(null, clientId, l.id, "two_step")} confirm="Reset two-step verification and sign them out everywhere?" className="flex flex-wrap items-end gap-2">
                  <VerifyFields />
                  <Button type="submit" variant="secondary">Reset Client Two-Step Verification</Button>
                </ActionForm>
                <ActionForm action={recoveryAction.bind(null, clientId, l.id, "private_link")} confirm="Create a single-use recovery link to give them privately?" className="flex flex-wrap items-end gap-2">
                  <VerifyFields />
                  <Button type="submit" variant="secondary">Create Private Recovery Link</Button>
                </ActionForm>
              </div>
            </details>
          </li>
        ))}
      </ul>
      {v.recent.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm underline">Recovery history ({v.recent.length})</summary>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-700" data-testid="recovery-history">
            {v.recent.map((r) => {
              const d = (r.details ?? {}) as { to?: string; email?: string; ok?: boolean; error?: string; note?: string };
              return (
                <li key={r.id}>
                  {fmtDateTime(r.createdAt)} · {r.actor?.name ?? "System"} · {ACTION_LABELS[r.action] ?? r.action}
                  {(d.to || d.email) && ` · ${d.to ?? d.email}`}{d.ok === false && ` · failed${d.error ? `: ${d.error}` : ""}`}{d.note && ` · verified: ${d.note}`}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
