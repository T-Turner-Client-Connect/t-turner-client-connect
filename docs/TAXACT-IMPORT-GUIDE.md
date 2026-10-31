# TaxAct client import and historical returns: staff guide

For Daria and anyone importing TaxAct clients into Client Connect.

**Nothing here contacts a client.** Imports never send invitations, emails or texts. They never mark anyone as opted in to messages. They never create portal logins. Invitations are sent only when Tabitha asks for them, one client at a time, from the client's **Portal** tab.

## What is deployed today

| Feature | Where | Status |
|---|---|---|
| Contact import (CSV or XLSX) with column mapping, preview, duplicate review | **Clients → Import contacts** (`/imports/new`) | On `main` |
| TaxAct e-file status import (accepted, rejected and similar, matched by TaxAct client ID) | **Imports → Import TaxAct e-file statuses** (`/imports/tax`) and **Workflows** | On `main` |
| Staff upload of returns and documents to a client and tax year | Client record → **Documents** tab → *Upload document* | On `main` |
| Client view of published returns | Portal → **My Tax Center → Retrieve Tax Filings** | On `main` |
| Direct TaxAct connection | — | **Doesn't exist.** Nothing is pulled from TaxAct automatically. |

## Part 1 — Export the client list from TaxAct Professional

TaxAct Professional's **Client Manager** can export your client list to a CSV (comma-separated) or tab-delimited file using a customizable export query ([TaxAct: Client Manager](https://www.taxact.com/professional/products/features/client-manager?yr=2025)). Exports are started from **File → Export Client(s)** in Client Manager. The exact items on that menu vary by edition and year: for example, *Comprehensive 1040 Export* in the 1040 edition ([TaxAct support](https://www.taxact.com/support/24414/2016/exporting-a-client-file-from-taxact-for-hd-vests-1040-analyst)). If your menu looks different, use the export query option that lets you pick columns, or ask TaxAct support for "export client list to CSV".

Include **only** these columns: first name, last name, business name (for business returns), email, phone, street address, city, state, ZIP. **Don't include** SSNs, EINs, dates of birth, income, bank details or dependents. Client Connect blocks those columns automatically, but keep them out of the file anyway.

Save the file somewhere private (not email or a shared drive) and delete it once the import is finished.

A sample of the layout Client Connect expects is in [`docs/samples/client-import-sample.csv`](samples/client-import-sample.csv). Its rows are fictional.

## Part 2 — Import a test batch first

1. Open the export in Excel and save a copy with just **5–10 rows**. This is your test batch.
2. To mark everyone in the file as tax clients, add two columns to the copy:
   - **Services**: `Individual tax preparation` (or `Business tax preparation` for business returns). Use these exact words; they're the office's service names.
   - **Groups**: e.g. `Tax Clients 2025`. A group makes the batch easy to find and filter later.
3. In Client Connect go to **Clients → Import contacts**.
4. **1. Choose the export file:** pick the test file. In **Source**, type something like `TaxAct 2025 client list — test batch`. The file is read in your browser; only the columns you map are sent.
5. **2. Match columns to CRM fields:** for each column choose the matching field, or leave it unmapped:
   - First name → First name, Last name → Last name. If TaxAct gives one name column, use *Full name (split into first/last)*.
   - Business name → Business name.
   - Email → Email; Phone → *Phone (mobile preferred)*.
   - Address, City, State, ZIP → the matching address fields.
   - Client type → *Client type (Individual / Business / Nonprofit)*, if you added it.
   - Services → *Services (comma-separated)*; Groups → *Groups (comma-separated)*.
6. **3. Preview** → **Check for errors & duplicates**. Nothing is saved until you confirm on the next screen.
7. **Review import:** every row gets a decision. Rows that look like an existing client (same email, phone or name) list that client as a candidate:
   - **Create a new client** — only when you're sure this person isn't already in the CRM.
   - **Update _existing client_** — the same person. Choose *Only fill in blank fields (safest)* unless the file is newer and more correct than the CRM.
   - **Skip this row** — when unsure. You can add the person by hand later.

   Tags, services and groups are only ever **added**. Opt-outs and permission history are never changed by an import.
8. When no rows are left undecided, click **Import _N_ rows**. **Discard import** cancels everything, and nothing is changed.
9. Check the result: open two or three of the imported clients and confirm name, contact details, services and group. Then run the rest of the file the same way. Batches of a few hundred keep the duplicate review manageable.

Every import records the date, the source and who ran it, under **Imports**.

## Part 3 — E-file statuses (optional)

To show whether a return was submitted, accepted or rejected, export the e-file status report from TaxAct as CSV. Import it at **Imports → Import TaxAct e-file statuses**.
- Map the TaxAct client ID column; rows are matched **by that ID, never by name alone**. A row with an unknown ID can be matched to a client by hand. Leave *Save the TaxAct client ID on clients I matched by hand* ticked, so next time they match automatically.
- Click **Apply statuses** once every row has a decision.
- A row older than what's already recorded never overwrites a newer status.
- Clients are told nothing automatically; staff publish filing updates separately.

## Part 4 — Upload historical returns to the right client and year

1. Open the client: **Clients → search → client**. Check the name and, for a business, that you're on the right business tab.
2. Go to the **Documents** tab → **Upload document**.
3. Fill in:
   - **File:** the PDF of the return (up to 5 MB).
   - **Title:** e.g. `2023 Form 1040 — as filed`.
   - **Category:** Taxes.
   - **Tax year:** the year *of the return* (a 2023 return filed in 2024 is **2023**). Required.
   - **Tax document type:** *Federal return*, *State return*, *Amended return*, *Acceptance notice (IRS/state)* or *Extension confirmation*. Federal, state and amended returns appear separately for the client. This label never marks a return accepted.
   - **Visibility:**
     - *Staff-only draft* keeps it internal.
     - *Publish to the client's portal* shows it after the malware scan passes, and the client is notified when notifications are on.
4. **Upload document.** One return per upload, so each has its own year and type.
5. Clients see published returns under **My Tax Center → Retrieve Tax Filings** for that year. Past-year records open only after the client's login is verified: by email, or by staff confirming identity on the Portal tab.

Don't upload Social Security cards or birth certificates here. Those go only through **Identity Documents** and are Admin-only.

## Quick checks after an import
- **Clients → filter by group** (e.g. *Tax Clients 2025*) shows the expected count.
- No client received an invitation: their **Portal** tab shows no invitation.
- **Imports** lists the batch with your name and the source you typed.
