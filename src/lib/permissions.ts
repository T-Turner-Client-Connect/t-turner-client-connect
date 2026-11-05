/**
 * Staff Access & Permissions — the catalog. Pure data (no database, no "server-only") so the
 * Owner's Office screen and the server checks read the same list.
 *
 * A grant is one row per staff member, area and action (StaffPermission). No row = denied.
 * The primary owner (Tabitha's OwnerAccess, isPrimary) holds every action, always, and has no rows.
 *
 * ownerOnly actions are shown in the matrix but can never be granted: they stay Tabitha's alone.
 * reserved actions are grantable now but nothing in Client Connect uses them yet; they're listed so
 * the screen covers every area and a future screen is gated from day one.
 */

export const ACTION_LABELS = {
  view: "View",
  create: "Create",
  edit: "Edit",
  approve: "Approve",
  send: "Send",
  manage: "Manage",
  record_payment: "Record payments",
  reconcile: "Reconcile",
  refund: "Refund",
  void: "Void",
  adjust: "Credits & waivers",
  delete_history: "Delete history",
  integrations: "Change integrations",
  settings: "Change billing settings",
  all_clients: "All clients",
} as const;

export type PermAction = keyof typeof ACTION_LABELS;

export type ActionDef = { key: PermAction; description: string; ownerOnly?: true; reserved?: true };
export type AreaDef = { key: string; label: string; description: string; actions: ActionDef[] };

export const AREAS = [
  {
    key: "billing",
    label: "Billing and invoicing",
    description: "Quotes & invoices, Create Invoice, payment plans and Pay by Refund.",
    actions: [
      { key: "view", description: "Open Quotes & invoices, Payment plans and Pay by Refund; see invoice balances and payment history." },
      { key: "create", description: "Create invoices and itemized quotes for the firm's clients (as drafts)." },
      { key: "edit", description: "Edit drafts, submit them for approval, choose a client's payment method, set Pay by Refund amounts." },
      { key: "approve", description: "Approve or decline payment plans and payment-method change requests; override a service's payment gate." },
      { key: "send", description: "Approve and send invoices to the client's portal; send or withdraw quotes." },
      { key: "record_payment", description: "Record verified payments (and failed attempts) once funds have arrived. A payment that clears the balance marks the invoice Paid." },
      { key: "refund", description: "Record refunds to clients." },
      { key: "void", description: "Void invoices." },
      { key: "adjust", description: "Apply balance credits and waive late fees (not cash)." },
      { key: "delete_history", description: "Delete payment history. Nothing in Client Connect deletes payment history today: corrections are added as new lines, so this gates nothing yet.", reserved: true },
      { key: "settings", description: "Change billing settings: quote and plan defaults, late-fee policy, payment-method fees, package prices and the Refund Transfer fee note." },
    ],
  },
  {
    key: "square",
    label: "Square and payment information",
    description: "Bookkeeping billing cards (card on file from Square), Square links and the approved payment methods.",
    actions: [
      { key: "view", description: "See bookkeeping billing, Square billing and the card on file (brand and last four, as Square returns them); check the Square connection." },
      { key: "edit", description: "Link clients to Square, record recurring-charge authorizations, billing notes and recurring billing not in Square." },
      { key: "integrations", description: "Change payment integrations: turn Square links on invoices on or off and choose which payment methods are approved, with their instructions." },
    ],
  },
  {
    key: "receivables",
    label: "Accounts receivable",
    description: "Who owes what, aging, and matching payments to confirmed records.",
    actions: [
      { key: "view", description: "See balances owed and aging (Who owes me) and export invoices, payments and receivables." },
      { key: "reconcile", description: "Reconcile payments against confirmed Square, bank or other payment records: record Refund Transfer deposits, mark not received, undo a mistaken deposit." },
    ],
  },
  {
    key: "revenue",
    label: "Revenue and expenses",
    description: "The Overview's monthly totals and the Expenses tab.",
    actions: [
      { key: "view", description: "See the Overview (invoiced, collected, expenses), expenses and receipts, and export the summary." },
      { key: "create", description: "Add expenses and receipts." },
      { key: "edit", description: "Remove expenses." },
    ],
  },
  {
    key: "payroll",
    label: "Payroll",
    description: "Business clients' payroll approvals (Owner's Office → Payroll approvers). Owners approve their own payroll; staff never approve on a client's behalf.",
    actions: [
      { key: "view", description: "See payroll.", reserved: true },
      { key: "edit", description: "Choose which business owners approve each business's payroll, which approvals are required, and whether they see per-employee figures." },
      { key: "approve", description: "Approve payroll runs.", reserved: true },
    ],
  },
  {
    key: "payroll_taxes",
    label: "ADP Payroll & Taxes",
    description: "The ADP Payroll & Taxes workspace (sidebar): payroll schedules, workups, client approvals, reminders. Only the owner grants it. Nothing in it submits payroll, files taxes or moves money.",
    actions: [
      { key: "view", description: "Open the workspace and see the work queue, due dates, approvals and completed work for the clients assigned to them (read-only)." },
      { key: "manage", description: "Do the work for every client: schedules, assignments, hours, workups, sending for client approval, recording Submitted in ADP and Processed, reminder settings." },
      { key: "all_clients", description: "With View: see every client's payroll, not only the clients assigned to them." },
    ],
  },
  {
    key: "banking",
    label: "Banking and reconciliation",
    description: "Bank feeds and reconciliations in managed clients' books.",
    actions: [
      { key: "view", description: "See bank connections, imported transactions and reconciliations for every managed client (not only assigned ones)." },
      { key: "edit", description: "Connect banks, map accounts, import and reconcile for every managed client." },
    ],
  },
  {
    key: "ledger",
    label: "General ledger",
    description: "Managed clients' books (accounts, journal entries, reports).",
    actions: [
      { key: "view", description: "Open every managed client's books (Admins and the assigned staff member already can)." },
      { key: "edit", description: "Post and change entries, accounts and invoices in every managed client's books." },
      { key: "approve", description: "Close books, reopen a closed period, change a client's reporting basis. Tabitha only.", ownerOnly: true },
    ],
  },
  {
    key: "statements",
    label: "Financial statements",
    description: "Financial statements and packets prepared for clients.",
    actions: [
      { key: "view", description: "See prepared statements and packets.", reserved: true },
      { key: "create", description: "Prepare statements.", reserved: true },
      { key: "approve", description: "Approve financial reports for delivery. Tabitha only.", ownerOnly: true },
    ],
  },
  {
    key: "clients",
    label: "Client records and documents",
    description: "Client files seen from the Owner's Office. Identity documents keep their own Admin grant (Settings → Team).",
    actions: [
      { key: "view", description: "See client records from the Owner's Office.", reserved: true },
      { key: "edit", description: "Change client records from the Owner's Office.", reserved: true },
    ],
  },
  {
    key: "tax",
    label: "Tax preparation and compliance",
    description: "Tax-season work handled in the Owner's Office.",
    actions: [
      { key: "view", description: "See tax preparation and compliance status.", reserved: true },
      { key: "edit", description: "Prepare tax work.", reserved: true },
      { key: "approve", description: "Authorize and submit returns and release returns to clients. Tabitha only.", ownerOnly: true },
    ],
  },
  {
    key: "business_access",
    label: "Business access management",
    description: "Regular Tax Client ↔ Managed Business conversions.",
    actions: [
      { key: "view", description: "Open the Business access tab and see pending requests." },
      { key: "approve", description: "Approve or decline Managed Business requests." },
      { key: "manage", description: "Remove a client's Managed Business access and choose which staff may request conversions." },
    ],
  },
  {
    key: "coetha",
    label: "Coetha AI",
    description: "Coetha prepares and recommends; she never posts or finalizes accounting entries on her own.",
    actions: [
      { key: "view", description: "Open Coetha for any bookkeeping client (Admins and the assigned staff member already can)." },
      { key: "create", description: "Ask Coetha to prepare entries, categorizations, reconciliations and proposed statements for review.", reserved: true },
      { key: "approve", description: "Approve Coetha's work (entries, categorizations, reconciliations, proposed statements). Tabitha only — never grantable.", ownerOnly: true },
    ],
  },
  {
    key: "appointments",
    label: "Appointment calendar",
    description: "The owner's booking calendar (kept from the old full-access tab).",
    actions: [
      { key: "view", description: "Open the Appointments tab." },
      { key: "approve", description: "Approve, decline, reschedule or cancel booking requests." },
      { key: "manage", description: "Publish months, block dates, change booking settings and staff availability." },
    ],
  },
  {
    key: "staff",
    label: "Staff management",
    description: "This screen: who can open which part of the Owner's Office.",
    actions: [
      { key: "view", description: "See this screen (read-only)." },
      { key: "manage", description: "Change other staff members' permissions — only actions they hold themselves, never Owner, never their own row or the owner's, and never Staff management itself." },
    ],
  },
  {
    key: "integrations",
    label: "Integrations and system settings",
    description: "Connected services and office-wide settings.",
    actions: [
      { key: "view", description: "See which integrations are connected (Square, email, texting, bank feeds).", reserved: true },
      { key: "manage", description: "Change integration and system settings.", reserved: true },
    ],
  },
] as const satisfies readonly AreaDef[];

export type Area = (typeof AREAS)[number]["key"];
export type PermKey = `${Area}.${PermAction}`;

export const keyOf = (area: Area, action: PermAction) => `${area}.${action}` as PermKey;

const ALL: { area: Area; def: ActionDef }[] = AREAS.flatMap((a) => (a.actions as readonly ActionDef[]).map((def) => ({ area: a.key as Area, def })));

export const ALL_KEYS = ALL.map((x) => keyOf(x.area, x.def.key));
/** Never grantable to anyone: the primary owner alone holds these. */
export const OWNER_ONLY_KEYS = ALL.filter((x) => x.def.ownerOnly).map((x) => keyOf(x.area, x.def.key));
export const GRANTABLE_KEYS = ALL_KEYS.filter((k) => !OWNER_ONLY_KEYS.includes(k));
/** Only the owner can give these, even to someone a delegated staff manager could otherwise change. */
export const OWNER_GRANTS_ONLY: PermKey[] = ["staff.manage", "payroll_taxes.view", "payroll_taxes.manage", "payroll_taxes.all_clients"];

export function isKnownKey(k: string): k is PermKey {
  return (ALL_KEYS as string[]).includes(k);
}

export function areaOf(key: string) {
  const [area, action] = key.split(".");
  const a = AREAS.find((x) => x.key === area);
  const d = (a?.actions as readonly ActionDef[] | undefined)?.find((x) => x.key === action);
  return a && d ? { area: a, action: d } : null;
}

export function labelOf(key: string) {
  const f = areaOf(key);
  return f ? `${f.area.label} → ${ACTION_LABELS[f.action.key]}` : key;
}

/** The known keys among `keys`, deduplicated, in catalog order. Grants are exactly what's ticked. */
export function normalizeKeys(keys: Iterable<string>): PermKey[] {
  const set = new Set(keys);
  return ALL_KEYS.filter((k) => set.has(k));
}

export type Preset = { key: string; label: string; description: string; keys: PermKey[] };

/**
 * Quick presets. Applying one REPLACES the staff member's grants with exactly this set
 * (the history records every change). Nothing is applied automatically.
 */
export const PRESETS: Preset[] = [
  {
    key: "billing_clerk_daria",
    label: "Billing clerk (Daria's request)",
    description:
      "Create invoices for the firm's clients, edit drafts, send invoices, see balances and payment history, record verified payments (marking an invoice paid once funds arrive) and reconcile payments against confirmed Square or other records. No refunds, voids, deleting payment history, payment integrations, billing settings or Coetha approval.",
    keys: [
      "billing.view",
      "billing.create",
      "billing.edit",
      "billing.send",
      "billing.record_payment",
      "receivables.view",
      "receivables.reconcile",
      "square.view",
    ],
  },
  {
    key: "billing_drafts",
    label: "Billing drafts only (old “Billing only” access)",
    description: "What “Billing only” Owner's Office access allowed before: prepare and submit drafts, record payment-plan payments and Refund Transfer deposits. The owner approves and sends.",
    keys: ["billing.view", "billing.create", "billing.edit", "billing.record_payment", "receivables.reconcile"],
  },
  {
    key: "bookkeeping_billing",
    label: "Bookkeeping billing (old Settings toggle)",
    description: "What “Bookkeeping billing: allowed” gave: bookkeeping billing cards, Square billing links, charge authorizations and recurring billing not in Square.",
    keys: ["square.view", "square.edit"],
  },
  { key: "none", label: "No access", description: "Remove every Owner's Office permission.", keys: [] },
];

/** Daria's billing-clerk preset, for tests and the screen. */
export const DARIA_PRESET = PRESETS[0];
