import type { Role } from "@prisma/client";

/** The signed-in staff member performing an action. */
export type Actor = { id: string; role: Role; name: string; email: string };

export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw new ForbiddenError("Only an Admin can do that.");
}

export function isAdmin(actor: Pick<Actor, "role">): boolean {
  return actor.role === "ADMIN";
}
