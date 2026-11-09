import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import manifest from "@/app/manifest";
import { metadata } from "@/app/layout";

const signedOut = (path: string) => proxy(new NextRequest(new URL(path, "https://client.example.test")));

describe("Home Screen icon and name", () => {
  it("phones can fetch the icon files and manifest without signing in; everything else still needs sign-in", () => {
    for (const p of ["/apple-icon.png", "/icon.png", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]) {
      expect(signedOut(p).headers.get("x-middleware-next"), p).toBe("1");
    }
    for (const [p, login] of [["/client", "/client/login"], ["/staff", "/staff/login"], ["/staff/mfa", "/staff/login"], ["/clients", "/staff/login"]] as const) {
      const res = signedOut(p);
      expect(res.status, p).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, p).toBe(login);
    }
    expect(signedOut("/api/client/anything").status).toBe(401);
  });

  it("shows “Client Connect” under the icon and keeps the full name TTurner Client Connect", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "TTurner Client Connect", short_name: "Client Connect", start_url: "/", display: "browser" });
    expect(m.icons?.map((i) => [i.src, i.sizes, i.purpose])).toEqual([
      ["/icons/icon-192.png", "192x192", "any"],
      ["/icons/icon-512.png", "512x512", "any"],
      ["/icons/icon-maskable-512.png", "512x512", "maskable"],
    ]);
    expect(metadata.appleWebApp).toEqual({ title: "Client Connect", capable: false });
    expect(metadata.title).toMatchObject({ default: "TTurner Client Connect", template: "%s · TTurner Client Connect" });
  });
});
