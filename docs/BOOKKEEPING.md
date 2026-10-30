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
