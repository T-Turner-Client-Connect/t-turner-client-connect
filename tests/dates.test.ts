import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { chicagoToday, isFutureDay } from "@/lib/dates";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { submitNotice } from "@/lib/services/notices";

// Oct 31, 2026 is Central Daylight Time (UTC−5).
const AT = {
  beforeNoon: new Date("2026-10-31T13:00:00Z"), // 8:00 a.m. Chicago
  afterNoon: new Date("2026-10-31T19:00:00Z"), // 2:00 p.m. Chicago
  justBeforeMidnight: new Date("2026-11-01T04:59:00Z"), // 11:59 p.m. Oct 31 in Chicago — already Nov 1 in UTC
  justAfterMidnight: new Date("2026-11-01T05:01:00Z"), // 12:01 a.m. Nov 1 in Chicago
};
const TODAY = { beforeNoon: "2026-10-31", afterNoon: "2026-10-31", justBeforeMidnight: "2026-10-31", justAfterMidnight: "2026-11-01" };
const next = (ymd: string) => new Date(Date.parse(`${ymd}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe("date-only fields use Chicago calendar days", () => {
  for (const [when, now] of Object.entries(AT) as [keyof typeof AT, Date][]) {
    it(`${when}: today passes, tomorrow is in the future`, () => {
      const today = TODAY[when];
      expect(chicagoToday(now)).toBe(today);
      expect(isFutureDay(today, now)).toBe(false);
      expect(isFutureDay(next(today), now)).toBe(true);
      // As stored by a date picker (UTC midnight) or at noon — same answer.
      expect(isFutureDay(new Date(`${today}T00:00:00Z`), now)).toBe(false);
      expect(isFutureDay(new Date(`${next(today)}T00:00:00Z`), now)).toBe(true);
      expect(isFutureDay(new Date(`${next(today)}T12:00:00Z`), now)).toBe(true);
    });
  }
});

describe("tax notice received date (service)", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts today and refuses tomorrow at every hour; the upload keeps its real timestamp", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const c = await createClient(tabitha, { firstName: "Robin", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, c.id, { email: "robin@fictional.example", name: "Robin Fictional", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Robin-Pass-12345");
    const user = { id: login.id, name: login.name, email: login.email };
    const file = () => [{ bytes: new TextEncoder().encode(`%PDF-1.4\n% notice ${Math.random()}\n`), originalName: "notice.pdf" }];
    for (const [when, now] of Object.entries(AT) as [keyof typeof AT, Date][]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const today = TODAY[when];
      const r = await submitNotice(user, c.id, { taxYear: "2025", agency: "IRS", receivedOn: today }, file());
      await expect(submitNotice(user, c.id, { taxYear: "2025", agency: "IRS", receivedOn: next(today) }, file())).rejects.toThrow(/can't be in the future/);
      vi.useRealTimers();
      const doc = await prisma.document.findFirstOrThrow({ where: { noticeCaseId: r.case.id } });
      expect(r.case.receivedOn?.toISOString().slice(0, 10)).toBe(today);
      // The upload time is the real instant the database recorded, kept separate from the date received.
      expect(Math.abs(doc.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    }
  });
});
