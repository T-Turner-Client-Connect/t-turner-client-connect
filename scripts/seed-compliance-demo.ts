/**
 * FICTIONAL demo data for the Tax & Compliance Center (local development and screenshots).
 *
 *   DATABASE_URL=postgresql://…@localhost:5432/<local db> npx tsx --tsconfig scripts/tsconfig.seed.json scripts/seed-compliance-demo.ts
 *
 * Refuses to run with NODE_ENV=production, on Netlify, or when the DATABASE_URL host isn't local.
 * Every client is clearly fictional ("(DEMO, not real data)", example.com, 555-01xx). It sends
 * nothing: notifications stay off, no email/SMS provider is configured, and the compliance switches
 * stay OFF. It never touches a real client record.
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
process.env.NOTIFICATIONS_ENABLED = "false";
for (const k of ["RESEND_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) delete process.env[k];
process.env.APP_ENCRYPTION_KEY ??= "local-demo-only-encryption-key-0123456789";

async function main() {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const { prisma } = await import("@/lib/prisma");
  const { hashPassword } = await import("@/lib/auth/password");
  const E = await import("@/lib/services/compliance/entities");
  const O = await import("@/lib/services/compliance/obligations");
  const P = await import("@/lib/services/compliance/periods");
  const { applyProposedProfile } = await import("@/lib/services/compliance/proposal");
  const { ensureRulesLoaded } = await import("@/lib/services/compliance/rules");
  const { runComplianceReminders } = await import("@/lib/services/compliance/reminders");
  type Actor = { id: string; role: "ADMIN" | "STAFF"; name: string; email: string };

  const DEMO = "Magnolia Grill (DEMO, not real data)";
  if (await prisma.client.count({ where: { businessName: DEMO } })) {
    console.log("Compliance demo data is already here. Nothing changed.");
    return;
  }
  const pdf = async (lines: string[]) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 20, size: i ? 12 : 16, font }));
    return new Uint8Array(await doc.save());
  };
  const pw = await hashPassword("Demo-Only-Password-1");
  const user = async (email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> => {
    const u = await prisma.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash: pw, mfaEnabledAt: new Date(), emailVerifiedAt: new Date() } });
    return { id: u.id, role: u.role, name: u.name, email: u.email };
  };
  const tab = await user("owner.demo@example.com", "Tabitha (DEMO owner)", "ADMIN");
  if (!(await prisma.ownerAccess.count({ where: { isPrimary: true } }))) await prisma.ownerAccess.create({ data: { userId: tab.id, isPrimary: true, scope: "FULL" } });
  const daria = await user("daria.demo@example.com", "Daria (DEMO staff)", "STAFF");
  const nora = await user("nora.demo@example.com", "Nora (DEMO, no compliance access)", "STAFF");
  await prisma.staffPermission.createMany({ data: ["view", "manage"].map((action) => ({ userId: daria.id, area: "compliance", action, grantedById: tab.id })), skipDuplicates: true });
  void nora;
  await ensureRulesLoaded();

  const client = async (name: string, extra: Record<string, unknown> = {}) => prisma.client.create({ data: { displayName: name, businessName: name, clientType: "BUSINESS", email: `${name.split(" ")[0].toLowerCase().replace(/[^a-z]/g, "")}@example.com`, phone: "205-555-0100", city: "Birmingham", state: "AL", assignedToId: daria.id, ...extra } });
  const service = (clientId: string, type: "BOOKKEEPING" | "PAYROLL" | "TAX_BUSINESS" | "TAX_INDIVIDUAL" | "TAX_NONPROFIT") => prisma.clientService.create({ data: { clientId, type, title: type.replace("_", " "), status: "IN_PROGRESS", createdById: tab.id } });
  const portal = async (clientId: string, email: string, name: string) => {
    const u = await prisma.portalUser.upsert({ where: { email }, update: {}, create: { email, name, passwordHash: pw, emailVerifiedAt: new Date(), mfaEnabledAt: new Date() } });
    await prisma.portalAccess.upsert({ where: { portalUserId_clientId: { portalUserId: u.id, clientId } }, update: {}, create: { portalUserId: u.id, clientId } });
    return { id: u.id, name: u.name, email: u.email };
  };

  // 1. Magnolia Grill (DEMO): the restaurant proposal + the owner's nonprofit.
  const restaurant = await client(DEMO, { addressLine1: "100 Example Ave S", postalCode: "35203" });
  await service(restaurant.id, "BOOKKEEPING");
  await service(restaurant.id, "TAX_BUSINESS");
  const samOwner = await portal(restaurant.id, "sam.demo@example.com", "Sam (DEMO owner)");
  const { business, nonprofit } = await applyProposedProfile(tab, restaurant.id, "RESTAURANT_AL_SCORP_JEFFERSON_BHM");
  // Owner approves a few items after verifying (fictional example data only).
  await prisma.complianceEntity.update({ where: { id: business.id }, data: { status: "ACTIVE", portalVisible: true, fiscalYearEndMonth: 12 } });
  await E.saveTaxAccount(tab, business.id, { type: "SALES_USE", agency: "Alabama Department of Revenue", jurisdictionName: "Alabama", jurisdictionLevel: "STATE", accountNumber: "DEMO-000-1111", filingFrequency: "MONTHLY", status: "ACTIVE" });
  const mat = await E.saveFirmAccount(tab, { portalKind: "MAT", name: "Firm MAT third-party agent account (DEMO)", portalUrl: "https://myalabamataxes.alabama.gov/", accessMethod: "MAT third-party access via firm agent account", accessReference: "Password manager: “MAT agent — firm” (DEMO)" });
  await E.saveFilingAccount(tab, business.id, { portalKind: "MAT", name: "MAT — Alabama sales tax", portalUrl: "https://myalabamataxes.alabama.gov/", accessMethod: "MAT third-party access via firm agent account", accessReference: "Password manager: “MAT agent — firm” (DEMO)", firmAccountId: mat.id });
  await E.saveFilingAccount(tab, business.id, { portalKind: "IRS_EFTPS", name: "IRS EFTPS", portalUrl: "https://www.eftps.gov/", accessMethod: "Client-held login (client files or shares screen)", accessReference: "Client keeps the EFTPS PIN (never stored here)" });
  await E.addAuthorization(tab, business.id, { formType: "AL Form 2848A", effectiveDate: "2026-01-01", expiresAt: "2028-12-31", notes: "DEMO example" });
  const sales = await prisma.complianceObligation.findFirstOrThrow({ where: { entityId: business.id, dedupeKey: "AL_SALES_2100" } });
  await O.generateObligations(tab, business.id); // refresh with the recorded account
  await O.editObligation(tab, sales.id, { assignedStaffId: daria.id, clientApprovalRequired: true, clientVisible: true, serviceType: "BOOKKEEPING" });
  await O.activateObligation(tab, sales.id, { startDate: "2026-09-22" });
  const bhm = await prisma.complianceObligation.findFirstOrThrow({ where: { entityId: business.id, dedupeKey: "BHM_BUSINESS_LICENSE" } });
  await O.editObligation(tab, bhm.id, { assignedStaffId: daria.id, clientVisible: true, serviceType: "BOOKKEEPING" });
  await O.activateObligation(tab, bhm.id);

  // September 2026: full approval flow (ready → client approved → submitted with evidence → accepted).
  const sep = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: sales.id, periodKey: "2026-09" } });
  const ret = await P.uploadComplianceDocument(daria, { entityId: business.id, periodId: sep.id, kind: "RETURN", title: "Form 2100 — Sept 2026 (DEMO)", bytes: await pdf(["Alabama Form 2100 — DEMO, not real data", "Magnolia Grill (DEMO) · September 2026", "Taxable sales: $00,000.00 (fictional)"]), originalName: "form-2100-sep-2026-demo.pdf" });
  await P.uploadComplianceDocument(daria, { entityId: business.id, periodId: sep.id, kind: "SUPPORTING", title: "Sales summary Sept 2026 (DEMO)", bytes: await pdf(["Sales summary — DEMO", "September 2026 (fictional)"]), originalName: "sales-sep-2026-demo.pdf" });
  await P.setAmountDue(daria, sep.id, 184250);
  const v = await P.createReturnVersion(daria, sep.id, { note: "September sales tax return for your review." });
  await P.sendForApproval(daria, v.id);
  await P.clientDecide(samOwner, v.id, { decision: "APPROVED", signerName: "Sam (DEMO owner)", contentHash: v.contentHash, comments: "Approved — demo." }, { ip: "203.0.113.10", userAgent: "Demo browser" });
  const conf = await P.uploadComplianceDocument(daria, { entityId: business.id, periodId: sep.id, kind: "FILING_CONFIRMATION", title: "MAT confirmation (DEMO)", bytes: await pdf(["MAT filing confirmation — DEMO", "Confirmation DEMO-CONF-0920"]), originalName: "mat-confirmation-demo.pdf" });
  await P.recordSubmitted(daria, sep.id, { confirmationNumber: "DEMO-CONF-0920", documentId: conf.document.id, filedOn: "2026-10-16" });
  const ack = await P.uploadComplianceDocument(daria, { entityId: business.id, periodId: sep.id, kind: "ACCEPTANCE", title: "ALDOR acknowledgement (DEMO)", bytes: await pdf(["ALDOR acknowledgement — DEMO"]), originalName: "aldor-ack-demo.pdf" });
  await P.recordAccepted(daria, sep.id, { documentId: ack.document.id });
  // October 2026: return ready and waiting for the client's approval.
  const oct = await prisma.complianceFilingPeriod.findFirstOrThrow({ where: { obligationId: sales.id, periodKey: "2026-10" } });
  await P.startPreparing(daria, oct.id);
  await P.uploadComplianceDocument(daria, { entityId: business.id, periodId: oct.id, kind: "RETURN", title: "Form 2100 — Oct 2026 (DEMO)", bytes: await pdf(["Alabama Form 2100 — DEMO, not real data", "October 2026 (fictional)"]), originalName: "form-2100-oct-2026-demo.pdf" });
  await P.setAmountDue(daria, oct.id, 191075);
  const v2 = await P.createReturnVersion(daria, oct.id);
  await P.sendForApproval(daria, v2.id);
  // Demo files are marked scanned so the screens can open them (no scanner locally).
  await prisma.document.updateMany({ where: { clientId: restaurant.id }, data: { scanStatus: "CLEAN" } });
  await P.publishComplianceDocument(daria, ret.document.id, true);
  await P.publishComplianceDocument(daria, conf.document.id, true);
  void nonprofit;

  // 2. Fictional retail shop (Huntsville).
  const retail = await client("Rocket City Gifts LLC (DEMO, not real data)", { city: "Huntsville" });
  await service(retail.id, "BOOKKEEPING");
  const re = await E.createEntity(tab, retail.id, { kind: "LLC", legalName: "Rocket City Gifts LLC (DEMO)", taxClassification: "SCHEDULE_C", fiscalYearEndMonth: 12, stateOfFormation: "AL", statesOfOperation: ["AL"], industry: "Retail", activityTags: ["retail", "sells_taxable"], payrollStatus: "NO", issues1099: "NO", ein: "00-0000101" });
  await E.addLocation(tab, re.id, { label: "Store", city: "Huntsville", county: "Madison", state: "AL", isPrimary: true });
  await O.generateObligations(tab, re.id);
  // 3. Fictional construction LLC (payroll, 1099s).
  const build = await client("Red Mountain Builders LLC (DEMO, not real data)");
  await service(build.id, "PAYROLL");
  await service(build.id, "TAX_BUSINESS");
  const be = await E.createEntity(tab, build.id, { kind: "LLC", legalName: "Red Mountain Builders LLC (DEMO)", taxClassification: "PARTNERSHIP", fiscalYearEndMonth: 12, stateOfFormation: "AL", statesOfOperation: ["AL"], industry: "Construction", activityTags: ["construction"], payrollStatus: "YES", employeeCount: 6, payrollProvider: "ADP RUN", issues1099: "YES" });
  await E.addLocation(tab, be.id, { label: "Office", city: "Birmingham", county: "Jefferson", state: "AL", isPrimary: true });
  await E.saveTaxAccount(tab, be.id, { type: "WITHHOLDING", agency: "Alabama Department of Revenue", jurisdictionName: "Alabama", filingFrequency: "MONTHLY", status: "ACTIVE" });
  await O.generateObligations(tab, be.id);
  for (const k of ["FED_941", "AL_WH_A6", "FED_1099_NEC"]) {
    const o = await prisma.complianceObligation.findFirst({ where: { entityId: be.id, dedupeKey: k } });
    if (o) {
      await O.editObligation(tab, o.id, { assignedStaffId: daria.id });
      await O.activateObligation(tab, o.id, { startDate: "2026-10-01" });
    }
  }
  // 4. Fictional professional-services sole proprietor (tax-only).
  const pro = await client("Iron City Consulting (DEMO, not real data)");
  await service(pro.id, "TAX_INDIVIDUAL");
  const pe = await E.createEntity(tab, pro.id, { kind: "SOLE_PROPRIETORSHIP", legalName: "Iron City Consulting (DEMO)", taxClassification: "SCHEDULE_C", fiscalYearEndMonth: 12, stateOfFormation: "AL", statesOfOperation: ["AL"], industry: "Professional services", activityTags: ["professional_services"], payrollStatus: "NO", issues1099: "YES" });
  await O.generateObligations(tab, pe.id);
  const sc = await prisma.complianceObligation.findFirst({ where: { entityId: pe.id, dedupeKey: "FED_SCHEDULE_C" } });
  if (sc) await O.activateObligation(tab, sc.id);
  // 5. Fictional nonprofit (its own client record with a NonprofitProfile).
  const np = await prisma.client.create({ data: { displayName: "Southside Food Pantry (DEMO, not real data)", businessName: "Southside Food Pantry (DEMO, not real data)", clientType: "NONPROFIT", city: "Birmingham", state: "AL", fiscalYearEnd: 6, assignedToId: daria.id } });
  await prisma.nonprofitProfile.create({ data: { clientId: np.id, formType: "990-EZ", filingService: "YES" } });
  await service(np.id, "TAX_NONPROFIT");
  const ne = await E.createEntityFromClient(tab, np.id);
  await E.updateEntity(tab, ne.id, { kind: "NONPROFIT", legalName: "Southside Food Pantry (DEMO)", taxClassification: "EXEMPT_ORG", fiscalYearEndMonth: 6, stateOfFormation: "AL", statesOfOperation: ["AL"], irsExemptionStatus: "DETERMINATION_LETTER", activityTags: ["nonprofit"], payrollStatus: "NO" });
  await O.generateObligations(tab, ne.id);
  const ez = await prisma.complianceObligation.findFirst({ where: { entityId: ne.id, dedupeKey: "FED_990EZ" } });
  if (ez) await O.activateObligation(tab, ez.id);

  await runComplianceReminders(new Date());
  console.log(`Compliance demo seeded. Owner: owner.demo@example.com · staff: daria.demo@example.com · no access: nora.demo@example.com · client login: sam.demo@example.com (password Demo-Only-Password-1, local only).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
