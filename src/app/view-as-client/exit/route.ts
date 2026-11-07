import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { parsePreviewCookie, VAC_COOKIE } from "@/lib/portal/viewer";

/** Ends View as Client and returns to the client's staff page. */
export async function GET(req: Request) {
  const jar = await cookies();
  const p = parsePreviewCookie(jar.get(VAC_COOKIE)?.value);
  jar.delete(VAC_COOKIE);
  return NextResponse.redirect(new URL(p ? `/clients/${p.c}` : "/clients", req.url));
}
