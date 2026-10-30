import { getPortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { portalUploadDocument } from "@/lib/services/documents";
import { isClientDocType } from "@/lib/document-types";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/files";

/**
 * Tax Center upload, one file per request so the browser can show real
 * progress. Same rules as every client upload: the signed-in client's own
 * account, upload permission, year and document type required, malware scan
 * with quarantine, duplicate check. Staff preview has no portal session, so
 * it can never write here.
 */
export async function POST(req: Request) {
  const user = await getPortalUser();
  if (!user) return Response.json({ error: "Please sign in to your client portal again." }, { status: 401 });
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return Response.json({ error: `The upload didn't arrive. Files can be up to ${MAX_UPLOAD_LABEL}.` }, { status: 400 });
  }
  const clientId = String(fd.get("account") ?? "");
  const year = String(fd.get("year") ?? "");
  const docType = String(fd.get("docType") ?? "");
  const file = fd.get("file");
  try {
    await requireClientAccess(user.id, clientId, "upload");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file to upload.");
    if (file.size > MAX_UPLOAD_BYTES) throw new ValidationError(`“${file.name}” is larger than ${MAX_UPLOAD_LABEL}.`);
    if (!year) throw new ValidationError("Choose the tax year, or “Not sure”.");
    if (!isClientDocType(docType)) throw new ValidationError("Choose what kind of document this is.");
    const doc = await portalUploadDocument(user, { clientId, year: year === "unsure" ? "unsure" : Number(year), docType, title: String(fd.get("title") ?? ""), bytes: new Uint8Array(await file.arrayBuffer()), originalName: file.name });
    return Response.json({ ok: true, name: file.name, year: doc.year, scanStatus: doc.scanStatus });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: err instanceof ForbiddenError ? 403 : 400 });
    console.error("Client upload failed:", err instanceof Error ? err.name : "unknown");
    return Response.json({ error: "Something went wrong and the file wasn't saved. Please try again, or message our office." }, { status: 500 });
  }
}
