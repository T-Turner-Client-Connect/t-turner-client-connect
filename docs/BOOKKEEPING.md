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
- **Add a client:** use **Add a bookkeeping client** (schedule, payroll, accounts; only an Admin changes the assigned staff member), or use **Suggested** for clients whose Services already include bookkeeping.

## A client's workspace (`/bookkeeping/<client>`)
- **Months:** the list of all months, including prior ones, with their stage; open a new month here.
- **Service details:** schedule, assigned staff (Admin), payroll, accounts, notes, active or paused.
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
