# Bookkeeping Clients (staff)

**Where:** staff sidebar → **Bookkeeping Clients** (`/bookkeeping`), directly under Clients. It's visible to every staff member, Tabitha and Daria included. It's separate from the private Owner's Office.

## The list
- **Each row shows:** client, assigned staff, schedule (monthly/quarterly), payroll (frequency and provider), missing documents, the current period with checklist progress, stage, and overdue reasons.
- **Filters:** assigned staff (anyone, me, a specific person, unassigned), schedule, **Missing documents**, **Overdue work**, **Awaiting Tabitha's review**.
- **Stages:**
  - Waiting on client documents
  - Awaiting staff work
  - Awaiting Tabitha's review
  - Ready to deliver
  - Delivered
  - Collected (quarterly, report at quarter end)
  - Month not opened
- **Overdue:** uses each client's own deadlines, set in their **Service details**: "Documents due" and "Reports due", each a day of the month after the work month (Day 1–30, or Last day).
  - **There is no default.** A client with no due day set is never marked overdue for it.
  - A requested item is overdue after its own due date.
  - Earlier unfinished months count too.
- **Open this month for all clients** creates last month's workspace and checklist for every active client.
- Tabitha sees **Awaiting your review** at the top.
- **Add a client:** **+ Add Bookkeeping Client** (top of Bookkeeping Clients) opens `/bookkeeping/new`:
  - **Existing CRM client** — search, choose the client, set schedule, assigned staff, payroll and optional due days. Never creates a client record; clients already enrolled show "Already enrolled — Open workspace"; a paused client is reactivated.
  - **New client** — checks the CRM first: a matching email or phone (including a contact's) always stops and links to the existing record; a same-name match needs "This is a different client". A business is named for the business and the person becomes its contact. No invitation, email or text is sent.
  - Admins and staff can both set the assigned staff member (as on the client record). "Keep as is" never unassigns.
  - **Suggested** still one-click-adds clients whose Services include bookkeeping.

## A client's workspace (`/bookkeeping/<client>`)
- **Months:** the list of all months, including prior ones, with their stage; open a new month here.
- **Service details:** schedule, assigned staff, payroll, accounts, notes, active or paused.
- **Monthly checklist:**
  - From the client: bank statements, credit card statements, payroll reports (only for payroll clients), receipts.
  - Staff: categorize, reconcile, record payroll (payroll clients), prepare P&L and Balance Sheet.
  - Each line shows who it's waiting on: *Waiting on client*, *Received — staff to review*, *Staff work*, *Done*, *Not needed*.
- **Quarterly clients** still collect documents every month. The "prepare reports" step and the reports are due only in March, June, September and December.
- **Bank & card statements** and **Payroll reports** appear as separate lists. A client's upload counts once it's labeled; clients can label it when uploading, and staff can label it later.
- **Financial reports:** draft → **Submit for Tabitha's review** → Tabitha **Approves** or **Requests changes** (with a note) → staff **Deliver to client**.
- **Messages** for the month and the client, plus "Ask the client about …".

## Approval rules (enforced on the server)
- **Only Tabitha approves financial reports.** "Tabitha" means the primary Owner's Office account, or the owner email before the Owner's Office is claimed. Other Admins and staff can't approve.
- **Reports are always saved as drafts.** They can't reach the client before approval, whether by publishing, by attaching to a message, or by marking the month "Ready for your review" or "Complete".
- Each step (submit, approve, request changes, deliver) is in the audit log.
- Approving reports grants nothing in the Owner's Office.

## Upload Monthly Financials

- In a client's workspace, **Upload Monthly Financials** (top right) → choose **year**, **month**, report (Profit & loss, Balance sheet, Other report), optional title, and the file (PDF/PNG/JPG, up to 5 MB). The month is opened if it isn't yet.
- **Year and month** (left) jumps to any month; a month that isn't opened yet offers **Open**.
- Files are stored once, as `BOOKKEEPING` documents with the year, month and bookkeeping month, so the same file appears in the client's Documents tab and, after delivery, the client portal vault.
- Every upload is a **staff-only draft** (malware-scanned like every upload). Submit → Tabitha approves or asks for changes → staff **Deliver to client**, which publishes it and sends the usual generic "new document" notice.
- **Revisions:** **Upload a revised version** on a report (or upload another P&L/Balance Sheet for the same month) saves the next version (v2, v3…). Earlier versions are kept under **Version history** with who uploaded, approved and delivered them. A delivered version stays with the client until the new version is approved and delivered; then the client sees only the newest one. Superseded versions can't be submitted, approved, delivered or published.
- **Errors are always shown:** form problems explain what to fix; a file over 5 MB or a lost connection is reported before/without saving; an unexpected failure says nothing was saved and gives a reference code; a missing database update (migration) says so.

## Business profile (`/bookkeeping/<client>/profile`)

- **Business information:** legal name, DBA, entity type, EIN, start date, accounting basis (cash / accrual / modified cash), business address, business email, contact person and title, working tax/accounting year, fiscal year end. Reporting schedule (monthly/quarterly) is set in the workspace's Service details.
- **EIN:** stored encrypted; everyone sees it masked (XX-XXX1234). Staff can enter or replace it; only an **Admin** can show the full number (**Show full EIN**), and each view is written to the audit log.
- **Payroll:** "Does this business have payroll?" Yes/No (Service details). When Yes: provider, frequency, account-access status, and the payroll reports required each month.
- **Bank & credit-card accounts:** any number of accounts — institution, type, last four digits, official sign-in page (https only), access status (not requested, requested, accountant/delegated access, official connection, statements only, removed). **No passwords, PINs, security answers or codes are ever stored** — the form refuses them. Use the bank's accountant/delegated access, or upload statements (statements can be linked to an account).
- **Monthly bookkeeping billing (Tabitha only, or staff she allows in Settings → Staff accounts):** monthly charge, billing start date, billing day, payment status, Square customer ID, and the client's **recurring-charge authorization** (amount, method, who authorized, date, and the signed form/agreement). A card on file alone never authorizes a charge. **Square is shown as "Not connected"** until the Square integration is configured; card brand/last four/expiration will only ever come from Square, and payment methods are added only through Square's own secure page.
- Kept separate from the Owner's Office.

## Financial packets

- **Upload Monthly Financials:** choose year, month **or quarter**, and whether the report covers just that period or **year to date** (from the fiscal-year start). Report kinds: complete financial packet (one file), Profit & Loss Statement, Gross Receipts, Balance Sheet (with an **as of** date — defaults to the period end), Bank Reconciliation (pick the account), supporting schedules, other. Accounting basis comes from the business profile (or is chosen per upload). "Shows monthly detail and year-to-date totals" is recorded for each report.
- Staff prepare the statements and upload them; the app files, reviews and packages them — it doesn't recalculate figures.
- **Packet PDF:** a cover page laid out like the firm's statement packets (TTurner & Associates logo, client legal name, "Financial Statements", period and basis, Prepared for / Prepared by / Date / Contents), followed by the uploaded statements in order (P&L, Gross Receipts, Balance Sheet, Bank Reconciliation, schedules). A complete packet uploaded as one file is used as is. Staff previews are stamped **DRAFT**; clients get only delivered, scanned-clean reports.
- **Delivery:** every report is a staff-only draft → submitted → **approved by Tabitha** → delivered by staff (one at a time or **Deliver all approved**), which publishes it and sends the usual generic notice. Clients view, print and download the packet from **Bookkeeping** in their portal; each report also appears in their yearly vault.
- **Revisions:** a revision is a new version with full revision and approval history. The client keeps the previously delivered version until the revision is approved and delivered.

## Malware scanning

Each upload shows **Scan: Pending / Scanning / Passed / Failed** with the reason it's still quarantined (scanner not set up, scanner not answering, rejected key, automatic re-check not running). A file is released only by a clean scan; a clean financial report is still a staff-only draft until Tabitha approves it and staff deliver it. See docs/INTEGRATIONS.md for scanner setup.
