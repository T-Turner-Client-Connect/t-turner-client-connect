import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";

/**
 * One-time keys for office forms that must not save twice (entering a balance, importing a bank
 * file, filing a statement). ActionForm's `idempotent` sends the same key on a double-click or
 * a retry and a new one after each success. The key is claimed before the work starts; a second
 * submission with it is refused as a repeat; if the work fails the claim is released so the
 * person can try again.
 */
export class RepeatedSubmission extends ValidationError {
  constructor(public resultId: string | null) {
    super("Already saved — that was the same form sent twice, so nothing was saved again.");
    this.name = "RepeatedSubmission";
  }
}

export async function once<T>(key: string | null | undefined, actor: Pick<Actor, "id">, kind: string, fn: () => Promise<T>, idOf: (r: T) => string | null = (r) => (r && typeof r === "object" && "id" in r ? String((r as { id: unknown }).id) : null)): Promise<T> {
  if (!key) return fn();
  if (!/^[\w-]{8,100}$/.test(key)) throw new ValidationError("This form is out of date. Reload the page and try again.");
  try {
    await prisma.officeActionKey.create({ data: { key, actorId: actor.id, kind } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await prisma.officeActionKey.findUnique({ where: { key } });
      throw new RepeatedSubmission(row?.actorId === actor.id ? row.resultId : null);
    }
    throw err;
  }
  try {
    const result = await fn();
    await prisma.officeActionKey.update({ where: { key }, data: { resultId: idOf(result) } });
    return result;
  } catch (err) {
    await prisma.officeActionKey.delete({ where: { key } }).catch(() => {});
    throw err;
  }
}
