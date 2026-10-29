# Owner's Office & billing

## Access
- The Owner's Office is bound to one staff **account ID** through an `OwnerAccess` row. It is claimed once,
  from the staff account whose sign-in is `tabitha@tturnerassociates.com` (`OWNER_EMAIL` in `src/lib/business.ts`),
  by an Admin with two-step verification who re-enters their password. After that the email no longer matters.
- Everyone else (Staff, other Admins, clients) gets a plain 404 on `/owner/*`, `/api/owner/*` and receipts.
  Owner records live in separate tables (`Invoice`, `Payment`, `Expense`, `BillingSettings`), a separate
  audit log (`OwnerAuditLog`) and a separate private file store (`client-connect-owner`), so shared staff
  pages, client search, reports, the staff audit log and the general file route can't reach them.
- Only the owner can share access: **Billing only** (quotes, invoices, payments) or **Full**. A delegate can't
  change the payment-plan fee, see expenses or totals, or grant access onward.

## Money rules
- Amounts are integer cents; percentages are basis points. Calculation order is printed on every quote:
  services → discount → sales tax → full-payment total → payment-plan fee → plan total → deposit → installments.
- **Payment-plan fee** comes from Billing settings (flat $ or % of services after discount, before tax). It's
  added once, only to the plan option, and can't be typed as a line item. It is not a card surcharge; card
  surcharges are not supported. Turning on a fee requires confirming you've checked your payment provider's
  rules and legal requirements (for consumer installment plans with a finance charge, federal Truth in Lending
  rules can apply — confirm with your attorney before offering plans with more than four installments).
- **Discounts** (flat or %) are set by the owner/delegate only; optionally they also reduce the plan fee.
- **Acceptance** freezes the exact terms (lines, discount, tax, fee, total, schedule) with a SHA-256
  fingerprint, timestamp, portal user and IP. Later settings changes never alter accepted terms.
  No automatic or recurring charges are ever created.
- **Invoiced revenue** = accepted quotes / issued invoices, by acceptance or issue date.
  **Collected** = recorded successful payments minus refunds, by date received. Failed and pending
  payments never count. Unpaid invoices never count as cash.

## Payment provider
**None connected.** Payments, refunds and failures are recorded by hand and labeled "Recorded manually".
To take card/ACH payments online and get provider-confirmed results you'd need a provider account
(e.g. Stripe or Square), its secret API key and webhook signing secret in Netlify (never in GitHub), and a
review of that provider's rules on fees before enabling any plan fee for online payments.
