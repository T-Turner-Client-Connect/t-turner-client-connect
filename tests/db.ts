import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

let n = 0;
export async function makeUser(role: "ADMIN" | "STAFF", name = role === "ADMIN" ? "Tabitha" : "Daria"): Promise<Actor> {
  n++;
  const u = await prisma.user.create({ data: { email: `${name.toLowerCase()}${n}@example.com`, name, role, passwordHash: "x" } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

export { prisma };
