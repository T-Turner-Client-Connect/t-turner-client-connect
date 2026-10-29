import "server-only";

/**
 * Transactional email (password resets) through Resend's HTTP API.
 * Returns false when email isn't configured so callers can fall back to
 * showing an Admin-generated link.
 */
export async function sendTransactionalEmail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM_ADDRESS;
  if (!key || !from) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    // Status only — never log the recipient or message body.
    console.error(`Transactional email failed with HTTP ${res.status}`);
    return false;
  }
  return true;
}
