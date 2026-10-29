import "server-only";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// On Netlify the connection string comes from Netlify Database (NETLIFY_DB_URL).
// An explicit DATABASE_URL (local development, tests) takes precedence.
const datasourceUrl = process.env.DATABASE_URL ?? process.env.NETLIFY_DB_URL;

// Query logging is off on purpose: queries can contain client data.
export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl, log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
