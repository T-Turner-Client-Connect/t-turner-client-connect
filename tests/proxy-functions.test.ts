import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "@/proxy";

const signedOut = (path: string, method = "GET") => proxy(new NextRequest(new URL(path, "https://client.example.test"), { method }));

describe("Netlify function endpoints pass the sign-in gate", () => {
  it("a background function call (Coetha's reader) is never redirected to the sign-in page", () => {
    const r = signedOut("/.netlify/functions/coetha-reading-background", "POST");
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    // The matcher skips them entirely, too.
    expect(new RegExp(`^${config.matcher[0]}$`).test("/.netlify/functions/coetha-reading-background")).toBe(false);
  });

  it("everything else still needs a session", () => {
    expect(signedOut("/clients").status).toBe(307);
    expect(signedOut("/api/coetha/progress", "POST").status).toBe(401);
    expect(signedOut("/client").headers.get("location")).toMatch(/\/client\/login$/);
  });
});
