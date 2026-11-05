/**
 * FICTIONAL demo data for the ADP Payroll & Taxes workspace (local development and screenshots).
 *
 *   DATABASE_URL=postgresql://…@localhost:5432/<local db> npx tsx --tsconfig scripts/tsconfig.seed.json scripts/seed-payroll-taxes-demo.ts
 *
 * Refuses to run when NODE_ENV=production, on Netlify, or when the DATABASE_URL host isn't local.
 * Everything it creates is clearly fictional ("(FICTIONAL)" businesses, example.com addresses,
 * 555-01xx numbers). It sends nothing: notifications stay off and no provider is configured.
 */
const url = process.env.DATABASE_URL ?? "";
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data with NODE_ENV=production.");
if (process.env.NETLIFY || process.env.CONTEXT) throw new Error("Refusing to seed demo data on Netlify.");
let host = "";
try {
  host = new URL(url).hostname;
} catch {
  throw new Error("Set DATABASE_URL to a local Postgres database.");
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error(`Refusing to seed demo data into a non-local database (${host}).`);
// Nothing leaves this machine while seeding.
process.env.NOTIFICATIONS_ENABLED = "false";
for (const k of ["RESEND_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "ADP_CLIENT_ID", "PAYCHEX_CLIENT_ID"]) delete process.env[k];

async function main() {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const { prisma } = await import("@/lib/prisma");
  const { hashPassword } = await import("@/lib/auth/password");
  const { setStaffPermissions } = await import("@/lib/auth/permissions");
  const { createClient } = await import("@/lib/services/clients");
  const { saveProfile } = await import("@/lib/services/bookkeeping-clients");
  const { savePayrollSetup, loadRun } = await import("@/lib/services/payroll");
  const { decidePayroll, setPayrollApprover } = await import("@/lib/services/payroll-approval");
  const { addDays, onOrBeforeBusinessDay, weekday } = await import("@/lib/payroll/schedule");
  const svc = await import("@/lib/services/payroll-taxes");
  const { todayCentral } = await import("@/lib/services/ledger");
  type Actor = { id: string; role: "ADMIN" | "STAFF"; name: string; email: string };

  if (await prisma.client.count({ where: { businessName: "Magnolia Bakery Co. (FICTIONAL)" } })) {
    console.log("Demo data is already here (Magnolia Bakery Co. (FICTIONAL) exists). Nothing changed.");
    return;
  }

  const pdf = async (title: string, lines: string[]) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("FICTIONAL DEMO — NOT A REAL ADP DOCUMENT", { x: 50, y: 740, size: 12, font });
    page.drawText(title, { x: 50, y: 710, size: 16, font });
    lines.forEach((l, i) => page.drawText(l, { x: 50, y: 680 - i * 18, size: 11, font }));
    return { bytes: await doc.save(), fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf` };
  };

  const password = await hashPassword("Demo-Only-Pass-1");
  const staff = async (email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> => {
    const u = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash: password, mfaEnabledAt: new Date() } });
    return { id: u.id, role: u.role, name: u.name, email: u.email };
  };

  // The owner: an existing primary owner if this local database has one, else a fictional one.
  const existingOwner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, include: { user: true } });
  const owner: Actor = existingOwner
    ? { id: existingOwner.user.id, role: existingOwner.user.role, name: existingOwner.user.name, email: existingOwner.user.email }
    : await staff("demo.owner@example.com", "Tabitha Demo (FICTIONAL)", "ADMIN");
  if (!existingOwner) await prisma.ownerAccess.create({ data: { userId: owner.id, isPrimary: true, scope: "FULL" } });
  const mom = await staff("demo.payroll@example.com", "Payroll Desk Demo (FICTIONAL)", "STAFF");
  const viewer = await staff("demo.viewer@example.com", "Vera Viewer (FICTIONAL)", "STAFF");
  await staff("demo.noaccess@example.com", "Sam NoAccess (FICTIONAL)", "STAFF");
  await setStaffPermissions(owner, mom.id, ["payroll_taxes.view", "payroll_taxes.manage"], "demo-seed");
  await setStaffPermissions(owner, viewer.id, ["payroll_taxes.view"], "demo-seed");

  const today = todayCentral();
  // Next Friday (or today if it's Friday) as the weekly anchor.
  let friday = today;
  while (weekday(friday) !== 5) friday = addDays(friday, 1);

  const businesses = [
    { name: "Magnolia Bakery Co. (FICTIONAL)", frequency: "WEEKLY", anchor: addDays(friday, -7), owners: ["Maggie Approver (FICTIONAL)", "Lou Approver (FICTIONAL)"], assigned: mom.id },
    { name: "Red Mountain Auto Detailing (FICTIONAL)", frequency: "BIWEEKLY", anchor: friday, owners: ["Rhett Owner (FICTIONAL)"], assigned: mom.id },
    { name: "Vulcan Fitness LLC (FICTIONAL)", frequency: "SEMIMONTHLY", anchor: `${today.slice(0, 7)}-15`, owners: ["Val Owner (FICTIONAL)"], assigned: viewer.id },
  ] as const;

  const out: Record<string, { clientId: string; portal: { id: string; name: string; email: string }[] }> = {};
  let n = 0;
  for (const b of businesses) {
    const client = await createClient(owner, { businessName: b.name, clientType: "BUSINESS", status: "ACTIVE", email: `office.${n}@example.com` });
    await prisma.client.update({ where: { id: client.id }, data: { businessAccess: "ACTIVE" } });
    await saveProfile(owner, client.id, { active: true, frequency: "MONTHLY", payroll: true, payrollFrequency: b.frequency, payrollProvider: "ADP" });
    await savePayrollSetup(owner, client.id, { system: "ADP_RUN", frequency: b.frequency });
    const portal = [];
    for (const [i, name] of b.owners.entries()) {
      const email = `${name.split(" ")[0].toLowerCase()}.${n}${i}@example.com`;
      const phone = `55501${n}${i}${String(100 + n * 10 + i).slice(-3)}`.slice(0, 10);
      const u = await prisma.portalUser.create({ data: { email, name, phone, passwordHash: password, emailVerifiedAt: new Date() } });
      await prisma.portalAccess.create({ data: { portalUserId: u.id, clientId: client.id, canViewBookkeeping: true } });
      const contact = await prisma.contact.create({ data: { clientId: client.id, name, email, emailNormalized: email } });
      await prisma.businessOwner.create({ data: { clientId: client.id, contactId: contact.id, portalUserId: u.id, ownershipBps: Math.floor(10000 / b.owners.length) } });
      await setPayrollApprover(owner, client.id, u.id, { approver: true, required: true });
      portal.push({ id: u.id, name, email });
    }
    await svc.saveSchedule(owner, client.id, {
      frequency: b.frequency, anchorPayDate: b.anchor, semiMonthlyDays: b.frequency === "SEMIMONTHLY" ? [15, 31] : [], periodEndLagDays: 5,
      hoursRequestLeadDays: 5, hoursDueDays: 3, approvalDueDays: 2, adpCutoffDays: 2, assignedStaffId: b.assigned, active: true, clientRemindersEnabled: b.frequency === "WEEKLY",
    });
    out[b.name] = { clientId: client.id, portal };
    n++;
  }

  const totals = { employees: 4, hours: 152, grossCents: 412500, employeeTaxCents: 61800, deductionsCents: 7500, netPayCents: 343200, employerTaxCents: 31600 };
  const meta = { channel: "PORTAL" as const, verifiedBy: "PORTAL_SESSION" as const, ip: "127.0.0.1", userAgent: "demo-seed" };
  const cycles = async (clientId: string) => prisma.payrollCycle.findMany({ where: { clientId }, orderBy: { payDate: "asc" } });

  // Magnolia: the first cycle is fully processed (v1 → denied → v2 → approved → processed);
  // the second is at v1, sent for approval (the E2E walk-through continues it).
  const mag = out["Magnolia Bakery Co. (FICTIONAL)"];
  const [m1, m2] = await cycles(mag.clientId);
  await svc.submitHoursByPortal(mag.portal[0].id, mag.clientId, m1.id, { employees: [{ name: "Fictional Baker A", regularHours: 40, overtimeHours: 3 }, { name: "Fictional Baker B", regularHours: 38 }], flags: ["BONUS"], notes: "Holiday bonus for Baker A (FICTIONAL)" });
  await svc.saveManualTotals(mom, m1.id, totals, await pdf("ADP payroll preview v1 (FICTIONAL)", ["Magnolia Bakery Co. (FICTIONAL)", "Pay date " + m1.payDate.toISOString().slice(0, 10), "Gross $4,125.00"]));
  await svc.sendForClientApproval(mom, m1.id);
  let run = (await prisma.payrollCycle.findUniqueOrThrow({ where: { id: m1.id } })).payrollRunId!;
  await decidePayroll(mag.portal[1].id, mag.clientId, run, { decision: "DENIED", comment: "Baker A's bonus should be $150, not $200 (FICTIONAL)", versionId: (await loadRun(mag.clientId, run)).version.id }, meta);
  await svc.saveManualTotals(mom, m1.id, { ...totals, grossCents: 407500, netPayCents: 338200, reason: "Bonus corrected per Lou's comment" }, await pdf("ADP payroll preview v2 (FICTIONAL)", ["Magnolia Bakery Co. (FICTIONAL)", "Corrected bonus", "Gross $4,075.00"]));
  await svc.sendForClientApproval(mom, m1.id);
  for (const p of mag.portal) await decidePayroll(p.id, mag.clientId, run, { decision: "APPROVED", versionId: (await loadRun(mag.clientId, run)).version.id }, meta);
  await svc.markSubmittedInAdp(mom, m1.id, "Submitted in ADP RUN (FICTIONAL demo)");
  await svc.markProcessed(mom, m1.id, await pdf("ADP payroll confirmation (FICTIONAL)", ["Magnolia Bakery Co. (FICTIONAL)", "Confirmation #DEMO-0001"]), { note: "ADP confirmation #DEMO-0001 (FICTIONAL)" });

  if (m2) {
    await svc.submitHoursByPortal(mag.portal[0].id, mag.clientId, m2.id, { noChanges: true, notes: "Same as last week (FICTIONAL)" });
    await svc.saveManualTotals(mom, m2.id, totals, await pdf("ADP payroll preview week 2 v1 (FICTIONAL)", ["Magnolia Bakery Co. (FICTIONAL)", "Gross $4,125.00"]));
    await svc.sendForClientApproval(mom, m2.id);
  }

  // Vulcan: v1 denied, waiting for a correction.
  const vul = out["Vulcan Fitness LLC (FICTIONAL)"];
  const [v1] = await cycles(vul.clientId);
  if (v1) {
    await svc.saveManualTotals(mom, v1.id, { ...totals, employees: 6, grossCents: 520000, employeeTaxCents: 78000, deductionsCents: 12000, netPayCents: 430000, employerTaxCents: 39800 }, await pdf("ADP payroll preview (FICTIONAL)", ["Vulcan Fitness LLC (FICTIONAL)"]));
    await svc.sendForClientApproval(mom, v1.id);
    run = (await prisma.payrollCycle.findUniqueOrThrow({ where: { id: v1.id } })).payrollRunId!;
    await decidePayroll(vul.portal[0].id, vul.clientId, run, { decision: "DENIED", comment: "One trainer is missing from this payroll (FICTIONAL)", versionId: (await loadRun(vul.clientId, run)).version.id }, meta);
  }

  // Red Mountain: nothing yet (waiting on hours), plus a held reminder to show the OFF switch.
  const { runPayrollReminders } = await import("@/lib/services/payroll-reminders");
  await runPayrollReminders();

  console.log(JSON.stringify({ ok: true, owner: owner.email, staff: { manage: mom.email, view: viewer.email, none: "demo.noaccess@example.com" }, password: "Demo-Only-Pass-1 (fictional, local only)", businesses: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { clientId: v.clientId, approvers: v.portal.map((p) => p.email) }])), onOrBefore: onOrBeforeBusinessDay(today) }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
