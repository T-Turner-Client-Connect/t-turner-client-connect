import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate only: sends visitors without a session cookie to /login.
 * Every page, Server Action and API route still verifies the session and
 * role against the database — a URL is never treated as protection.
 */
const PUBLIC_PREFIXES = ["/login", "/setup", "/invite", "/forgot-password", "/reset-password", "/brand", "/icon.png", "/favicon"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  const hasSession = request.cookies.has("__Host-tcc_session") || request.cookies.has("tcc_session");
  if (hasSession) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
