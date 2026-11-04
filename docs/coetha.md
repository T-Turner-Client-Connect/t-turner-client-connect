# Coetha in Client Connect

Coetha is the firm's AI Senior Accountant. Inside Client Connect she prepares **draft** bookkeeping
work for one business at a time from that business's connected bank data. Only Tabitha approves
her work; staff can't, and Coetha never posts or finalizes anything herself.

## Where

- Each bookkeeping client: **Coetha AI** in the client's menu, or `/bookkeeping/<client>/coetha`
  (also linked from the Client Overview and the monthly close page).
- On/off switch: **Owner's Office → Coetha & bank feeds → Coetha AI** (primary owner only, off by
  default, every change audited).

## What a run does

**Run Coetha** (or the optional daily run after bank retrieval, same switch) reads only that
business's data: transactions waiting for review, the chart of accounts, categorization rules, how
similar transactions were categorized before, reconciliation status, the month-end checklist and the
ledger's warnings. It asks Claude for:

- **Category recommendations**: one per transaction, with the account, a confidence and a one-line
  reason.
- **Discrepancies**: possible duplicates, missing statements, unreconciled differences, owner draws
  posted as expenses, unusual amounts.
- **Draft adjusting entries**: balanced, using only this business's accounts.
- **A draft month summary.**

Everything is saved as a proposal with the run's model, time and a fingerprint (SHA-256) of exactly
what was sent. Anything that refers to an unknown transaction or account, or an entry that doesn't
balance, is dropped. A new run replaces older open drafts. The run history shows token usage and
errors.

## Approval

- Only Tabitha (the primary owner) sees **Approve** and **Reject**, one at a time or in bulk. She can
  change a recommended category before approving.
- Approving a category posts that bank transaction through the ledger's normal rules (this
  business's accounts only, open period only, posted once). Approving an adjusting entry posts it as
  an adjusting journal entry, once. Approving a discrepancy or summary just records that she
  reviewed it.
- Approving twice never posts twice. Rejecting posts nothing.
- Every approval and rejection is in the audit log, with who decided and whether the category was
  changed.
- Staff with access to the business's books can see the drafts and keep doing their normal manual
  bookkeeping. If they post a transaction themselves, Coetha's draft for it is retired.

## Privacy

Data goes to **Anthropic's API (Claude)** under the firm's own API key. Only what the work needs is
sent: dates, amounts, transaction descriptions and account names. Long numbers are shortened to the
last four digits; SSN/EIN-shaped numbers, emails and phone numbers are removed; client names,
addresses and contact details are never sent.

## Settings (Netlify environment variables)

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the firm's Anthropic API key (required) |
| `COETHA_MODEL` | optional; default `claude-sonnet-5-5` |

Without `ANTHROPIC_API_KEY`, the Coetha page says "Coetha needs an Anthropic API key — add
ANTHROPIC_API_KEY in Netlify" and the rest of Client Connect works as usual.

## Limits

A run looks at up to 80 waiting transactions at a time (run again for more). The daily run handles up
to two businesses per hour so each run finishes within the hosting time limit.
