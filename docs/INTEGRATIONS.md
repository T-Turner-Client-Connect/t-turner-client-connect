# Integrations: what works now and what needs setup

| Area | Status in this build | What activates it |
|---|---|---|
| Database | Netlify Database, provisioned automatically | Nothing to paste — see DEPLOYMENT.md |
| Private file storage | Working (Netlify Blobs on Netlify, local folder in dev) | Automatic on Netlify |
| Staff + client sign-in, 2-step verification | Working | `APP_ENCRYPTION_KEY` |
| Portal messaging, documents, bookkeeping, requests | Working | — |
| Staff invitation email | Built and tested: branded email, resend, revoke, private copy-link fallback, statuses. Sends nothing until Resend is configured | `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` (verified domain), `RESEND_WEBHOOK_SECRET` — see below |
| Password-reset email | Admin-generated links work now; email delivery needs Resend | `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` |
| Portal notifications (email/text) | Recorded; delivered only when enabled | `NOTIFICATIONS_ENABLED=true` + Resend/Twilio |
| Campaign email/text sending | **Locked.** Drafts, audiences, previews and test sends (simulated without a provider) work | Resend + Twilio + `LIVE_SENDING_ENABLED=true` + the messaging stage |
| SMS consent, STOP/HELP, delivery receipts | Built: public consent page, per-phone consent ledger, signed Twilio webhooks | Twilio console webhook + Advanced Opt-Out — see SMS-PROGRAM.md |
| Malware scanning | **Quarantine enforced.** Every client document is blocked (no download, not shown to clients) until a scanner returns clean | `MALWARE_SCAN_PROVIDER` + scanner settings — see below |
| Jotform contracts | Links and in-portal embed work; completion confirmed by staff | `JOTFORM_API_KEY` + `JOTFORM_WEBHOOK_SECRET`, webhook `https://<site>/api/webhooks/jotform?secret=…`, hidden field `assignment_ref` on each form |
| Tax e-signatures | **Setup required.** Requests can be prepared; signed-outside-the-app copies can be recorded (clearly labelled) | A provider verified for the exact tax forms, IRS identity requirements, joint signers and record retention |
| TaxAct | **Staff-controlled CSV import** of e-file statuses (Clients → Imports → TaxAct) and of contact exports | See below |
| Social publishing | **Manual publishing.** Suggested drafts from approved topics (built-in, no AI cost), approval with flagged-claim verification, one in-site reminder per platform when due, Download / Copy caption & hashtags / Open platform, mark posted per platform (link optional) | Direct publishing needs Meta App Review / TikTok audit; analytics-based times need connected accounts; an AI writer (optional) needs an AI provider API key |
| Automations | Engine works; rules paused by default | `CRON_SECRET`, enable rules in Workflows → Automations |

## Malware scanning (quarantine)

Every uploaded client document (staff or client upload, onboarding files) is quarantined until a
configured scanner returns **clean**: nobody can download it, it doesn't appear in the client's portal,
and "publish" waits for the scan (the client is notified only then). Infected files are refused at upload,
or destroyed if a later scan finds them, keeping only the record. Quarantined files are re-scanned every
10 minutes and from Documents → "Scan quarantined files now". Documents → "Run scanner self-test" proves
the setup: the harmless EICAR test string must be caught and a clean file must pass.

Choose one (Netlify → Environment variables, Production):

| Option | Variables | Notes |
|---|---|---|
| **Self-hosted ClamAV (recommended)** | `MALWARE_SCAN_PROVIDER=clamav-rest`, `MALWARE_SCAN_URL=https://<your scanner>/api/v1/scan`, `MALWARE_SCAN_FIELD=FILES` (default), optional `MALWARE_SCAN_TOKEN` (secret) | Files never leave infrastructure you control. Run a ClamAV REST container (for example `benzino77/clamav-rest-api`) on a small always-on host with HTTPS and a token/IP restriction. |
| Cloudmersive Virus Scan API | `MALWARE_SCAN_PROVIDER=cloudmersive`, `CLOUDMERSIVE_API_KEY` (secret) | Hosted service; client files are sent to Cloudmersive for scanning — review their data-processing terms first. |
| Any service answering `{"clean": true/false}` | `MALWARE_SCAN_URL`, optional `MALWARE_SCAN_TOKEN` | Raw bytes in the request body. |

Never use VirusTotal or any service that shares uploaded files publicly.

**After deploying with quarantine:** documents uploaded before this change were never scanned, so they are
quarantined too until the scanner is connected and the 10-minute job (or "Scan now") passes them.

## Twilio texting

Netlify environment variables (Site configuration → Environment variables; scopes Functions + Builds; Production):

| Variable | Value | Secret |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Your Account SID (starts with AC) | yes |
| `TWILIO_AUTH_TOKEN` | Your Auth Token | yes |
| `TWILIO_MESSAGING_SERVICE_SID` | The Messaging Service SID (starts with MG) | no |
| `APP_URL` | The live site address, exactly as Twilio calls it, no trailing slash | no |
| `CRON_SECRET` | 32+ random characters (scheduled sends) | yes |
| `NOTIFICATIONS_ENABLED` | `true` to send client portal notices by email/text | no |
| `LIVE_SENDING_ENABLED` | leave `false` — bulk campaigns stay off | no |

`TWILIO_FROM_NUMBER` is not needed when the Messaging Service SID is set. Leave `SMS_KEYWORD_REPLIES`
unset so Twilio's Advanced Opt-Out sends the STOP/HELP replies (set HELP text in the Messaging Service).

Webhooks (Twilio Console → Messaging → Services → your service → Integration):
- Incoming messages: "Send a webhook", Request URL `<APP_URL>/api/webhooks/twilio/inbound`, HTTP **POST**.
- Delivery status: every text this app sends includes `StatusCallback=<APP_URL>/api/webhooks/twilio/status`
  automatically (HTTP POST). Optionally also enter it as the service's Delivery Status Callback.
- Both verify Twilio's X-Twilio-Signature against `APP_URL`; a mismatch is refused (403).

Staff alerts: Settings → Text messages: off by default; office phone (default +1 205-659-5448), Monday–Friday
8:00–17:00 Central. After-hours alerts wait for the next window, are combined, and are skipped if the
conversation was read or resolved. Client texts are held 8 p.m.–8 a.m. Central, require service-text
consent, and stop after STOP. **Controlled test**: Settings → Send test text → Twilio's delivery result and
the office phone's reply appear in the same panel.

## Sign-in verification

- **Staff**: password + authenticator app (6-digit code, never "sent" or resent), with 10 one-time
  recovery codes. A code is accepted once (replay-protected). Lost both? Another Admin resets it in
  Settings → Staff accounts. Sole Admin: **owner recovery** at `/staff/recover` needs the account password
  plus a one-time `STAFF_RECOVERY_CODE` (20+ random characters) you add in Netlify (secret, then
  redeploy, then delete it after use). Verification is never disabled globally.
- If an authenticator can't be read (the `APP_ENCRYPTION_KEY` changed after enrollment), the sign-in
  screen says so instead of failing; recovery codes still work. Never change `APP_ENCRYPTION_KEY` to fix sign-in.
- **Clients**: password + a 6-digit code emailed to their account address (no app). Codes expire in 10
  minutes, work once, allow 5 attempts, 60-second resend cooldown, 5 sends/hour. "Sent" is shown only
  after Resend accepts the email. Optional "Remember this device" for 30 days, revocable by the client
  (Account) and cleared by password reset or a staff reset.
- Client email codes stay **off** until: Resend is configured → an Admin sends a test code to themselves
  and enters it (Settings → Client sign-in) → an Admin turns them on. Until then clients use the
  authenticator app, so an email problem can't lock anyone out. Clients already using an authenticator
  can keep it as a backup or remove it in Account.
- Text-message codes are not used for sign-in.

## Staff invitation email (Resend)

Settings → *Invite a staff member* creates a single-use link (7 days, only its hash is stored) and emails it
to the address typed, from `EMAIL_FROM_ADDRESS`, with a **Create Your Staff Account** button. Staff
invitations are transactional: they never go through campaigns, client messaging, client portal
invitations or the marketing do-not-contact list, and are tagged `category=staff_invitation` in Resend.

| Status shown | Meaning |
|---|---|
| Invitation created | Saved, not emailed (email not configured). Use *Copy private link instead* or *Resend* later |
| Email accepted by provider | Resend returned an email id. **Not** proof of delivery |
| Delivered | A signed `email.delivered` webhook from Resend arrived — the only way to reach this status |
| Delivery failed | Resend refused/was unreachable, or a signed bounce/failed/complaint event arrived. The Admin sees the private link to share instead |
| Account activated | The invitee created the account; the link no longer works |
| Revoked / Replaced / Expired | The link no longer works. *Resend* and *Copy private link* each replace the link |

Duplicate protection: the form carries an idempotency key; one open invitation per address (enforced with a
database lock); only one request can claim a send; Resend receives `Idempotency-Key: staff-invite/<id>`;
resends within 60 seconds are refused.

Setup (nothing here goes in GitHub or chat):

1. **Resend → Domains → Add domain.** Use a subdomain of the firm's domain, e.g. `mail.<yourdomain>`.
   Add the DNS records Resend shows (DKIM `resend._domainkey` TXT, SPF `send` MX + TXT; DMARC TXT recommended)
   at your DNS host, then *Verify* until the domain reads **Verified**.
2. **Resend → API Keys → Create**, permission *Sending access*, domain = the verified domain.
3. **Resend → Webhooks → Add endpoint** `https://<site>/api/webhooks/resend` with events `email.delivered`,
   `email.bounced`, `email.failed`, `email.complained`; copy its signing secret (`whsec_…`).
4. **Netlify → Site configuration → Environment variables** (scopes: Functions + Builds; contexts: Production,
   and Deploy Previews only if previews should send): `RESEND_API_KEY` (secret), `RESEND_WEBHOOK_SECRET`
   (secret), `EMAIL_FROM_ADDRESS` e.g. `TTurner & Associates Group, LLC <invitations@mail.<yourdomain>>`,
   `APP_URL` = the live site address (links in the email use it). Redeploy.
5. Settings → Integrations shows *Email (Resend)* and *Email delivery confirmations* as Configured.

## TaxAct

Research (Oct 2026): TaxAct does not publish a public API for TaxAct Professional, and no integration
exists in this app. Supported file paths:

- **Client list**: Client Manager → File → Export Client(s) → CSV — import through *Import contacts*.
- **E-file status**: TaxAct Professional Reports → *E-file Details* (client, submit date, EFIN, e-file
  status…) → Excel icon → CSV — import through *Import TaxAct e-file statuses*.

What updates automatically: nothing. Each import is previewed, matched by **client ID + tax year +
return type + jurisdiction + filing type** (never by name), ambiguous rows go to staff review, older rows
never overwrite newer verified statuses, and nothing is published to clients until staff publish it.
"Needs more information" and other preparation statuses are managed by staff in the CRM.

To confirm: your exact TaxAct edition and year (e.g. *TaxAct Professional 1040 Edition 2025*, desktop or
online), and the column headers (headers only — no client rows) of an E-file Details CSV and, if
available, an acknowledgment export.

## Social media

- **Facebook Pages**: Meta app with `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`;
  App Review / Advanced Access and possibly Business Verification. Scheduling up to ~30 days ahead (feed).
- **Instagram**: Business or Creator account; Meta app with Instagram content-publishing permission and
  App Review; JPEG images (4:5–1.91:1, ≤ 8 MB) or MP4/MOV video; media must be at a public URL at publish
  time; per-account daily publishing cap. No text-only posts.
- **TikTok**: TikTok developer app with the Content Posting API; until TikTok audits the app, posts are
  private (SELF_ONLY) from private accounts, max 5 users/day. Native scheduling isn't documented.

Accounts are connected by an Admin through each platform's official authorization flow; tokens are stored
encrypted server-side. Until then posts are **Requires manual posting** at their scheduled time and only
become **Posted manually** when staff paste the live post link — never "Published".
