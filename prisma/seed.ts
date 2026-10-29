// LOCAL DEVELOPMENT ONLY (npm run db:seed). Not part of any deployment.
// Adds the suggested client groups — no clients, accounts or passwords — and
// never changes existing rows. Hosted databases get the same groups from the
// seed_default_groups migration (ON CONFLICT DO NOTHING).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

if (process.env.CONTEXT && process.env.CONTEXT !== "dev") {
  console.error("prisma/seed.ts is for local development and does not run on Netlify deploys.");
  process.exit(1);
}

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
