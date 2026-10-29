// FICTIONAL sample clients for local development and demos only.
// Refuses to run against a non-local database unless ALLOW_SAMPLE_DATA=true.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) && process.env.ALLOW_SAMPLE_DATA !== "true") {
  console.error("Refusing to load sample data into a non-local database. Set ALLOW_SAMPLE_DATA=true to override.");
  process.exit(1);
}

type Sample = {
  firstName?: string;
  lastName?: string;
  businessName?: string;
  email?: string;
  phone?: string;
  city: string;
  clientType: "INDIVIDUAL" | "BUSINESS" | "NONPROFIT";
  status: "ACTIVE" | "PROSPECT";
  services: string[];
  groups: string[];
  tags?: string[];
  taxReturnDerived?: boolean;
};

// 555-01xx numbers and example.com addresses are reserved for fiction.
const SAMPLES: Sample[] = [
  { firstName: "Avery", lastName: "Lindqvist", email: "avery.lindqvist@example.com", phone: "(555) 010-0101", city: "Springfield", clientType: "INDIVIDUAL", status: "ACTIVE", services: ["Tax preparation"], groups: ["Individual Tax Clients"], taxReturnDerived: true },
  { firstName: "Marcus", lastName: "Oyelaran", email: "marcus.o@example.com", phone: "(555) 010-0102", city: "Riverton", clientType: "INDIVIDUAL", status: "ACTIVE", services: ["Tax preparation"], groups: ["Individual Tax Clients"], taxReturnDerived: true },
  { businessName: "Bluebird Bakery LLC", firstName: "Priya", lastName: "Natarajan", email: "hello@bluebird-bakery.example.com", phone: "(555) 010-0103", city: "Springfield", clientType: "BUSINESS", status: "ACTIVE", services: ["Bookkeeping", "Payroll"], groups: ["Business Owners", "Bookkeeping", "Payroll"], tags: ["monthly"] },
  { businessName: "Harbor Light Community Fund", email: "info@harborlight.example.org", phone: "(555) 010-0104", city: "Bayview", clientType: "NONPROFIT", status: "PROSPECT", services: ["Nonprofit formation"], groups: ["Nonprofit Interest", "Prospects"] },
  { firstName: "Delia", lastName: "Fontaine", email: "delia.fontaine@example.com", city: "Riverton", clientType: "INDIVIDUAL", status: "PROSPECT", services: [], groups: ["Prospects"] },
  { firstName: "Theo", lastName: "Brandt", phone: "(555) 010-0106", city: "Springfield", clientType: "INDIVIDUAL", status: "ACTIVE", services: ["Tax preparation"], groups: ["Individual Tax Clients"], taxReturnDerived: true },
  { businessName: "Cedar & Pine Landscaping", firstName: "Jonah", lastName: "Reyes", email: "jonah@cedarpine.example.com", phone: "(555) 010-0107", city: "Oak Hill", clientType: "BUSINESS", status: "ACTIVE", services: ["Payroll"], groups: ["Business Owners", "Payroll"] },
];

async function main() {
  for (const s of SAMPLES) {
    const displayName = [s.firstName, s.lastName].filter(Boolean).join(" ") || s.businessName!;
    const exists = await prisma.client.findFirst({ where: { displayName } });
    if (exists) continue;
    const digits = s.phone?.replace(/\D/g, "");
    const client = await prisma.client.create({
      data: {
        firstName: s.firstName ?? null,
        lastName: s.lastName ?? null,
        businessName: s.businessName ?? null,
        displayName,
        email: s.email ?? null,
        emailNormalized: s.email?.toLowerCase() ?? null,
        phone: s.phone ?? null,
        phoneNormalized: digits ? `+1${digits}` : null,
        city: s.city,
        state: "IL",
        clientType: s.clientType,
        status: s.status,
        services: s.services,
        tags: [...(s.tags ?? []), "sample"],
        taxReturnDerived: s.taxReturnDerived ?? false,
        source: "Fictional sample data",
      },
    });
    for (const name of s.groups) {
      const group = await prisma.group.upsert({ where: { name }, update: {}, create: { name } });
      await prisma.clientGroup.create({ data: { clientId: client.id, groupId: group.id } });
    }
  }
  const bakery = await prisma.client.findFirst({ where: { displayName: "Priya Natarajan" } });
  if (bakery && !(await prisma.contact.count({ where: { clientId: bakery.id } }))) {
    await prisma.contact.create({
      data: { clientId: bakery.id, name: "Sam Whitlock", title: "Office manager", email: "sam@bluebird-bakery.example.com", emailNormalized: "sam@bluebird-bakery.example.com", phone: "(555) 010-0113", phoneNormalized: "+15550100113" },
    });
  }
  console.log("Loaded fictional sample clients.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
