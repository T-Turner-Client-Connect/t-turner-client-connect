import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// On Netlify the connection string comes from Netlify Database (NETLIFY_DB_URL),
// which is the database Netlify migrates — so it always wins there. Locally
// (no NETLIFY_DB_URL) DATABASE_URL is used.
const datasourceUrl = process.env.NETLIFY_DB_URL || process.env.DATABASE_URL;

// Query logging is off on purpose: queries can contain client data.
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl, log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
