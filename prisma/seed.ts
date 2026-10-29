// Baseline reference data only — no client records, no staff accounts.
// Safe to run on every deploy.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_GROUPS = [
  ["Individual Tax Clients", "Individuals we prepare tax returns for"],
  ["Business Owners", "Business clients and owners"],
  ["Bookkeeping", "Monthly or quarterly bookkeeping clients"],
  ["Payroll", "Payroll service clients"],
  ["Nonprofit Interest", "Interested in nonprofit formation or compliance"],
  ["Prospects", "Not yet clients"],
] as const;

async function main() {
  for (const [name, description] of DEFAULT_GROUPS) {
    await prisma.group.upsert({ where: { name }, update: {}, create: { name, description } });
  }
  console.log(`Seeded ${DEFAULT_GROUPS.length} default groups.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
