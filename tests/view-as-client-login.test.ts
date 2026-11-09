import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const req = (path: string, cookies: string[] = []) => {
  const r = new NextRequest(new URL(path, "https://client.example.test"));
  for (const c of cookies) r.cookies.set(c, "x");
  return proxy(r);
};

describe("View as Client never sends staff to the client sign-in page", () => {
  it("a staff member whose preview pass ended goes back to the staff Clients page", () => {
    const res = req("/client/documents", ["tcc_session"]);
    expect(res.headers.get("location")).toBe("https://client.example.test/clients?preview=ended");
  });
  it("with a live preview pass, portal pages open", () => {
    const res = req("/client/documents", ["tcc_session", "tcc_vac"]);
    expect(res.headers.get("location")).toBeNull();
  });
  it("someone signed in nowhere still goes to the client sign-in page", () => {
    expect(req("/client/documents").headers.get("location")).toBe("https://client.example.test/client/login");
  });
  it("a signed-in client is never redirected", () => {
    expect(req("/client/documents", ["tcc_portal"]).headers.get("location")).toBeNull();
  });
});
