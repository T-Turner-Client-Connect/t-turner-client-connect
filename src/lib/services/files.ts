import "server-only";
import { randomUUID } from "node:crypto";
import type { FileKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { imageSize, MAX_UPLOAD_BYTES, sniffType } from "@/lib/files";
import { ValidationError } from "./clients";

export async function saveUpload(actor: Actor, args: { kind: FileKind; bytes: Uint8Array; originalName: string; title?: string }) {
  if (args.bytes.length === 0) throw new ValidationError("The file is empty.");
  if (args.bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError("Files can be up to 10 MB.");
  const type = sniffType(args.bytes);
  if (!type) throw new ValidationError("Upload a PNG, JPG, or PDF file.");
  const size = type.mime === "application/pdf" ? null : imageSize(args.bytes, type.mime);
  const storageKey = `${args.kind.toLowerCase()}/${randomUUID()}`;
  await storage.put(storageKey, args.bytes);
  const name = args.originalName.replace(/[^\w.\- ()]/g, "_").slice(0, 150) || `upload.${type.ext}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const file = await tx.storedFile.create({
        data: {
          kind: args.kind,
          storageKey,
          originalName: name,
          title: args.title?.trim().slice(0, 150) || name.replace(/\.[^.]+$/, ""),
          mimeType: type.mime,
          sizeBytes: args.bytes.length,
          width: size?.width ?? null,
          height: size?.height ?? null,
          uploadedById: actor.id,
        },
      });
      await audit(tx, { actorId: actor.id, action: "file.uploaded", entityType: "StoredFile", entityId: file.id, details: { kind: args.kind, mime: type.mime } });
      return file;
    });
  } catch (err) {
    await storage.remove(storageKey).catch(() => {});
    throw err;
  }
}

export async function readStoredFile(fileId: string) {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId } });
  if (!file) return null;
  const bytes = await storage.get(file.storageKey);
  return bytes ? { file, bytes } : null;
}
