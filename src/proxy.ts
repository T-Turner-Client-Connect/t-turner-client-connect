import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate only: sends visitors without the right session cookie to
 * the matching sign-in page. Every page, Server Action and API route still
 * verifies the session, MFA state and permissions against the database — a
 * URL is never treated as protection.
 */
// Public policy pages and the SMS consent form need no login.
const PUBLIC_PAGES = ["/sms-consent", "/privacy-policy", "/terms"];
const PUBLIC_STAFF = ["/welcome", "/staff/login", "/staff/setup", "/staff/invite/", "/staff/forgot-password", "/staff/reset-password/", "/brand/", "/icon.png", "/favicon"];
const PUBLIC_PORTAL = ["/client/login", "/client/signup", "/client/activate", "/client/invite/", "/client/forgot-password", "/client/reset-password/"];
// Webhooks authenticate themselves (shared secret + provider API verification).
const PUBLIC_API = ["/api/webhooks/", "/api/cron/"];

const has = (req: NextRequest, names: string[]) => names.some((n) => req.cookies.has(n));

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if ([...PUBLIC_PAGES, ...PUBLIC_STAFF, ...PUBLIC_PORTAL, ...PUBLIC_API].some((p) => pathname.startsWith(p))) return NextResponse.next();

  const portalArea = pathname === "/client" || pathname.startsWith("/client/") || pathname.startsWith("/api/client/");
  const staffCookie = has(request, ["__Host-tcc_session", "tcc_session"]);
  const portalCookie = has(request, ["__Host-tcc_portal", "tcc_portal"]);

  // Document downloads accept either kind of session; the route decides.
  if (pathname.startsWith("/api/documents/")) {
    return staffCookie || portalCookie ? NextResponse.next() : NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (portalArea) {
    if (portalCookie) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    return NextResponse.redirect(new URL("/client/login", request.url));
  }
  if (staffCookie) return NextResponse.next();
  // The main site address shows the branded welcome page (Staff Login / Client
  // Login) without changing the URL; a signed-in client goes to their portal.
  if (pathname === "/") {
    return portalCookie ? NextResponse.redirect(new URL("/client", request.url)) : NextResponse.rewrite(new URL("/welcome", request.url));
  }
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.redirect(new URL("/staff/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
