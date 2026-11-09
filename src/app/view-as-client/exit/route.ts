import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { parsePreviewCookie, VAC_COOKIE } from "@/lib/portal/viewer";

/** Ends View as Client and returns to the client's staff page. */
export async function GET() {
  const jar = await cookies();
  const p = parsePreviewCookie(jar.get(VAC_COOKIE)?.value);
  jar.delete(VAC_COOKIE);
  // Same-site path (see view-as-client/[clientId]/route.ts).
  return new NextResponse(null, { status: 307, headers: { Location: p ? `/clients/${encodeURIComponent(p.c)}` : "/clients" } });
}
