import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards against a merge silently dropping a tab's content: every tab in the
 * client page's menu must have a matching `tab === "<key>"` section, and the
 * Taxes tab must keep the state/amended "Finish & Send" flags.
 */
const src = readFileSync(path.join(process.cwd(), "src/app/(app)/clients/[id]/page.tsx"), "utf8");
const menu = [...src.slice(src.indexOf("const TABS"), src.indexOf("];", src.indexOf("const TABS"))).matchAll(/key: "([a-z-]+)"/g)].map((m) => m[1]);

describe("Client page tabs", () => {
  it("every menu tab renders something", () => {
    expect(menu.length).toBeGreaterThan(5);
    for (const key of menu) {
      if (key === "overview") continue;
      expect(src, `tab "${key}" has no content`).toMatch(new RegExp(`tab === "${key}"`));
    }
  });

  it("Finish & Send keeps the state and amended return flags", () => {
    expect(src).toContain('state: sp.jur === "state"');
    expect(src).toContain('amended: sp.amended === "1"');
  });
});
