// FICTIONAL ADP Revenue Share demo data (Owner's Office), for local development and screenshots.
// Every referral, statement and payment it adds is marked FICTIONAL. It never creates clients: it
// links to the fictional sample clients from prisma/sample-data.ts when they exist, otherwise it
// uses prospect names. Refuses to run in production, on Netlify, or against a non-local database.
//
//   DATABASE_URL=postgresql://…@localhost:5432/… npm run db:seed:adp-demo
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
const refuse = (why: string) => {
  console.error(`Refusing to load the FICTIONAL ADP demo: ${why}`);
  process.exit(1);
};
if (process.env.NODE_ENV === "production") refuse("NODE_ENV is production.");
if (process.env.CONTEXT || process.env.NETLIFY) refuse("this looks like Netlify (CONTEXT/NETLIFY is set).");
if (!url) refuse("DATABASE_URL is not set.");
if (!/^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) refuse("DATABASE_URL is not a local database (localhost / 127.0.0.1).");

const prisma = new PrismaClient({ datasourceUrl: url });
const MARK = "FICTIONAL demo data";
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const owner = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, include: { user: true } });
  if (!owner) refuse("no Owner's Office owner is set up in this database yet (claim the Owner's Office first).");
  const ownerId = owner!.userId;
  const ownerName = owner!.user.name;
  if (await prisma.adpReferral.findFirst({ where: { notes: { contains: MARK } } })) {
    console.log("FICTIONAL ADP demo data is already loaded.");
    return;
  }
  const client = async (displayName: string) => (await prisma.client.findFirst({ where: { OR: [{ displayName }, { businessName: displayName }], archivedAt: null }, select: { id: true } }))?.id ?? null;

  const referral = async (r: { client?: string; prospect?: string; on: string; product: string; other?: string; ref?: string; history: [string, string][]; note: string }) => {
    const clientId = r.client ? await client(r.client) : null;
    const status = r.history.at(-1)![0];
    const row = await prisma.adpReferral.create({
      data: {
        clientId,
        prospectName: clientId ? null : `FICTIONAL ${r.prospect ?? r.client}`,
        referredOn: d(r.on),
        product: r.product,
        productOther: r.other ?? null,
        adpReference: r.ref ?? null,
        status,
        notes: `${MARK}. ${r.note}`,
        createdById: ownerId,
      },
    });
    let from: string | null = null;
    for (const [to, on] of r.history) {
      await prisma.adpReferralStatusChange.create({ data: { referralId: row.id, fromStatus: from, toStatus: to, effectiveOn: d(on), note: from ? "FICTIONAL status change" : "Referral recorded", changedById: ownerId } });
      from = to;
    }
    return row;
  };

  const bluebird = await referral({ client: "Bluebird Bakery LLC", on: "2026-02-10", product: "RUN", ref: "FICT-RUN-1001", history: [["REFERRED", "2026-02-10"], ["SOLD", "2026-03-02"], ["ACTIVE", "2026-03-16"]], note: "Payroll for 6 employees." });
  const cedar = await referral({ client: "Cedar & Pine Landscaping", on: "2026-03-22", product: "WFN", ref: "FICT-WFN-2002", history: [["REFERRED", "2026-03-22"], ["SOLD", "2026-08-11"]], note: "Seasonal crew, Workforce Now." });
  const maple = await referral({ prospect: "Maple Street Dental", on: "2026-01-12", product: "RUN", ref: "FICT-RUN-1003", history: [["REFERRED", "2026-01-12"], ["SOLD", "2026-02-01"], ["ACTIVE", "2026-02-15"]], note: "Not a client yet — link later." });
  await referral({ prospect: "Northwind Florist", on: "2026-10-05", product: "RUN", history: [["REFERRED", "2026-10-05"]], note: "Intro call with ADP rep scheduled." });
  await referral({ prospect: "Harbor Tool Co.", on: "2026-04-15", product: "OTHER", other: "ADP TotalSource", history: [["REFERRED", "2026-04-15"], ["DECLINED", "2026-05-20"]], note: "Chose to stay with current PEO." });

  const statement = async (s: { label: string; start: string; end: string; on: string; total: number; final: boolean; lines: { r?: string; type: string; cents: number; note?: string; adpName?: string }[] }) => {
    const row = await prisma.adpStatement.create({
      data: { periodLabel: s.label, periodStart: d(s.start), periodEnd: d(s.end), statementDate: d(s.on), reportedTotalCents: s.total, notes: `${MARK}.`, createdById: ownerId, status: s.final ? "FINAL" : "DRAFT", finalizedAt: s.final ? new Date(`${s.on}T15:00:00Z`) : null, finalizedById: s.final ? ownerId : null },
    });
    let order = 0;
    for (const l of s.lines) await prisma.adpStatementLine.create({ data: { statementId: row.id, referralId: l.r ?? null, type: l.type, amountCents: l.cents, note: l.note ?? null, adpName: l.adpName ?? null, sortOrder: ++order, createdById: ownerId } });
    if (s.final) {
      const linesCents = s.lines.reduce((t, l) => t + l.cents, 0);
      await prisma.adpStatementRevision.create({ data: { statementId: row.id, revisionNumber: 1, kind: "FINALIZED", reason: "FICTIONAL: checked against the ADP statement", updated: { periodLabel: s.label, linesCents, totalMatches: linesCents === s.total }, editedById: ownerId, editedByName: ownerName } });
    }
    return row;
  };

  const q4 = await statement({
    label: "ADP FY2026 Q4 (Apr–Jun 2026) — FICTIONAL",
    start: "2026-04-01",
    end: "2026-06-30",
    on: "2026-07-20",
    total: 53050,
    final: true,
    lines: [
      { r: bluebird.id, type: "COMMISSION", cents: 25000, adpName: "BLUEBIRD BAKERY" },
      { r: bluebird.id, type: "RESIDUAL", cents: 4250, adpName: "BLUEBIRD BAKERY" },
      { r: maple.id, type: "COMMISSION", cents: 20000, adpName: "MAPLE ST DENTAL" },
      { r: maple.id, type: "RESIDUAL", cents: 3800, adpName: "MAPLE ST DENTAL" },
    ],
  });
  const q1 = await statement({
    label: "ADP FY2027 Q1 (Jul–Sep 2026) — FICTIONAL",
    start: "2026-07-01",
    end: "2026-09-30",
    on: "2026-10-20",
    total: 57500,
    final: false,
    lines: [
      { r: bluebird.id, type: "RESIDUAL", cents: 4500, adpName: "BLUEBIRD BAKERY" },
      { r: maple.id, type: "RESIDUAL", cents: 4000, adpName: "MAPLE ST DENTAL" },
      { r: cedar.id, type: "COMMISSION", cents: 40000, adpName: "CEDAR & PINE LANDSCAPING" },
      { type: "BONUS", cents: 10000, note: "FICTIONAL quarterly partner bonus" },
      { r: maple.id, type: "ADJUSTMENT", cents: -1500, note: "FICTIONAL chargeback (one employee removed)", adpName: "MAPLE ST DENTAL" },
    ],
  });

  const payment = async (p: { on: string; cents: number; method: string; periods: string; ref: string; statementId?: string; note: string }) => {
    const row = await prisma.adpPayment.create({ data: { receivedOn: d(p.on), amountCents: p.cents, method: p.method, periodsCovered: p.periods, reference: p.ref, note: `${MARK}. ${p.note}`, statementId: p.statementId ?? null, matchedAt: p.statementId ? new Date(`${p.on}T16:00:00Z`) : null, matchedById: p.statementId ? ownerId : null, createdById: ownerId } });
    if (p.statementId) await prisma.adpPaymentMatchEvent.create({ data: { paymentId: row.id, statementId: p.statementId, action: "MATCHED", note: "FICTIONAL: amount and period agree", actorId: ownerId, actorName: ownerName } });
    return row;
  };
  await payment({ on: "2026-08-28", cents: 53050, method: "ACH", periods: "ADP FY2026 Q4", ref: "FICT-ACH-0828", statementId: q4.id, note: "Deposit for the April–June quarter." });
  await payment({ on: "2026-05-14", cents: 12000, method: "CHECK", periods: "ADP FY2026 Q3", ref: "FICT-CHK-4471", note: "Earlier quarter; statement not entered." });

  await prisma.ownerAuditLog.create({ data: { actorId: ownerId, action: "adp.demo_seeded", entityType: "AdpStatement", entityId: q1.id, details: { fictional: true } } });
  console.log("Loaded FICTIONAL ADP Revenue Share demo data: 5 referrals, 2 statements, 2 payments.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
