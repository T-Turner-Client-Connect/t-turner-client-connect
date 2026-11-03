import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { jotformConfig } from "@/lib/services/contracts";
import { fetchSubmission, summarize } from "@/lib/services/tax-center";

// Staff-only preview of a questionnaire attachment still in the inbox. The
// file is streamed from Jotform with our API key (jotform.com only); nothing
// is stored until staff assign the questionnaire.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required", { status: 401 });
  const u = new URL(req.url);
  const item = await prisma.jotformInbox.findUnique({ where: { id: u.searchParams.get("inbox") ?? "" } });
  const n = Number(u.searchParams.get("n"));
  if (!item || !Number.isInteger(n)) return new Response("Not found", { status: 404 });
  let url: URL;
  try {
    url = new URL(summarize(await fetchSubmission(item.submissionId)).files[n]);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (url.protocol !== "https:" || !/(^|\.)jotform\.com$/.test(url.hostname)) return new Response("Not found", { status: 404 });
  const key = jotformConfig().apiKey;
  if (key) url.searchParams.set("apiKey", key);
  const res = await fetch(url, { redirect: "follow" }).catch(() => null);
  if (!res?.ok || !res.body) return new Response("Couldn't load the file from Jotform", { status: 502 });
  await audit(prisma, { actorId: user.id, action: "questionnaire.attachment_previewed", entityType: "JotformInbox", entityId: item.id });
  const name = decodeURIComponent(url.pathname.split("/").pop() || "attachment").replace(/[^\w.\- ]/g, "_");
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}
