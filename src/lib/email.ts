import "server-only";

export type EmailResult = { ok: true; providerId: string | null } | { ok: false; reason: "not_configured" | "rejected" | "network"; detail: string };

/**
 * Transactional email (account notices) through Resend's HTTP API. The
 * idempotency key makes Resend drop a repeat of the same send for 24 hours;
 * tags label the email's category in the Resend dashboard and webhooks.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey?: string;
  tags?: Record<string, string>;
}): Promise<EmailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!key || !from) return { ok: false, reason: "not_configured", detail: "Email isn't set up yet (RESEND_API_KEY and EMAIL_FROM_ADDRESS)." };
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.tags ? { tags: Object.entries(input.tags).map(([name, value]) => ({ name, value })) } : {}),
      }),
    });
  } catch {
    console.error("Transactional email failed: network error");
    return { ok: false, reason: "network", detail: "Couldn't reach the email provider." };
  }
  if (!res.ok) {
    // Status and the provider's short message only — never the recipient or body.
    let message = "";
    try {
      message = String(((await res.json()) as { message?: unknown }).message ?? "").slice(0, 200);
    } catch {}
    console.error(`Transactional email failed with HTTP ${res.status}`);
    return { ok: false, reason: "rejected", detail: `The email provider refused the message (HTTP ${res.status}${message ? `: ${message}` : ""}).` };
  }
  let providerId: string | null = null;
  try {
    providerId = String(((await res.json()) as { id?: unknown }).id ?? "") || null;
  } catch {}
  return { ok: true, providerId };
}

/** Returns false when email isn't configured or fails, so callers can fall back to an Admin-generated link. */
export async function sendTransactionalEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  return (await sendEmail({ to, subject, text, html })).ok;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Branded wrapper for account notices: a heading, one line, and a sign-in button. */
export function brandedNoticeHtml(heading: string, line: string, buttonLabel: string, url: string): string {
  return brandedEmailHtml({
    heading,
    paragraphs: [line],
    button: { label: buttonLabel, url },
    note: "For your privacy we never include documents, amounts or tax details in email. Sign in to view them securely.",
  });
}

export function brandedEmailHtml(input: { heading: string; paragraphs: string[]; button: { label: string; url: string }; note?: string; footer?: string }): string {
  const { heading, paragraphs, button, note, footer = "T. Turner & Associates, LLC" } = input;
  return `<!doctype html><html><body style="margin:0;background:#f8f4ea;font-family:Arial,Helvetica,sans-serif;color:#1c2333">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #efe8d8">
<tr><td style="background:#001452;padding:20px 28px;font-family:Georgia,serif;font-size:19px;letter-spacing:2px;color:#ffffff">TTURNER <span style="color:#d2a43f;font-size:13px;letter-spacing:3px">CLIENT CONNECT</span></td></tr>
<tr><td style="height:3px;background:#d2a43f"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:22px;color:#001452">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55">${esc(p)}</p>`).join("\n")}
<p style="margin:22px 0 0"><a href="${esc(button.url)}" style="display:inline-block;background:#001452;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${esc(button.label)}</a></p>
${note ? `<p style="margin:22px 0 0;font-size:13px;color:#5b6475">${esc(note)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #efe8d8;font-size:12px;color:#5b6475">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}
