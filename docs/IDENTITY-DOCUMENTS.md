# Identity Documents

A permanent section of each client's vault, kept separate from the yearly tax folders. It holds driver's licenses, birth certificates and Social Security cards for the client, their spouse and each dependent.

## Where it lives
- **Client portal:**
  - **Identity Documents** in the sidebar, the card at the top of the Document Vault, and the link on the Overview's vault card.
  - Reminders appear on the Overview and on the Identity Documents page.
  - My Tax Center lists what's on file.
- **Staff:**
  - **Identity Documents** card at the top of the client's Documents tab (`#identity`).
  - The Documents hub shows which clients have uploads pending verification.
  - The Taxes tab shows the on-file checklist.

## Rules
- **Every new upload is Pending Verification** until a staff member verifies it after checking the image. A pending replacement never replaces the current verified document until it is verified; then the previous one is marked Replaced. Each document's history is kept, and the current verified one is labeled.
- **Driver's license:**
  - The expiration date is required. Staff confirm it when verifying, and an expired license can't be verified.
  - Reminders go out at **60, 30 and 7 days**, each once, only if no replacement is pending; then the license is marked **Expired**.
  - A late upload gets one reminder, not several.
  - Replace it with **Upload Updated License** (renewal, name or address change, correction, unreadable copy).
- **Birth certificate and Social Security card:**
  - Upload once and reuse every year, with no expiration and no reminders.
  - Replacements need a reason (correction, update, name change, unreadable copy) and staff verification.
- **Social Security cards:**
  - **The card image itself shows the full Social Security number.** Only the separate text field is limited to the last four digits; screens show `•••-••-1234 · image contains the full number`.
  - The image opens **view-only (no download)** after a confirmation. Staff must also choose a reason (preparing a return, verifying the card, client request, agency correspondence).
  - Each opening is written to the audit log (`identity.ss_card_viewed`) along with the access log.
  - It is never attached to or described in an email or text.
- **Tax checklists** point at the stored document (no copy and no new upload).
  - Shows: "On file — verified", "Received — pending verification", "Expired", or "Not on file".

## Who can open them
- **Staff:** Admins, the staff member assigned to the client, and any staff member an Admin has explicitly allowed for all clients.
  - To allow it: **Settings → Staff accounts → Manage → Identity documents: Allow for all clients**.
  - This changes nothing else: the person stays Staff, and it never opens the Owner's Office, which is bound to the owner's own account.
- **Portal account holders:** those with **Identity documents** access. Account owners have it; other authorized contacts don't unless an Admin turns it on in the Portal tab.
- **Enforcement:** checked on the server for every page, action and download link.

## Protection
- **Encrypted before storage.** Identity files are encrypted by the app (AES-256-GCM, key derived from `APP_ENCRYPTION_KEY`) before they reach private storage, and decrypted only for an authorized view or a malware re-scan. Never change `APP_ENCRYPTION_KEY`, or these files can't be opened.
- Files use the same pipeline as other documents: malware scan, with quarantine until clean; private storage; one copy per client; an access log of upload and view/download; and the retention policy for the **Identity document** category (Settings → retention).
- Identity files never appear in the yearly folders, recent-uploads lists or message attachments.

## Staff verification tasks
- Every upload (first copy or replacement) opens a staff task titled "Verify … — Client name". It is assigned to the client's staff member; a replacement license gets high priority. The task closes automatically when the document is verified or declined.

## Expired status
- When a verified license passes its expiration date it is marked **Expired**, even if a replacement is pending or was declined.
- The portal, the checklist and the reminders keep showing "Expired" (or "Expired — replacement awaiting verification") until a replacement is verified.

## Retention
- Set it in **Settings → Document retention → "Identity document"** (Admins only; link: `/settings#retention`).
- The keep-until date is set when a document is uploaded. Nothing is deleted automatically: expired documents are listed for an Admin to review, and every deletion is logged with a reason.

## Notifications
- Clients get email or text only as their communication preferences allow; texts respect quiet hours and STOP.
- The text is deliberately generic: "A document on file needs to be updated soon", "…needs to be updated", "A document you sent needs your attention". No names, document types, numbers or images.
- Staff alert emails say only that a client uploaded an identity document for verification, with a link.
- Reminders run in the 10-minute notifications cron.
- **Delivery check (Settings → Identity document reminders — delivery check, Admin):**
  - Send the real reminder notice to a test portal login, then mark "I received the test email/text".
  - Reminders are shown as **Active** only when `NOTIFICATIONS_ENABLED=true` and a test has been confirmed received.
  - "Accepted by the provider" is not counted as delivery.
