# Sending invoices through Square

For Tabitha. This covers how Client Connect sends firm invoices through **the Square connection
you already have**, what has been checked, what Square permissions it needs, and the exact steps to
turn it on. Nothing below disconnects, replaces or re-creates your Square connection.

## What it does

1. Staff create an invoice (Create Invoice). You approve it as you do now.
2. When **Send invoices through Square** is on, approving it (or pressing **Send via Square** on the
   invoice later) does this in your Square account:
   - finds the client's Square customer. It tries, in order: the customer already linked under
     Square billing, the one an earlier invoice used, an exact email match, then an exact phone
     match. It creates a new customer only when nothing matches.
   - creates an **order** at your location, one line per service, at the invoiced amount.
   - creates a **Square invoice** for the balance, due on the invoice's due date. The client can
     pay by card, and by bank transfer (ACH) unless you turn that off. There is no surcharge.
   - **publishes** it. Square then gives the invoice its own secure payment page.
3. The client sees **Pay securely with Square** on the invoice in their portal. The button appears
   only while Square says the invoice can still be paid. By default we also email the client our own
   branded email with the link. You can choose instead to have Square send its own email.
4. When the client pays, Square notifies Client Connect (a webhook). The payment is then recorded
   on the invoice once, as a payment from "Square", and the invoice moves to **Partially Paid** or
   **Paid**. Client Connect also re-checks every hour, so a missed notification is still caught.
5. **Reconcile Square** (in the Owner's Office) lists the Square payments matched to invoices.
   It also lists any Square payment that couldn't be matched, so staff can apply it to an invoice
   or mark it reviewed.
6. **Voiding** an invoice cancels it in Square if it is unpaid. If the client has paid any of it in
   Square, the void is refused: refund in Square first, then record the refund.

Client Connect never charges a card itself, never sees or stores card numbers, and never refunds.
Refunds are made by you in Square.

## Who can do what

| Action | Who |
| --- | --- |
| Create and submit invoices | You, and staff you gave billing access |
| Approve invoices | You |
| Send an approved invoice through Square, email the link again | You, and staff with billing access |
| Record payments received | You, and staff with billing access |
| Reconcile Square payments | You, and staff with billing access |
| Refunds, credits (adjustments), voids | You (full access) |
| Billing settings, including **Send invoices through Square** | You only (the primary owner) |

Every check runs on the server, through `src/lib/auth/billing-permissions.ts`.

## What has been verified

- **This is the same connection.** Sending uses the same `SQUARE_ACCESS_TOKEN`,
  `SQUARE_LOCATION_ID` and `SQUARE_ENVIRONMENT` that already import your recurring billing. It
  also uses the same API client and error messages. Nothing new is connected, and there's no OAuth.
- **The Square APIs already in use** (from the code): Locations (read), Customers (list, search,
  read, and create when a client saves a card), Cards (read, save, disable), Invoices (search),
  Orders (batch read) and Payments (read).
- **The APIs invoicing adds:** Orders (create, read), Invoices (create, publish, read, cancel, and
  delete for an unpublished draft), and Customers (create, only when there's no match).
- **Duplicates and safety** were tested against a local stand-in for Square, never the real
  Square:
  - a retry after a lost reply never creates a second order, invoice or customer
  - a repeated Square notification never records a payment twice
  - while the switch is off, nothing is sent to Square
- **Not yet verified against your live Square account:** whether Square accepts these writes with
  your token. That needs the read-only connection check below, then your own $1 test. Nobody but
  you does the $1 test.

## Square permissions it needs

| Permission | Used for |
| --- | --- |
| `CUSTOMERS_READ`, `CUSTOMERS_WRITE` | Find the client's customer; create one only if there's no match |
| `ORDERS_READ`, `ORDERS_WRITE` | Create the invoice's order; read which payments paid it |
| `INVOICES_READ`, `INVOICES_WRITE` | Create, publish, read and cancel the invoice |
| `PAYMENTS_READ` | Read each payment's amount, method and date |
| `MERCHANT_PROFILE_READ` | Confirm the location (already used) |

Your connection uses a **personal access token** from the Square Developer Dashboard. A personal
access token has every permission for your own Square account, so it already covers all of these.
Nothing needs to be re-authorized. (A token from an OAuth app would carry only the scopes it was
granted. That's why the connection check below reads the token's permissions from Square.)

### How to check it safely (read-only)

Go to **Bookkeeping → Square billing → Check Square connection**. The check only reads:

- `GET /v2/locations/{your location}`: the token is accepted and the location is ACTIVE
- one read each of customers, invoices, cards, orders and payments (`GET /v2/payments`)
- `POST /oauth2/token/status`: Square's own list of the token's permissions. A personal access
  token is reported as having every permission.

The check never creates, changes or charges anything. The Billing settings page shows the result
next to the switch.

## Turning it on: exact steps

Do these in order.

1. **Confirm the environment.** In Netlify (Site configuration → Environment variables), confirm
   `SQUARE_ENVIRONMENT` is `production`. If it isn't, invoices go to Square's test system, not to
   real clients. Billing settings shows a warning when it isn't production.
2. **Add the webhook in the Square Developer Dashboard.** Use the same application your access
   token belongs to:
   - Open the application → **Webhooks → Subscriptions → Add subscription**.
   - Name: `Client Connect invoices`.
   - URL: `https://<your Client Connect site>/api/webhooks/square`. Use exactly the address
     shown under "Payment notifications" on the Billing settings page.
   - API version: `2025-01-23` (or newer).
   - Events (check exactly these):
     - `invoice.payment_made`
     - `invoice.updated`
     - `invoice.canceled`
     - `payment.updated`
   - Save, then copy the subscription's **Signature key**.
3. **Add the signature key to Netlify.** Create `SQUARE_WEBHOOK_SIGNATURE_KEY` = the signature key
   and mark it secret. Only if the dashboard URL differs from the site address (for example a
   custom domain), also set `SQUARE_WEBHOOK_URL` to exactly the URL saved in the dashboard. Then
   redeploy so the new variables take effect.
4. **Run the connection check** (see above) and confirm it says Working.
5. **Approve Square as a payment option.** Billing settings → Payment instructions clients see →
   Square: turn it on. This is already done if you offer Square on invoices today.
6. **Turn on the switch.** Billing settings → **Send invoices through Square → Turn on Square
   sending**. Optionally choose how the client gets it ("Our branded email" is the default), and
   whether to accept bank transfer. The change is recorded in your private activity log.

To stop at any time, press **Turn off Square sending**. Invoices already in Square stay there,
and their payments keep recording. While it's off, staff see "Square sending is off — Tabitha
turns it on in Billing settings."

## Your $1 test (you do this, not staff and not Claude)

1. Create a test client for yourself (your own name and an email you can open), or use your own
   client record.
2. **Create Invoice**: service Other, amount **$1.00**, due date one week out. Under payment
   options, check Square.
3. Approve it with **Also send through Square** checked.
4. On the invoice page, the Square card should show **Sent — unpaid** and a **Square payment page**
   link. Check that the invoice is also in your Square Dashboard → Invoices.
5. Open the email (or the client portal) and pay the $1 with your own card.
6. Within a minute, the invoice should show **Paid**, with a payment from **Square** in its
   history and on **Reconcile Square**. If it doesn't, press **Refresh from Square**, or wait for
   the hourly check. Then look at Square Dashboard → Developer → Webhooks → Logs.
7. Refund the $1 in Square. Then record the refund on the invoice (Record payment → Refund given).
8. Optional: make a second $1 invoice, send it through Square, then void it. Confirm Square shows
   it as Canceled.

## Troubleshooting

- **"Square didn't accept this invoice: …"**: the message comes from Square. Nothing was charged,
  and pressing Send via Square again is safe: it resumes and never duplicates.
- **Paid in Square but not here**: press **Refresh from Square** on the invoice, or **Check Square
  now** on Reconcile Square. Also check that `SQUARE_WEBHOOK_SIGNATURE_KEY` and the webhook URL
  match the dashboard. A mismatched key is refused with HTTP 403 in Square's webhook logs.
- **Canceled in Square directly**: the invoice page says so. Void it here, or send it through
  Square again, which creates a new Square invoice.
- **Unmatched Square payments**: Square notifies Client Connect of every payment in your account.
  These are set aside without a review item:
  - payments from customers linked under Square billing (your recurring billing)
  - payments on invoices sent through Client Connect

  Anything else shows under "Unmatched" for staff to apply to an invoice or mark reviewed.
