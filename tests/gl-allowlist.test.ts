import { describe, expect, it } from "vitest";
import { clientText, GL_ENTRY_LABEL, glLineDescription } from "@/lib/services/client-statements";

// The client's General Ledger PDF reads only allowlisted fields. Fictional text only.
describe("General Ledger line descriptions (allowlist)", () => {
  const sensitive = "Owner may be hiding cash income; double-check before filing";

  it("the old word filter let internal wording through when it used words the filter didn't list (the original risk)", () => {
    // clientText removes only listed words; this sentence has none of them and passed unchanged.
    expect(clientText(sensitive)).toBe(sensitive);
  });

  it("a manual or adjusting entry shows only a fixed label, whatever its memo or line notes say", () => {
    for (const source of ["MANUAL", "ADJUSTMENT", "REVERSAL", "OPENING"]) {
      const d = glLineDescription({ source, bankTransactions: [] });
      expect(d).toBe(GL_ENTRY_LABEL[source]);
      expect(d).not.toMatch(/hiding|owner|coetha|tabitha|review/i);
    }
    expect(glLineDescription({ source: "SOMETHING_NEW", bankTransactions: [] })).toBe("Journal entry");
  });

  it("a bank or card line shows the bank's own description (the words on the client's statement)", () => {
    expect(glLineDescription({ source: "BANK", bankTransactions: [{ description: "  CARD PURCHASE   HARBOR SUPPLY CO  " }] })).toBe("CARD PURCHASE HARBOR SUPPLY CO");
  });
});
