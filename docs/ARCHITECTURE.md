# Architecture & implementation plan

## Stack (Netlify-compatible)

- **Next.js 16 (App Router, Server Components, Server Actions)** on Netlify's Next.js Runtime.
- **Netlify Database (managed Postgres) + Prisma** — provisioned by Netlify; migrations in
  `netlify/database/migrations/` are applied by Netlify on deploy (previews run on forked branches).
- **Authentication**: built in, not a third-party service. Separate identities for staff (`User`) and clients
  (`PortalUser`), separate session tables and cookies, bcrypt passwords, TOTP two-step verification
  (required for both), DB-backed sessions with idle and absolute expiry, single-use invite/reset tokens.
- **Authorization**: enforced on the server in every page, Server Action and API route
  (`requireUser`, `requirePortalUser`, `requireClientAccess`). `src/proxy.ts` only redirects visitors
  without a cookie — it is not the security boundary.
- **Storage**: Netlify Blobs, two private stores — `client-connect-documents` (client/tax documents) and
  `client-connect-files` (marketing media, consent evidence). Files are only served through authenticated
  routes; client documents use expiring, viewer-bound signed links re-checked on every download.
- **Queue / scheduling**: Postgres-backed outbox tables (`Notification`, `AutomationRun`, and the
  campaign queue in the messaging stage) with unique idempotency keys, processed by an hourly Netlify
  scheduled function (`netlify/functions/automations-cron.mts`).

## Data model (prisma/schema.prisma)

| Area | Models |
|---|---|
| Staff access | User, Session, Invite, PasswordResetToken, LoginAttempt, MfaRecoveryCode |
| Client access | PortalUser, PortalAccess (per-client grants & permissions), PortalInvite, PortalSession, PortalResetToken |
| CRM | Client, Contact, Group, ClientGroup, ClientNote, Task, Appointment, AuditLog |
| Consent | ConsentRecord (history; 7216 needs Admin + signed evidence), Suppression (address-level opt-outs) |
| Imports | ImportBatch/ImportRow (contacts), TaxImportBatch/TaxImportRow (e-file statuses) |
| Conversations | Conversation, Message (PORTAL / EMAIL / SMS / INTERNAL_NOTE), Notification |
| Documents | StoredFile, Document (category, year/month, visibility, scan status, retention, audited deletion), DocumentAccessLog, RetentionPolicy |
| Bookkeeping | BookkeepingPeriod (monthly workspace), DocumentRequest (checklist), Announcement(+Group), ClientDeadline |
| Tax | FilingRecord (client × year × return type × jurisdiction × filing type; separate prep and filing status; amendment outcome), FilingStatusEvent (history with source/evidence) |
| Signatures & contracts | SignatureRequest, SignatureSigner, ContractAssignment (Jotform) |
| Campaigns | Campaign, CampaignGroup, CampaignInclusion, CampaignExclusion |
| Social | SocialPost, SocialPostTarget (per platform), SocialAccount (encrypted tokens) |
| Workflows | PipelineStage, PipelineCard (prospects), AutomationRule, AutomationRun |

## Key rules

- Archiving never deletes history. Campaign exclusions never touch groups or the client record.
- Imports never grant consent, never send, and never keep the raw file.
- Consent and suppressions are checked server-side at preview and again right before sending.
- Portal users only see records granted through `PortalAccess`; authorized contacts don't see tax
  documents unless permitted. Internal notes are never returned to the portal.
- "Accepted" requires an acknowledgment or documented staff verification; federal and state filings are
  separate records; older imports never overwrite newer verified statuses; tax updates never touch
  campaigns.
- Social posts are only "Published" from a platform API response; manual posts need the live link.

## Stages

1. **Done — CRM foundation**: staff auth, clients, imports, consent, campaign drafts, media library.
2. **Done — Portal & workspace foundation (this PR)**: client portal with MFA, secure messaging,
   documents, bookkeeping, requests, tax workspace + TaxAct CSV import, contracts, signature
   setup-required flow, conversations, workflows & automations engine, social media (manual publishing),
   reports, calendar, deployment hardening.
3. **Next — Live messaging**: Resend + Twilio sending queue with delivery/bounce/STOP webhooks
   (signature-verified), campaign send & schedule with rate limits, inbound SMS into Conversations,
   public consent collection page (after legal review).
4. **Then — Provider integrations**: Jotform webhook verification in production, malware scanning
   service, verified e-signature provider, social direct publishing after platform approvals,
   direct-to-storage large uploads.
