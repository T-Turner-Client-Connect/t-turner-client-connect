import { beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { isValidElement } from "react";
import { makeUser, prisma, resetDb } from "./db";
import { FLYERS, joinFlyer, splitFlyer } from "@/lib/news/flyers";
import { saveAnnouncement } from "@/lib/services/news";
import { campaignFromAnnouncement } from "@/lib/services/campaigns";
import { NewsList } from "@/components/portal/luxury";

type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, els: El[] = []) {
  if (Array.isArray(node)) for (const n of node) walk(n, els);
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    els.push(el);
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v)) walk(v, els);
  }
  return els;
}

describe("Flyer markers", () => {
  it("saves the chosen flyer with the message and reads it back; the client never sees the marker", () => {
    const body = joinFlyer("Your secure client portal is here.", "welcome-client-connect");
    expect(body).toContain("[[flyer:welcome-client-connect]]");
    const { text, flyer } = splitFlyer(body);
    expect(text).toBe("Your secure client portal is here.");
    expect(flyer?.src).toBe("/brand/flyers/welcome-client-connect.webp");
  });

  it("an unknown or outside image is never shown, and re-saving doesn't stack markers", () => {
    expect(splitFlyer("Hi [[flyer:https-evil-example]] there").flyer).toBeNull();
    expect(splitFlyer("Hi [[flyer:https-evil-example]] there").text).not.toContain("[[");
    expect(joinFlyer("Hello", "not-a-flyer")).toBe("Hello");
    const twice = joinFlyer(joinFlyer("Hello", "welcome-client-connect"), "welcome-client-connect");
    expect(twice.match(/\[\[flyer:/g)?.length).toBe(1);
    expect(joinFlyer(joinFlyer("Hello", "welcome-client-connect"), "")).toBe("Hello");
  });

  it("every approved flyer file exists in public/", () => {
    for (const f of Object.values(FLYERS)) expect(existsSync(path.join(process.cwd(), "public", f.src))).toBe(true);
  });
});

describe("Client News & Announcements", () => {
  const item = { id: "a1", title: "Welcome to TTurner Client Connect", body: "Your secure client portal is here.", topic: "GENERAL", clientId: null, pinned: true, flyer: { src: FLYERS["welcome-client-connect"].src, alt: FLYERS["welcome-client-connect"].alt } };

  it("the full news page shows the flyer full width, with alt text, opening it larger in a new tab", () => {
    const els = walk(NewsList({ items: [item], href: "/client/news", full: true }));
    const link = els.find((e) => e.props["data-testid"] === "news-flyer");
    expect(link?.props.href).toBe(item.flyer.src);
    expect(link?.props.target).toBe("_blank");
    const img = els.find((e) => e.type === "img" && e.props.alt === item.flyer.alt);
    expect(img?.props.src).toBe(item.flyer.src);
  });

  it("the home summary uses the flyer as the thumbnail and doesn't show the full image", () => {
    const els = walk(NewsList({ items: [item], href: "/client/news" }));
    expect(els.some((e) => e.props["data-testid"] === "news-flyer")).toBe(false);
    expect(els.some((e) => e.type === "img" && e.props.src === item.flyer.src)).toBe(true);
  });
});

describe("Saving and reusing", () => {
  beforeEach(resetDb);

  it("an announcement with a flyer keeps the marker in storage; an email made from it gets the text only", async () => {
    const admin = await makeUser("ADMIN", "Tabitha");
    const a = await saveAnnouncement(admin, { title: "Welcome to TTurner Client Connect", body: joinFlyer("Your secure client portal is here.", "welcome-client-connect"), audience: "INDIVIDUAL", topic: "GENERAL", pinned: true, publishAt: null, expiresAt: null });
    expect((await prisma.announcement.findUniqueOrThrow({ where: { id: a.id } })).body).toContain("[[flyer:welcome-client-connect]]");
    const c = await campaignFromAnnouncement(admin, a.id);
    expect(c.body).toBe("Your secure client portal is here.");
  });
});

describe("Bookkeeping clients see office news on their business home", () => {
  beforeEach(resetDb);

  it("a Bookkeeping-clients announcement reaches a bookkeeping client and not an individual-only client", async () => {
    const { createClient } = await import("@/lib/services/clients");
    const { announcementsForClient } = await import("@/lib/services/news");
    const admin = await makeUser("ADMIN", "Tabitha");
    const biz = await createClient(admin, { firstName: "Juniper", lastName: "Ashcombe", businessName: "Ashcombe Bakery, LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await prisma.bookkeepingPeriod.create({ data: { clientId: biz.id, year: 2026, month: 10 } });
    const ind = await createClient(admin, { firstName: "Wren", lastName: "Halloway", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await saveAnnouncement(admin, { title: "Welcome, bookkeeping clients", body: joinFlyer("Your books, in one place.", "welcome-client-connect"), audience: "BOOKKEEPING", topic: "GENERAL", pinned: true, publishAt: null, expiresAt: null });
    expect((await announcementsForClient(biz.id)).map((a) => a.title)).toContain("Welcome, bookkeeping clients");
    expect((await announcementsForClient(ind.id)).map((a) => a.title)).not.toContain("Welcome, bookkeeping clients");
  });
});
