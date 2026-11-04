# Turning on real bank connections (Plaid production)

For Tabitha. This explains, in plain language, what is already built, what you need to do to
connect clients' real business bank accounts, and how the automatic retrieval behaves.

Nothing connects to a real bank until **both** of these are true:

1. The Plaid **production** keys are saved in Netlify (`PLAID_ENV=production`), and
2. You turn on **Live bank connections** in **Owner's Office → Coetha & bank feeds**.

Production keys alone do nothing, and the switch alone does nothing. Only you can flip the
switch (staff Admins can't), it is off by default, and every change is recorded in the audit log.

---

## What is already built

- **Connecting a bank (Plaid Link).** From a business's **Books & Ledger → Bank & reconcile**, staff
  press **Connect a bank**. The client signs in to their bank in Plaid's own window (in the office,
  or with staff on the phone). Client Connect never sees the bank password. Staff then record who
  authorized the read-only connection and how (client present, from the portal, or written
  authorization). Each connection belongs to **one** business; a client with two businesses
  authorizes each one separately.
- **Read-only.** Only the Transactions product is used. No money can ever be moved.
- **Access tokens are encrypted** in the database with the site's encryption key and are never shown
  on any page or log.
- **Automatic retrieval.** The hourly scheduled job pulls every active connection that hasn't been
  retrieved in the last 20 hours, so each connection is pulled **at least once a day**. When Plaid
  tells us new transactions are ready (webhook), that connection is pulled right away.
- **Duplicates.** Each Plaid transaction has its own ID; the same ID is never added twice. A
  transaction already imported from a CSV statement (or a statement imported after the bank feed)
  is recognized and linked, not added again. If it isn't clear which statement row a bank row
  matches, it is **flagged** for staff instead of being merged.
- **Changes from the bank.** If the bank changes or removes a transaction that is still waiting for
  review, it is updated or set aside. If it was already posted, the books are **not** changed;
  the row is flagged so a person decides.
- **Failure detection.** If the bank needs the client to sign in again (for example
  `ITEM_LOGIN_REQUIRED`, an expiring consent, or revoked access), the connection is marked **"Client
  must sign in again"**, a **high-priority task** is created for the assigned staff member (or you),
  and the books show a warning. A **Reconnect** button opens Plaid so the client signs in again;
  history and settings stay. Other errors (Plaid or the bank temporarily down) are recorded and
  retried on the next run.
- **Isolation.** Every connection, transaction and job is tied to one client business. A business's
  bank rows can only land in that business's own bank or card account in its own books.
- **CSV import stays** as a backup on the same page, for banks Plaid doesn't support or for months
  before the connection.
- **Nothing is posted automatically.** Retrieved rows wait in the review list. Staff post them
  manually, or Coetha drafts categories that only you approve.

---

## What you need to do

### 1. Plaid account and Production access (in the Plaid Dashboard)

1. Sign in at **dashboard.plaid.com** with the firm's Plaid account (or create one for
   T. Turner & Associates, LLC).
2. Open **Production access** (sometimes shown as "Get production access" or "Request access") and
   complete the application:
   - **Company profile**: legal name, address, website, what the firm does (tax and bookkeeping),
     and how you use bank data (read-only transactions for your clients' bookkeeping).
   - **Use case**: choose bookkeeping/accounting. Say clients authorize each connection and that
     the data is only used to prepare their books.
   - **Security questionnaire**, if Plaid asks for one. Answer honestly; useful facts about Client
     Connect: tokens encrypted at rest, staff sign-in with two-step verification, role-based access
     (only Admins and the assigned staff member can open a client's books), audit logs, read-only
     access, data hosted on Netlify with a managed Postgres database.
3. Make sure the **Transactions** product is enabled for Production.
4. **OAuth banks** (Chase, Wells Fargo, Bank of America, Capital One and others): Plaid may ask you
   to complete their OAuth registration and to add an **allowed redirect URI**. Add:
   `https://<your site>/bookkeeping/plaid-oauth` (for example
   `https://clientconnect.tturnerassociates.com/bookkeeping/plaid-oauth`), and set the same value as
   `PLAID_REDIRECT_URI` in Netlify (step 2). Without it, most OAuth banks still work in a pop-up
   window on a computer.
5. When Production is approved, copy the **Production** `client_id` and **Production secret** from
   **Developers → Keys**. (The sandbox secret is different; don't mix them up.)

**Expected timeline** (estimates; Plaid's Dashboard shows the actual status):
- Application and company profile: about an hour of your time.
- Plaid's review: often a few business days; longer (1–2 weeks) if they ask follow-up or security
  questions.
- Some large banks' OAuth registrations finish later than the general approval (days to a few weeks).
  Other banks work as soon as Production is approved.

### 2. Netlify environment variables

In **Netlify → Site configuration → Environment variables** (scopes: Builds and Functions; mark the
secret as secret):

| Name | Value |
|---|---|
| `PLAID_CLIENT_ID` | the Production client_id |
| `PLAID_SECRET` | the **Production** secret |
| `PLAID_ENV` | `production` |
| `PLAID_REDIRECT_URI` | optional: `https://<your site>/bookkeeping/plaid-oauth` (only if you added it in Plaid) |
| `CRON_SECRET` | already set for the hourly jobs; leave as is |

The webhook address is set automatically on each connection
(`https://<your site>/api/webhooks/plaid`); you don't need to enter it in Plaid. Every webhook is
checked against Plaid's signature before anything happens.

### 3. Redeploy

In Netlify, **Deploys → Trigger deploy → Deploy site**, so the new values take effect.

### 4. Turn on the switch

Owner's Office → **Coetha & bank feeds** → **Live bank connections** → **Turn on**. The page shows a
checklist (keys, `PLAID_ENV=production`, switch) so you can see everything is in place.

To stop at any time, turn the switch off. Retrieval from real banks stops immediately; nothing
already retrieved is removed. (Disconnecting a bank still tells the bank to revoke access.)

### 5. Connect each business

For each business, with the client: **Books & Ledger → Bank & reconcile → Connect a bank**. The
client signs in and chooses the accounts. Then pick which ledger account each bank account feeds
(checking → Business Checking, the card → Business Credit Card, and so on). Only mapped accounts are
retrieved.

Sandbox connections made while testing stay labeled "sandbox" and are not retrieved with the
production keys. Disconnect them when you no longer need them.

---

## Your questions, answered

**How often do banks update?** Plaid checks each bank for new transactions several times a day
(usually one to four times, depending on the bank). Client Connect pulls every connection at least
once a day on its own schedule, and right away whenever Plaid's webhook says new transactions are
ready. Banks usually show a card purchase as "pending" first; pending transactions are skipped and
the final version is added once the bank posts it (typically 1–3 business days).

**Does it get all the accounts automatically?** Every account the client selects in Plaid under that
bank login. Each one is mapped once to a ledger account; from then on its transactions arrive
automatically. A different bank, or a second login at the same bank, is another **Connect a bank**.
If the client opens a new account at the bank later, use **Reconnect** so they can add it. The first
pull brings in up to about two years of history if the bank provides it (rows before the business's
opening-balance date are set aside automatically).

**Can there be duplicates?** No duplicate is added for the same Plaid transaction ID, and rows
already imported from a CSV statement are recognized and linked. Only a genuinely unclear match is
flagged for a person to decide; nothing is merged or deleted on a guess.

**How will we know when a connection breaks?** The connection is labeled on the bank page, a
high-priority task goes to the assigned staff member (or you), and the business's books show a
warning until the client signs in again. Each retrieval (time, rows added, errors) is listed under
the connection.

**Can one client's data reach another client?** No. Each connection is authorized for one business,
its rows can only go into that business's own accounts, and every page and job checks the business
first. Staff only see a business's books if they're an Admin or assigned to that business.

**What does it cost?** Plaid bills the firm for each connected bank login per month under your Plaid
agreement; check the pricing in your Plaid Dashboard or contract.

---

## Coetha and bank data

Coetha (Owner's Office → Coetha & bank feeds → **Coetha AI**, off by default) reads a business's
retrieved transactions to draft categories, discrepancies, adjusting entries and a month summary.
When she runs, that business's transaction dates, amounts and descriptions and its account names
are sent to **Anthropic's API (Claude)** under the firm's own API key (`ANTHROPIC_API_KEY` in
Netlify; `COETHA_MODEL` optionally picks the model, default `claude-sonnet-5-5`). Long numbers in
descriptions are shortened to the last four digits, and no SSNs, EINs, names, addresses or contact
details are sent. Coetha never posts or finalizes anything: only you approve her work, and only an
approval posts it to the books. See `docs/coetha.md`.

---

## Credit cards, history, statements and what Plaid can't reach

"Verified" below means confirmed from the code in this repository and how it behaves in tests
against a simulated Plaid. "Not verified" means we could not confirm it from inside the project
(Plaid's documentation site isn't reachable from the build environment and no Plaid SDK is
vendored); confirm those points in the Plaid Dashboard or with Plaid before relying on them.

| Question | Answer | Status |
|---|---|---|
| Credit card accounts | Yes. Link returns card accounts (`type: credit`, `subtype: credit card`) alongside checking/savings; each is mapped to its own **liability** GL account. Transactions arrive through the same Transactions product. | Verified (code path and tests) |
| Transaction sync | Yes — `/transactions/sync` with a saved cursor, webhooks for new data, daily backstop. Pending rows are skipped; changed/removed rows are flagged, never silently changed after posting. | Verified |
| Historical retrieval | Link asks for `transactions.days_requested: 730` (about two years). How much an institution actually returns varies (often 90 days to 24 months). Rows before the books' opening date are set aside automatically; Coetha drafts a Historical Records request for any gap between the opening date and the first retrieved month. | Setting verified in code; per-bank depth **not verified** |
| Balances | `/accounts/get` balances are stored at link time; `/transactions/sync` balances are stored when the response includes them. Used for outstanding card balances and the employee-card check. | Verified (optional field handled) |
| Statement PDFs (Plaid **Statements** product) | Built as an adapter seam only (`src/lib/statement-retrieval.ts`). No Statements endpoint is called, because its request/response shape could not be verified here. When a statement isn't available, Coetha drafts a request for that exact account and month. To turn it on later: enable Statements in the Plaid Dashboard, set `PLAID_STATEMENTS_ENABLED=true`, add the verified implementation, and re-link (Link update mode) so clients consent. Statements are supported only at some institutions. | **Not verified**; fallback verified |
| Lines of credit and loans | A line of credit often appears as a `credit` account and can be monitored like a card (liability). Loans (`type: loan`) frequently show balances/details only through Plaid's **Liabilities** product, which Client Connect does not request; for those, staff register the loan by hand and Coetha requests the loan agreement and statements. | Partially verified; Liabilities **not used** |
| Institutions Plaid doesn't support, or business accounts behind special logins | Register the account by hand (Manage Accounts) and use CSV statement import or statement uploads against Coetha's requests. Some banks need OAuth registration first (see step 1.4). | Process verified |

### Employee / authorized-user cards

Some issuers report each employee card as its own Plaid account even though they share ONE credit
line; others report only the main account. Client Connect detects the first case when a bank is
linked: credit-card accounts in the same login with the **same credit limit and the same current
balance** (and the same product name) are suggested as one shared account. The first card is the
primary; the others are shown as "Employee cards on one shared credit account?" with **Confirm — one
account** (they all feed the primary's liability GL account) or **Separate account** (staff override:
it gets its own account). While suggested or confirmed, the same charge reported under two cards
(same date, amount and description) is stored once. When Plaid reports only the main account, staff
add the employee cards in Manage Accounts as sub-cards of that account (no GL account of their own).
Every decision is audited.

### Card payments

A payment from checking to a card, line of credit or loan is a **transfer** (bank asset → liability),
never an expense. Coetha recognizes the payment from its description (the card's last 4, issuer or
nickname next to "payment"/"autopay") even when only the bank side is connected, and suggests the
card's liability account; when both sides are connected, posting one side links the other so it's
recorded once. A payment already posted to an expense is flagged in the books and raised as a
Coetha recommendation with the correcting entry for your approval.
