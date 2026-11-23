# Owner Decisions

This is the single record of decisions the owner has made about how Client Connect works.
Read it before starting any work. If a question is already answered here, don't ask it again.
If a new decision is made, add it here, with its date, in the same change.

No client names, account numbers or other client details belong in this file (the repository is public).

---

## 1. Purpose and design priorities (Nov 9, 2026)

- **Goal:** an accounting firm opens Client Connect in the morning and immediately knows what needs to be done.
  Less paperwork, manual entry, back-and-forth and mental load, for the owner, staff and clients.
- **Simplicity is the highest design priority.** Before adding a button, screen, form, approval or workflow, ask whether it makes the user's job easier.
  If something can be done in two steps, don't make it six.
- **The software tells you the next step.** Opening a client shows what's complete, what's missing and what to do next.
- **Automate preparation, not professional judgment.** The system recognizes documents, prepares entries, finds missing information, matches records and organizes tasks.
  People review exceptions and make the accounting decisions.
- **The office side gets the same care as the client portal.**
- **Protect what works.** Every change preserves existing functionality; don't fix one thing by breaking another.
- **Don't rebuild.** Reuse working functionality and simplify around it.
- **No new features** until the simplification plan (section 9) is done, unless the owner asks for one.

## 2. Merges, deployments and development process

- **No PR is merged without the owner's explicit approval of that specific PR.** "Keep going," "continue" or approving a plan is not approval to merge.
  Approving a plan doesn't authorize building every item in it either: each improvement is reviewed individually.
- No production connections, deployments or credential changes without approval.
- Focused tests while building. The **full regression suite runs once before asking to merge**, and its results go in the PR.
- After a merge, verify the live deployment (and any migration) and check the affected workflow on the live site.
- One PR at a time where possible. Requirements and decisions are written down here so nothing has to be explained twice.

## 3. Things that stay off until the owner says otherwise

- Client rollout letters: **none are authorized in 2026.** No general client invitations or rollout.
- **Plaid live bank connections:** off (sandbox only). Existing Plaid credentials are not renamed, overwritten or exposed.
- **Payroll:** live payroll processing is unchanged. No automatic payroll submission. No live ADP imports until activation and end-to-end testing.
  No storing ADP passwords, scraping the portal or bypassing MFA.
- **No automatic tax filing, payroll submission or payments.** Nothing files with the IRS or a state agency automatically.
- No publishing new client-facing information without approval.
- Never request, store or expose passwords, recovery codes, auth secrets or API keys. No scraping.
- The production database is never reset or modified outside the app, and migration history is never deleted.

## 4. Bookkeeping and accounting

- **Opening balances come from verified, completed financial statements** (the client's last Balance Sheet / trial balance or our own completed package). No guessed balances.
- **No balancing plugs**, including automatic plugs to owner's equity or Opening Balance Equity. Every opening entry must balance on its own.
- **Preserve accurate monthly and year-to-date reporting.** When bringing in prior history, record each month's activity in its own month. Don't combine months in a way that misstates monthly reports.
- **Imported transactions stay unreviewed** until staff categorize them. Nothing is posted or approved automatically.
- **A month isn't finished just because the bank totals match.** Done means: every account reconciled (bank, credit cards, loans, outstanding checks), every transaction categorized, open items resolved or documented, statements verified, and documents filed.
- **Never guess when information is missing.** Flag it and say what's needed.
- Coetha prepares; the owner approves. Coetha never posts or changes bookkeeping entries by herself.
- Scanned (Xerox) statements must be readable, preferably inside our own system. Balances, totals and duplicates are verified before import, and unclear scans are flagged for staff instead of guessed.

## 5. Coetha

- **Ask Coetha (PR #148): approved Nov 9, 2026 to come off hold and be prepared** after PR #154. It merges only after tests, a demonstration and the owner's specific approval.
- Each client has its own conversation. Nothing from one client is read, sent or shown in another.
- Coetha uses the actual client records, explains in plain English, and says when information is missing instead of guessing.
- Same privacy safeguards as Coetha runs: data is de-identified before it leaves the system; the owner's Coetha switch and "Client prefers no Coetha" are respected; every question is audited.
- Coetha can explain, check and suggest. She can't post, change, approve, reconcile, close or send anything.

## 6. Permissions

- Books, payroll and tax returns are worked by the assigned staff for that client. Owner-only items stay owner-only.
- **Sending completed tax returns to a client's vault (Nov 9, 2026):** the owner, Admins, the assigned preparer or tax-service staff, or staff the owner grants **"Tax → All clients"** (owner-only grant).
  Other staff are refused.
  Every send verifies the client and tax year, requires the Form 8879 confirmation on the filing, and is audited.
- Changing or removing anything a client already sees is owner-only.
- Staff should be able to finish their authorized work without waiting on the owner. Approvals are kept for financial statement release, tax filing and payroll, not routine steps.

## 7. Client experience

- Keep the client side simple: upload, request services, sign agreements, pay invoices, and message the office.
- **Extension & Amendment Requests (concept approved Nov 9, 2026; build after #154 is finished and demonstrated, separate draft PR):**
  - **What clients do:** request from their Taxes page, choose the year and return type, explain the request, and upload supporting documents.
  - **What the office sees:**
    - Each request appears in the staff work queue with a notification.
    - Staff update its status without owner approval at each step: Requested → In Review → Information Needed → Prepared → Filed → Completed.
    - **Filed** only after staff record actual filing confirmation.
  - **Safeguards:**
    - Extension requests clearly state that more time to file is not more time to pay.
    - Deadline alerts, client-specific document access, an audit trail and staff permissions.
    - Nothing files automatically.

## 8. Priorities

1. **Complete the first real bookkeeping client end to end** on the live portal, through October 31, 2026, before any other bookkeeping client. Document every unnecessary step, confusing screen, repeated entry and missing automation while doing it (section 10).
2. Finish the open PRs one at a time, each with results, for the owner's specific approval.
3. Use what was learned to simplify the bookkeeping workflow for every client.

On hold until the owner says otherwise: Dependabot PRs #106, #145, #146, #147. #119 is superseded by #150 (closing it needs the owner's OK).

## 9. Simplification plan (approved Nov 9, 2026; each item still needs individual approval before it's built)

1. A "Next step" on every client: one clear action at the top of the client page, and every checklist line links to its fix.
2. One upload box per client that recognizes the file and routes it (bank statement → read and import; payroll report → Payroll; anything else → the vault).
3. Start books from existing financial statements: the system prepares the monthly opening entries for the owner's one-time approval.
4. Categorizing learns from decisions, with one-click acceptance of suggestions.
5. Months before a client's books start show "Not needed" instead of "In Progress."
6. The owner's morning page: every client's status and next step, one "Waiting on me" list, and the week's deadlines.

Running alongside: scanned (Xerox) statement reading.

## 10. Friction log

Real problems found while using Client Connect. Each one is a candidate for a small fix, prioritized by how much time it costs.

| # | Found | What happened | Cost | Candidate fix |
|---|---|---|---|---|
| 1 | Nov 9 | Didn't know where to upload a bank statement for a client | Had to ask | Plan item 1 / 2 |
| 2 | Nov 9 | Monthly checklist shows red items ("0 of 1 accounts") with no way to act on them | Confusion | Plan item 1 |
| 3 | Nov 9 | Months before the books start show "In Progress 13%" | Looks unfinished | Plan item 5 |
| 4 | Nov 9 | The "Opening balances" form only accepts balance-sheet accounts and sends any difference to Opening Balance Equity, which is a plug | Can't use it as designed; I had to prepare the opening entries by hand | Plan item 3 |
| 5 | Nov 9 | Bringing in 8 months of history from a verified financial package means typing about 130 journal lines by hand | Repeated entry | Plan item 3 |
| 6 | Nov 9 | Dashboard reads $0.00 while a hand-entered bank balance shows "Issue," with no explanation | Confusion | Plan item 1 |
| 7 | Nov 9 | Scanned statements can't be read | Manual transcription | Scanned-statement support (in progress) |
| 8 | Nov 9 | Staff couldn't deliver returns to the vault without the owner | Owner bottleneck | PR #154 |
