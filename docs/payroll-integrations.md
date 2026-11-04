# Payroll: ADP and Paychex — setup guide for Tabitha

This guide covers three things:

- what works today
- what each client business does to give the firm access
- what you file with ADP and Paychex so payroll data can arrive automatically

Anything I couldn't confirm from ADP's or Paychex's own published pages is marked **(unverified)**. Check those points with ADP or Paychex before relying on them.

---

## 1. Where each piece stands

| Piece | Status |
|---|---|
| Payroll provider setup per business: system, pay frequency, connection method, accountant access (Payroll page) | **Operational** |
| Payroll register import (ADP RUN, ADP Workforce Now, Paychex Flex, or any layout mapped by hand). Handles CSV and Excel .xlsx files, previews totals per pay date, and skips duplicates. | **Operational** |
| A draft journal entry for each pay date. It's posted only when staff click Post, and the closed-period lock still applies. | **Operational** |
| The register file is kept in the client's documents as a Payroll report. The month checklist updates: "Payroll reports" is marked received, and "Record payroll" is marked done when everything is posted. | **Operational** |
| Pay history, last pay date and next pay date come from imported data (Payroll page and the Client Overview Payroll card). | **Operational** |
| Payroll approval by business owners. Covers required and optional approvers, versioning, approve/deny, the timeline and the staff task on a denial. | **Operational** |
| Approval requests by text and/or email (each owner chooses), secure single-use links, and identity confirmation before a decision | **Operational in the app.** Email needs the email provider (Resend), which is already part of Client Connect. Texts also need Twilio, your client-texting switch, and the owner's service-text consent. |
| "Submit to ADP/Paychex" button | **Operational as a recorded step.** For now it records that the office submitted the payroll in ADP or Paychex. Sending it through the API needs outside authorization (section 4). |
| Direct ADP connection (payroll data flows in automatically) | **Needs outside authorization.** You need ADP partner approval plus each client's consent. The code is a disabled skeleton until then. |
| Direct Paychex connection | **Needs outside authorization.** You need Paychex partner approval plus each client's approval in Paychex Flex. The code is a disabled skeleton until then. |
| Automatic fetch and the API "submit" | **Still in development.** It will be finished once ADP/Paychex give production documentation and credentials. Their exact endpoints can't be verified before approval, so none were guessed. |

Two rules apply however the data arrives (register import or, later, API):

- **Payroll entries are always created as drafts awaiting review.** Nothing posts to the books by itself.
- **Fully approved payroll is never released automatically.** A staff payroll operator submits it.

If a payroll entry was produced by **Coetha**, only you can post or submit it. Owners approve their own company's payroll, and that is separate from your approval of Coetha's accounting work.

---

## 2. What works today: export the payroll register and import it

### ADP RUN (small business)

**Who does it:** the client, or you through **ADP Accountant Connect** once the client has given you access.

1. Sign in to RUN and open **Reports**. In some versions it's **Reports & Analytics** (unverified label).
2. Open the **Payroll Register** report. Some versions call it **Payroll Details** or **Payroll Summary** (unverified label).
3. Set the date range to cover the check date(s) you want.
4. Choose **Export to Excel**, or CSV if offered. ADP's RUN guides say reports can be exported to Excel, and custom reports to PDF, CSV or Excel. Don't use PDF: it can't be imported.

### ADP Workforce Now (larger clients)

1. Go to **Reports → Payroll Reports → Payroll Register**, or build a custom report in **Reports & Analytics** (menu path unverified).
2. Filter by pay date and export as Excel or CSV.
3. Make sure the report includes these columns:
   - pay date
   - employee name
   - hours
   - gross pay
   - each employee tax: federal, Social Security, Medicare, state, local
   - deductions
   - net pay
   - employer taxes: ER Social Security, ER Medicare, FUTA, SUI

### Paychex Flex

1. Go to **Reports**, then the **Payroll Journal** (menu path unverified). Reviews of Paychex Flex describe the Payroll Journal as the detailed record of each payroll run, and say Flex reports export to Excel.
2. Choose the check date(s) and export to **Excel**.

### Import into Client Connect

1. Open the client → **Payroll & ADP** → **Import a payroll register**.
2. Choose the file, then pick the layout: ADP RUN, ADP Workforce Now, Paychex Flex, or Other.
3. Click **Preview**. The preview shows two things:
   - How each column was read. You can change any column here; use **Other** for unusual layouts.
   - The totals for each pay date: gross, employee taxes, deductions, net pay, employer taxes and total cost.
   - A pay date only passes if gross − employee taxes − deductions = net pay. A pay date that doesn't tie out is shown and *not* imported.
4. Choose the bank account net pay comes out of.
5. Tick **Already processed and paid by the provider** if this is past payroll. Leave it unticked for an upcoming payroll that owners should approve first.
6. Click **Create draft pay runs**. Importing the same file again creates nothing new. Duplicates are matched on provider + check date + totals.
7. Open each pay run. Check the draft journal entry, then **Post journal entry to the books**:
   - Debit: Wages & Salaries (gross wages)
   - Debit: Payroll Tax Expense (employer taxes)
   - Credit: Bank (net pay)
   - Credit: Payroll Taxes Payable (each withholding and the employer share, as separate lines)
   - Credit: Payroll Deductions Payable (deductions)

   Accounts 7010, 7020, 2200 and 2210 are added to the client's chart if they're missing. When ADP or Paychex later withdraws the taxes from the bank, categorize that bank row to **Payroll Taxes Payable**.

The presets recognize column names commonly seen in each provider's exports. **Neither ADP nor Paychex publishes a fixed file specification for these reports**, so always glance at the mapping before importing.

---

## 3. Accountant access: what each client does

### ADP RUN → ADP Accountant Connect

Accountant Connect is ADP's free dashboard for accounting firms. It gives the firm single sign-on access to its RUN clients' payroll reports and tax forms. ADP states this on adp.com/accountants.

1. **You** sign up the firm for Accountant Connect at adp.com/accountants. ADP's partner line is listed as 844-400-1237 (unverified that this is the right line).
2. From your Accountant Connect dashboard, **send an access invitation** to each existing RUN client. ADP says firms can request access to existing RUN clients from the dashboard.
3. **The client accepts** the invitation in RUN. The exact screen is unverified.
4. Record it on the client's Payroll page: **Accountant access → Accountant access granted**.

### ADP Workforce Now

There's no Accountant Connect for Workforce Now (unverified). The client's practitioner adds you as a user with a reporting-only role under **Setup → Security**. The menu path is unverified.

### Paychex Flex

1. The client's Flex administrator adds you as a user with **reporting access only**, with payroll processing turned off. Third-party guides describe this under **People → Add → user / accountant role**; the exact labels are unverified.
2. Access is granted one company at a time. You accept the email invitation and finish your profile.
3. Paychex also offers firm programs for accountants (**AccountantHQ**, unverified as currently offered).
4. Record the status on the client's Payroll page.

---

## 4. Full API integration: what you must file

### ADP

**What exists:**

- **ADP Marketplace partner program** with **data connectors**. This is what a firm uses to read clients' data, and it's how other products read RUN payroll.
- **ADP API Central**. The *client* buys this for its own Workforce Now data.

ADP's published APIs include a **Pay Statements API**: every pay statement for a worker, with earnings, deductions and taxes. Marketplace connectors for RUN read pay period dates, earnings, deductions and taxes withheld. Whether every register field is available for RUN through a connector is **unverified** until ADP grants documentation.

**What you file:**

1. **Apply to the ADP Marketplace partner program** at partners.adp.com.
   - ADP screens applications for "strategic fit" and looks for a substantial number of shared clients.
   - You accept a **mutual non-disclosure agreement** and a **sandbox agreement**.
2. **Pass ADP's security review.**
   - ADP's security team reviews your security program. A "fast-track/pre-approval" path exists.
   - Expect questions about how Client Connect stores data: encryption, access control, audit logs. The app already has these, so I can help answer.
3. **Create the connector listing.**
   - Submit draft integration specs and pricing. You may set the client-facing price to **$0**.
   - ADP requires both a "Core/eCommerce" listing and a "Connector" listing. ADP then reviews and approves the listing.
4. **Get production credentials** in ADP's Developer Self-Service Portal:
   - an OAuth **client ID** and **client secret**
   - a **mutual-TLS certificate**: a private key plus a certificate ADP signs, valid for 2 years, renewal notice 60 days before expiry
   - The private key is shown **only once** when it's generated. Save it immediately.

**Costs:**

- ADP doesn't publish partner fees. ADP job postings mention revenue share, implementation, administrative and usage-based fees, so expect a contract (amounts unverified).
- One partner reports a $10/month connector fee charged to the client.
- With a $0 price, the client may pay nothing (unverified).

**Timeline:** not published. Plan on several weeks to a few months for the security review and listing approval (unverified).

**What each ADP client does:**

- The client **buys or enables your connector** in the ADP Marketplace. This consent step authorizes the firm.
- If you skip the Marketplace for a Workforce Now client, the client buys **API Central** and creates a project for you instead.

### Paychex

**What exists:**

- The **Paychex Flex API** for **Integrated Partners**, at developer.paychex.com.
- Access is partner-gated. Approved partners get a free **sandbox** during certification.

**What you file:**

1. **Apply to become a Paychex Integrated Partner.** Developers apply to become a partner, or build an integration for a specific Flex client.
   - Pricing and revenue share are set by contract.
2. **Complete certification** in the sandbox.
3. Receive production **API credentials** (client ID and secret).

**Timeline:** a third-party review says weeks to months (unverified).

**What each Paychex client does:**

1. The firm requests access using the client's **8-digit Paychex company display ID**. Paychex returns a link for the client.
2. The client's **Flex administrator** opens **Company Settings → Integrated Applications**. The app shows **"Access Requested."**
3. The administrator **approves it** and agrees to the third-party terms.

**Data:** company, workers, and payroll / pay check data. Coverage leans toward reads, and there are no webhooks, so we'd check on a schedule (third-party source, unverified).

### What I'll do once you're approved

1. You give me the production credentials. I never need your password. Set them in **Netlify → Site configuration → Environment variables**:
   - ADP: `ADP_CLIENT_ID`, `ADP_CLIENT_SECRET`, `ADP_CERT` (the PEM certificate text) and `ADP_KEY` (the PEM private key)
   - Paychex: `PAYCHEX_CLIENT_ID`, `PAYCHEX_CLIENT_SECRET`
2. Using the documentation ADP and Paychex provide after approval, I implement the fetch in the adapters (`src/lib/payroll/providers.ts`). It's marked TODO today and isn't used anywhere in the app.
3. Each client authorizes the connection (above). On their Payroll page the status changes from "Not connected — requires … partner approval" to "Connected".
4. **What then becomes automatic:**
   - New pay runs arrive on a schedule.
   - They go through the same path as an import: a draft pay run, a draft journal entry, the payroll report checklist and pay history.
   - Owner approval requests go out automatically when the office sends a run for approval.
5. **What stays a person's decision:**
   - posting the journal entry (staff)
   - approving payroll (the business owners you designate)
   - submitting payroll to ADP or Paychex (the payroll operator)
   - anything Coetha produced (you only)

---

## 5. Payroll approval by business owners

### Choosing approvers

You, or staff you give billing access in the Owner's Office, open **Owner's Office → Payroll approvers**:

- Mark each owner as **Required approver**, **Approver (optional)** or **Not an approver**.
- If no one is marked required, every approver must approve.
- Turn per-employee figures on or off for each owner.

Owners never change these settings. Every change is recorded.

### Sending payroll for approval

On the pay run, the office clicks **Send for owner approval**:

- Each approver gets a **text and/or email** with a secure link: "Payroll for {business} ({period}, pay date …, total …) needs your approval."
- The message never includes employee details.
- Each owner chooses **Text, Email, or both** on their **Payroll Approval** page. Staff can change it at the client's request.
- If a text can't be sent, the request goes to email instead and the owner sees why. A text can't be sent when:
  - client texting is off,
  - there's no consent on file, or
  - the number replied STOP.
- Texts are held during quiet hours (8 a.m.–8 p.m. Central).

### The secure link

- It works **once**, for **that owner and that version**, for **72 hours**.
- If the owner isn't already signed in on that phone, they first confirm it's them with a **6-digit emailed code** (or password + authenticator app).
- Replying "APPROVE" by text never counts. The owner gets a fresh secure link instead.

### Approving or denying

- **Approve:** when every required owner has approved the **same version**, the run is **Fully Approved**. It is *not* released.
- **Deny:** the run goes back to the office as **Denied — Needs Review**, and the assigned staff member gets a task.
- Each decision is recorded permanently:
  - who
  - the decision
  - when
  - the comment
  - the channel (portal or text/email link)
  - how identity was confirmed
  - IP address and device

### When the office changes a run

A change creates a **new version**. Earlier approvals stop counting, old links stop working, and the run must be sent again.

### Submitting

- The payroll operator clicks **Submit to ADP/Paychex** after doing it in the provider.
- After that the run is locked: no more approvals, decisions or changes.

The business-owners work (per-owner portal permissions) is on another branch. When both are merged, it plugs in through one check, `isPayrollApprover()`.

---

## Sources

- ADP Accountant Connect (adp.com/who-we-serve/by-partner/accountants/accountant-connect.aspx) and adp.com/accountants
- ADP RUN report export guides (support.adp.com "how to access payroll and tax reports"; "Custom Reports How to Guide")
- ADP Marketplace partner guides (partners.adp.com; marketplace.adp.com "becoming a partner", "Partner Development Learning Guide")
- ADP Pay Statements API guide (marketplace-cdn.adp.com)
- Third-party integration notes on ADP mutual TLS and certificates (CData)
- Paychex developer "Integrate with Paychex clients" (developer.paychex.com/getting-started/integrate-with-paychex-clients). Fetched through search summaries; the page itself couldn't be opened from this environment.
- CPA Practice Advisor reviews of Paychex Flex (Excel export, Payroll Journal)
