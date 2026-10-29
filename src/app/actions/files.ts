"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { saveUpload } from "@/lib/services/files";
import { ValidationError } from "@/lib/services/clients";
import { prisma } from "@/lib/prisma";

export async function uploadFlyerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file to upload.");
    await saveUpload(actor, { kind: "FLYER", bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name, title: str(fd, "title") });
    revalidatePath("/flyers");
    return "Flyer added to the library.";
  });
}

export async function archiveFlyerAction(fileId: string, archived: boolean) {
  const actor = await requireUser();
  await prisma.$transaction([
    prisma.storedFile.update({ where: { id: fileId, kind: "FLYER" }, data: { archivedAt: archived ? new Date() : null } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: archived ? "file.archived" : "file.restored", entityType: "StoredFile", entityId: fileId } }),
  ]);
  revalidatePath("/flyers");
}
