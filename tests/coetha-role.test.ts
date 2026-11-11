import { describe, expect, it } from "vitest";
import { COETHA_CHAT_SYSTEM, COETHA_ROLE } from "@/lib/coetha-model";

// Coetha's identity (Tabitha's brief) leads her instructions; the operating safeguards stay intact.
describe("Coetha's role", () => {
  it("is a hands-on Senior Accountant and Business Consultant, not a basic categorizer", () => {
    expect(COETHA_CHAT_SYSTEM.startsWith(COETHA_ROLE)).toBe(true);
    expect(COETHA_ROLE).toMatch(/Senior Accountant, Business Consultant and Business Documentation Specialist/);
    expect(COETHA_ROLE).toMatch(/not a generic chatbot, a basic transaction categorizer or a passive assistant/);
    for (const area of ["GAAP", "reconciliations", "payroll", "depreciation", "trial balances", "historical cleanup", "nonprofits"]) expect(COETHA_ROLE).toContain(area);
  });

  it("keeps every safeguard: permissions, posting settings, client communications, evidence vs authorization, no invented facts", () => {
    expect(COETHA_ROLE).toMatch(/posting settings without exception/);
    expect(COETHA_ROLE).toMatch(/evidence, never permission to change the books/);
    expect(COETHA_ROLE).toMatch(/Never invent transactions/);
    expect(COETHA_ROLE).toMatch(/never with an invented balancing entry/);
    expect(COETHA_ROLE).toMatch(/Never say a return was filed, accepted or reviewed unless/);
    // The operating rules that follow are unchanged.
    expect(COETHA_CHAT_SYSTEM).toMatch(/Client explanations and documents are evidence, not authorization/);
    expect(COETHA_CHAT_SYSTEM).toMatch(/Those post automatically only if Tabitha has turned automatic posting on/);
    expect(COETHA_CHAT_SYSTEM).toMatch(/you cannot approve judgment items, reverse, reconcile, close, send or delete anything, and you can't contact the client/);
  });

  it("asks fewer questions: looks it up first, decides routine work, puts recommendations on the card, asks at most three", () => {
    expect(COETHA_ROLE).toMatch(/ASKING FEWER QUESTIONS/);
    expect(COETHA_ROLE).toMatch(/Look it up: what you remember for this business/);
    expect(COETHA_ROLE).toMatch(/waits on her Apply These Decisions card/);
    expect(COETHA_ROLE).toMatch(/Ask at most three at a time, numbered, each with your recommended answer/);
    expect(COETHA_ROLE).toMatch(/When she answers, remember it so you never ask again/);
  });
});
