# Integrations: what works now and what needs setup

| Area | Status in this build | What activates it |
|---|---|---|
| Database | Netlify Database, provisioned automatically | Nothing to paste — see DEPLOYMENT.md |
| Private file storage | Working (Netlify Blobs on Netlify, local folder in dev) | Automatic on Netlify |
| Staff + client sign-in, 2-step verification | Working | `APP_ENCRYPTION_KEY` |
| Portal messaging, documents, bookkeeping, requests | Working | — |
| Password-reset email | Admin-generated links work now; email delivery needs Resend | `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` |
| Portal notifications (email/text) | Recorded; delivered only when enabled | `NOTIFICATIONS_ENABLED=true` + Resend/Twilio |
| Campaign email/text sending | **Locked.** Drafts, audiences, previews and test sends (simulated without a provider) work | Resend + Twilio + `LIVE_SENDING_ENABLED=true` + the messaging stage |
| Two-way texting / delivery receipts | Next stage | Twilio webhooks |
| Malware scanning | Setup required (files are type-checked; marked "Not scanned") | `MALWARE_SCAN_URL` |
| Jotform contracts | Links and in-portal embed work; completion confirmed by staff | `JOTFORM_API_KEY` + `JOTFORM_WEBHOOK_SECRET`, webhook `https://<site>/api/webhooks/jotform?secret=…`, hidden field `assignment_ref` on each form |
| Tax e-signatures | **Setup required.** Requests can be prepared; signed-outside-the-app copies can be recorded (clearly labelled) | A provider verified for the exact tax forms, IRS identity requirements, joint signers and record retention |
| TaxAct | **Staff-controlled CSV import** of e-file statuses (Clients → Imports → TaxAct) and of contact exports | See below |
| Social publishing | **Manual publishing** with media download, copy caption, open platform, confirm with post link | See below |
| Automations | Engine works; rules paused by default | `CRON_SECRET`, enable rules in Workflows → Automations |

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
