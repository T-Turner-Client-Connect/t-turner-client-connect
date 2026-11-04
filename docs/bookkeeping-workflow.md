# Monthly bookkeeping workflow, banking and Coetha as senior accountant

For Tabitha and the office. What changed, where it lives, and the rules behind it.

## The monthly checklist (automatic)

Bookkeeping → client → **Bookkeeping Management** (`/bookkeeping/<client>/close`). Every line is
derived from real data; nobody checks anything off:

| Line | Comes from |
|---|---|
| Bank transactions synchronized | Each bank account's Plaid feed synced past month end (or a statement imported). A working feed is "synced" — it is never marked "statement missing". |
| Credit card transactions synchronized | Same, per card / line of credit / loan (hidden when there are none). |
| Missing receipts or supporting documents | Outstanding receipt / explanation requests for the month, and anything parked in Ask My Accountant. |
| Payroll data received | Payroll reports for the month (payroll clients only). |
| Transactions categorized | Unreviewed bank rows in the month. |
| Accounts reconciled | The per-account reconciliations (below). |
| Financial statements prepared / Awaiting Tabitha's approval / Released to client | The month's statements and their review status. |

Green = complete, red = genuinely missing, amber = in progress, gray = not yet due. Annual tax
documents (W-2, 1099, 1098, K-1) are **never** in it: they live in **Year-End Tax Documents** on
the W-2 / 1099 Center, open from January 1 to October 15 for the year just ended.

## Office work vs. client portal access

`assertManagedBusiness` used to block ledger work unless the client had owner-approved Managed
Business access. It now allows OFFICE work for any **active Bookkeeping Client** (or a Managed
Business). Client-facing access is unchanged: the client sees business books, statements and
bookkeeping months in the portal only with Managed Business access (`effectiveGrant`). Nothing grants
client access automatically, a bank connection never grants it, and a client that is neither a
Bookkeeping Client nor a Managed Business is still refused. The Overview badge now reads "Client
portal: Managed Business access granted / not granted".

## Banking & Credit Card Connections

`/bookkeeping/<client>/banking`. The registry (`BookkeepingAccount`) holds institution, nickname,
type, last 4, opening balance + date, statement closing day, sub-cards and the assigned GL account
(`LedgerAccount`: asset for checking/savings, liability for cards, lines of credit, loans). Plaid
accounts (`BankConnectionAccount`) feed the GL account. Usernames, passwords, full numbers and
security codes are refused. Monthly reconciliation (`AccountReconciliation`, one per account per
month) is at `/banking/reconciliation`; Coetha prepares it, only Tabitha approves (which also
records the ledger's reconciled-through date).

Permissions use Staff Access & Permissions: "Banking and reconciliation" View / Edit, plus Admins
and the assigned staff member. Approvals are Tabitha's alone (`canApproveCoethaWork`).

## Coetha's requests and recommendations

The hourly cron runs Coetha's monthly monitor once a day per bookkeeping client (rules only — no AI
call, nothing leaves Client Connect). She prepares reconciliations, drafts targeted requests (exact
document, account, period, reason; never re-requesting what's on file) and records recommendations
with full rationale (what she found, why, the correction, accounts, supporting transactions, impact).
Drafts go out only with one click from staff, or automatically if Tabitha turns on "Coetha sends
document requests automatically" (Owner's Office → Coetha & bank feeds).

**Business Tax Classification** (Form 1065, 1120-S, Schedule C, Other / Requires Review) is set by
Tabitha under Settings on the management screen. Coetha applies its rules (owner draws, shareholder
distributions, partner draws, guaranteed payments, payroll) and may only recommend a change.

Owner's Office → **Coetha Accounting Review** lists everything waiting across clients.

## Client-facing statements

Clients see only "Financial Statements in Preparation" or "Available for Download". Ledger-built
P&L, Balance Sheet and General Ledger PDFs (`/api/client/statements`) exist only after Tabitha
approved and released the month's statements and closed the books through month end. The builders in
`services/client-statements.ts` never read Coetha tables, review notes, entry reasons or staff names,
and every text passes a sanitizer that removes internal markers.
