import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// On Netlify the connection string comes from the attached Netlify Database
// (NETLIFY_DB_URL); DATABASE_URL still works for local development.
const datasourceUrl = process.env.DATABASE_URL || process.env.NETLIFY_DB_URL;

// Query logging is off on purpose: queries can contain client data.
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl, log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
