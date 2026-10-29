# My Tax Center, Retrieve Tax Filings, and Tax Countdowns

## What clients see
- **Home** is kept simple: a navy and gold welcome banner showing the next deadline that applies to the client, then link tiles: My Tax Center, Retrieve Tax Filings, Document Vault, Messages, Document Requests, Invoices & Payments, News & Tax Countdowns, Resource Center, Contracts & Signatures, Refer a Friend (plus Bookkeeping when a report is ready). Badges show counts such as unread messages and open requests.
- **My Tax Center** (`/client/tax-center`) has three steps (questionnaire by year, upload documents, retrieve tax filings) and the progress for each tax year.
- **News & Tax Countdowns** (`/client/news`) has the countdown cards and the announcements.
- **Refer a Friend** (`/client/referrals`) has a short form that sends a secure message to the office.

## Separate statuses
Each tax year tracks five steps independently:
1. Questionnaire
2. Documents (staff set *Not started*, *Some received* or *All received*)
3. Return preparation
4. Filing
5. Agency acceptance

Preparation, filing and acceptance come from the filing records on the client's **Taxes** tab. A questionnaire or an upload never marks a return prepared, filed or accepted. Staff can add an estimated completion date and a note.

## Questionnaires (Jotform)
- Set form IDs in **News & Countdowns → Tax questionnaires**. Paste the numeric form ID or the `https://form.jotform.com/<id>` link exactly as Jotform shows it.
- Slots for 2022–2026 exist with no form ID, so clients see "not available yet". Add more years or separate Individual/Business forms there.
- **Each questionnaire form needs a hidden field named `assignment_ref`.** The portal pre-fills it with a signed reference for the client and year.
- With `JOTFORM_API_KEY` and `JOTFORM_WEBHOOK_SECRET` set, add the webhook `https://<site>/api/webhooks/jotform?secret=<JOTFORM_WEBHOOK_SECRET>` to each questionnaire form. When a submission arrives:
  - It is re-read from the Jotform API.
  - It is filed to that client and year.
  - Its answers are stored encrypted (staff only).
  - Its uploaded files are saved to the client's vault for that year, marked Needs Review.
- **Existing submissions:** on the client's Taxes tab, use *Link an existing Jotform questionnaire*.
  - If the submission's email matches the client, it links directly.
  - Otherwise staff must tick the confirmation and say how they verified the match.
  - A submission can belong to only one client.
  - Without the API key, staff can still record the link (marked "Jotform not connected"), but answers and files can't be read.

## Uploads and the vault
- Clients must choose the year (or "Not sure") and the kind of document.
- Staff tax uploads require the year and a tax document type: federal, state or amended return, acknowledgment, and so on.
- The same file (by SHA-256 of its content) is stored only once per client.
- Every file stays quarantined until the malware scan passes.
- Staff-only drafts never reach the portal.
- Upload, link, publish, view and download are each recorded with who did it.

## Retrieve Tax Filings
- Shows only records staff uploaded **and published** to the account, by year, grouped as federal, state, amended and related. Clients can preview, download or print them.
- Nothing is pulled from TaxAct or the IRS.
- A year with no records offers **Request a Copy**. This creates one open staff task per year and a portal message to the office.
- **Verification:** past-year records (our uploads from before last tax year) open only when the login is verified, in one of two ways:
  - an invitation link delivered by email, or an emailed code (needs Resend); or
  - **staff confirming identity** on the client's Portal tab, with a note.

  This is enforced on the server and in the download link check.

## Tax countdowns
- Clients see only dates an Admin saved with an official https source. Saving stamps the date as reviewed by that Admin today.
- The 2026-return dates were seeded from IRS Publication 509, the Form 4868 draft and the Alabama Department of Revenue (checked Oct 29, 2026). They're labeled "initial research — please confirm" until you mark them reviewed.
- **Tax season opening:** shows "Opening date awaiting IRS announcement" until you add the date the IRS announces, usually in early January.
- **Moving forward:** once a date passes, its card moves to the next reviewed date. If none is saved yet, the card says the date isn't published yet; it never shows a negative count. The deadline day itself shows "Due today".
- **Suggested dates:** next year's dates are calculated from IRS rules, including weekend and DC-holiday rollover, and listed for review on the News & Countdowns page.
- **Disaster relief:** add an IRS date with "Disaster relief for one state" and a note. It replaces the general date only for clients in that state.
- **Personalization:** set the entity type and tax year end on the client's Taxes tab.
  - Cards marked "Applies to you" are the client's own.
  - Fiscal-year businesses get a separate date labeled *calculated*.
  - An extension shows as confirmed only when a federal **extension** filing is recorded as **Accepted**. Otherwise the card says it applies only if a valid extension is filed.
- Every extension card says: *An extension to file generally does not extend the time to pay.*

## Announcements
- Admins create, edit, pin, schedule (start time) and end announcements, choosing the audience: all clients, individuals, businesses or bookkeeping clients. Times are Central.
- Publishing never sends a text or email.
