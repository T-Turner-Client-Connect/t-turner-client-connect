import "server-only";
import { enrollmentStatus, type MfaSubject } from "@/lib/services/mfa";
import { fmtChicago } from "@/lib/tz";
import type { Diagnostics } from "@/components/verification";

/** States only — never secrets — for the "Having trouble signing in?" panel. */
export async function signInDiagnostics(subject: MfaSubject): Promise<Diagnostics> {
  const s = await enrollmentStatus(subject);
  return {
    enrolledAt: s?.enrolledAt ? fmtChicago(s.enrolledAt, { month: "short", day: "numeric", year: "numeric" }) : null,
    authenticatorReadable: s?.authenticatorReadable ?? false,
    recoveryCodesRemaining: s?.recoveryCodesRemaining ?? 0,
    emailAvailable: !!s?.email.available,
    emailReason: s?.email.reason ?? null,
    maskedEmail: s?.email.available && "masked" in s.email ? (s.email.masked ?? null) : null,
    officeTime: `${fmtChicago(new Date(), { hour: "numeric", minute: "2-digit", second: "2-digit" })} Central`,
  };
}
