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
- **Social Security numbers:**
  - The full number is never stored or typed into Client Connect.
  - Staff may record only the last four digits; screens show `•••-••-1234`.
  - The card image opens only from a logged **View** link.
- **Tax checklists** point at the stored document (no copy and no new upload).
  - Shows: "On file — verified", "Received — pending verification", "Expired", or "Not on file".

## Who can open them
- **Staff:** Admins, and the staff member assigned to the client.
- **Portal account holders:** those with **Identity documents** access. Account owners have it; other authorized contacts don't unless an Admin turns it on in the Portal tab.
- **Enforcement:** checked on the server for every page, action and download link.

## Protection
- Files use the same pipeline as other documents: malware scan, with quarantine until clean; private storage; one copy per client; an access log of upload and view/download; and the retention policy for the **Identity document** category (Settings → retention).
- Identity files never appear in the yearly folders, recent-uploads lists or message attachments.

## Notifications
- Clients get email or text only as their communication preferences allow; texts respect quiet hours and STOP.
- The text is deliberately generic: "A document on file needs to be updated soon", "…needs to be updated", "A document you sent needs your attention". No names, document types, numbers or images.
- Staff alert emails say only that a client uploaded an identity document for verification, with a link.
- Reminders run in the 10-minute notifications cron.
