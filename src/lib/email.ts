import "server-only";

/**
 * Transactional email (password resets) through Resend's HTTP API.
 * Returns false when email isn't configured so callers can fall back to
 * showing an Admin-generated link.
 */
export async function sendTransactionalEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!key || !from) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
  });
  if (!res.ok) {
    // Status only — never log the recipient or message body.
    console.error(`Transactional email failed with HTTP ${res.status}`);
    return false;
  }
  return true;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Branded wrapper for account notices: a heading, one line, and a sign-in button. */
export function brandedNoticeHtml(heading: string, line: string, buttonLabel: string, url: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f8f4ea;font-family:Arial,Helvetica,sans-serif;color:#1c2333">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #efe8d8">
<tr><td style="background:#001452;padding:20px 28px;font-family:Georgia,serif;font-size:19px;letter-spacing:2px;color:#ffffff">TTURNER <span style="color:#d2a43f;font-size:13px;letter-spacing:3px">CLIENT CONNECT</span></td></tr>
<tr><td style="height:3px;background:#d2a43f"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-family:Georgia,serif;font-size:22px;color:#001452">${esc(heading)}</h1>
<p style="margin:0 0 22px;font-size:16px;line-height:1.55">${esc(line)}</p>
<a href="${esc(url)}" style="display:inline-block;background:#001452;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${esc(buttonLabel)}</a>
<p style="margin:22px 0 0;font-size:13px;color:#5b6475">For your privacy we never include documents, amounts or tax details in email. Sign in to view them securely.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #efe8d8;font-size:12px;color:#5b6475">T. Turner &amp; Associates, LLC</td></tr>
</table></td></tr></table></body></html>`;
}
