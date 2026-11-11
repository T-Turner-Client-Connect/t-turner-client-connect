import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { announcementsForClient } from "@/lib/services/news";
import { splitFlyer } from "@/lib/news/flyers";
import { existsSync } from "node:fs";
import path from "node:path";

// Fictional clients only. Tabitha's welcome flyers are built in: tax clients see the tax one,
// bookkeeping clients the bookkeeping one, each once, first.
beforeEach(resetDb);

describe("Welcome flyers in News & Announcements", () => {
  it("tax clients get the tax flyer, bookkeeping clients the bookkeeping flyer; never twice", async () => {
    const tab = await makeUser("ADMIN", "Tabitha");
    const tax = await createClient(tab, { firstName: "Avery", lastName: "Example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const bk = await createClient(tab, { businessName: "Willow Example Florals (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(bk.id);
    await prisma.client.update({ where: { id: bk.id }, data: { services: ["Bookkeeping"] } });

    const [t] = await announcementsForClient(tax.id);
    expect(splitFlyer(t.body).flyer?.key).toBe("welcome-client-connect");
    const [b] = await announcementsForClient(bk.id);
    expect(splitFlyer(b.body).flyer?.key).toBe("welcome-bookkeeping");
    for (const f of ["welcome-client-connect", "welcome-bookkeeping"]) expect(existsSync(path.join(process.cwd(), "public/brand/flyers", `${f}.webp`))).toBe(true);

    // If the office posts the same flyer itself, it isn't shown twice.
    await prisma.announcement.create({ data: { title: "Welcome!", body: "Hello\n\n[[flyer:welcome-client-connect]]", audience: "INDIVIDUAL", publishedAt: new Date(Date.now() - 1000), createdById: tab.id } });
    const list = await announcementsForClient(tax.id);
    expect(list.filter((a) => a.body.includes("[[flyer:welcome-client-connect]]"))).toHaveLength(1);
  });
});
