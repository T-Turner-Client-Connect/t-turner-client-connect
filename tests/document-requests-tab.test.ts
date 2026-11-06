import { beforeEach, describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { createDocumentRequest } from "@/lib/services/bookkeeping";
import { DocumentsTab } from "@/components/client-tabs/documents";
import { DocumentRequestsCard } from "@/components/client-tabs/document-requests";
import { BookkeepingTab } from "@/components/client-tabs/bookkeeping";

/** Document requests live on the Documents tab: one list, one "Request a document". Fictional client only. */
type El = { type: unknown; props: Record<string, unknown> };
function walk(node: unknown, els: El[] = [], text: string[] = []) {
  if (Array.isArray(node)) for (const n of node) walk(n, els, text);
  else if (typeof node === "string" || typeof node === "number") text.push(String(node));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    els.push(el);
    for (const v of Object.values(el.props)) if (Array.isArray(v) || isValidElement(v) || typeof v === "string" || typeof v === "number") walk(v, els, text);
  }
  return { els, text };
}

beforeEach(resetDb);

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  const client = await createClient(tabitha, { firstName: "Wren", lastName: "Halloway", clientType: "INDIVIDUAL", status: "ACTIVE" });
  return { tabitha, client };
}

describe("Document requests on the Documents tab", () => {
  it("the Documents tab shows the requests card first; the Bookkeeping tab no longer has its own 'Other document requests' card", async () => {
    const { tabitha, client } = await setup();
    const docs = walk(await DocumentsTab({ clientId: client.id, user: tabitha }));
    expect(docs.els.some((e) => e.type === DocumentRequestsCard)).toBe(true);
    const bk = walk(await BookkeepingTab({ clientId: client.id })).text.join(" ");
    expect(bk).not.toContain("Other document requests");
    expect(bk).toContain("on the");
  });

  it("lists every request (month-tied and not), labeled, open ones first and finished ones folded away", async () => {
    const { tabitha, client } = await setup();
    const period = await prisma.bookkeepingPeriod.create({ data: { clientId: client.id, year: 2026, month: 9 } });
    await createDocumentRequest(tabitha, { clientId: client.id, title: "2025 W-2 from your employer" });
    await createDocumentRequest(tabitha, { clientId: client.id, title: "September bank statement", periodId: period.id });
    const done = await createDocumentRequest(tabitha, { clientId: client.id, title: "2024 1098" });
    await prisma.documentRequest.update({ where: { id: done.id }, data: { status: "ACCEPTED" } });

    const { els, text } = walk(await DocumentRequestsCard({ clientId: client.id }));
    const all = text.join(" ");
    expect(all).toContain("2025 W-2 from your employer");
    expect(all).toContain("Not tied to a month");
    expect(all).toContain("September bank statement");
    expect(all).toContain("Bookkeeping September 2026");
    expect(all).toMatch(/Completed and cancelled \(\s*1\s*\)/);
    const openList = els.find((e) => e.props["data-testid"] === "open-requests");
    const openText = walk(openList).text.join(" ");
    expect(openText).toContain("2025 W-2");
    expect(openText).not.toContain("2024 1098");
    expect(all).toContain("Request a document");
  });

  it("only this client's requests", async () => {
    const { tabitha, client } = await setup();
    const other = await createClient(tabitha, { firstName: "Marlowe", lastName: "Finch", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await createDocumentRequest(tabitha, { clientId: other.id, title: "Someone else's 1099" });
    const all = walk(await DocumentRequestsCard({ clientId: client.id })).text.join(" ");
    expect(all).not.toContain("Someone else's 1099");
    expect(all).toContain("Nothing requested right now.");
  });
});
