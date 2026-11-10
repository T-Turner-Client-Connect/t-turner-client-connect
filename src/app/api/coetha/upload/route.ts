import { getCurrentUser } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { finishUpload, kickBackgroundReading, putChunk, startUpload } from "@/lib/services/coetha-reading";

// Ask Coetha's "Upload Files": a file of any size (up to the reading limit) arrives in pieces
// small enough for one request each. Staff with access to the business's books only.
export const maxDuration = 60;

export async function POST(req: Request) {
  const actor = await getCurrentUser();
  if (!actor) return Response.json({ error: "Sign in again to upload." }, { status: 401 });
  try {
    const fd = await req.formData();
    const step = String(fd.get("step") ?? "");
    if (step === "start") return Response.json(await startUpload(actor, String(fd.get("clientId") ?? ""), { name: String(fd.get("name") ?? ""), size: Number(fd.get("size")) }));
    if (step === "chunk") {
      const part = fd.get("part");
      if (!(part instanceof Blob)) throw new ValidationError("A piece of the file is missing.");
      return Response.json(await putChunk(actor, String(fd.get("uploadId") ?? ""), Number(fd.get("index")), new Uint8Array(await part.arrayBuffer())));
    }
    if (step === "finish") {
      const r = await finishUpload(actor, String(fd.get("uploadId") ?? ""));
      await kickBackgroundReading();
      return Response.json(r);
    }
    return Response.json({ error: "Unknown step." }, { status: 400 });
  } catch (err) {
    if (err instanceof ForbiddenError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ValidationError) return Response.json({ error: err.message }, { status: 400 });
    console.error("coetha upload failed", err instanceof Error ? err.message : "error");
    return Response.json({ error: "The file couldn't be saved. Try again." }, { status: 500 });
  }
}
