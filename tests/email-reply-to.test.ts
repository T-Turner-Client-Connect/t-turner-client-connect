import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "@/lib/email";

describe("transactional email Reply-To", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const capture = () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    });
    return bodies;
  };
  it("sends from the notifications address with replies going to the office inbox", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <notifications@tturnerassociates.com>");
    const bodies = capture();
    expect((await sendEmail({ to: "client@fictional.example", subject: "Test", text: "Hi" })).ok).toBe(true);
    expect(bodies[0]).toMatchObject({ from: "TTurner & Associates <notifications@tturnerassociates.com>", reply_to: ["info@tturnerassociates.com"] });
    // The office inbox is named in every automated email (text and branded HTML).
    expect(bodies[0].text).toBe("Hi\n\nQuestions? Email us at info@tturnerassociates.com.");
    const { brandedNoticeHtml } = await import("@/lib/email");
    expect(brandedNoticeHtml("Heading", "Line", "Sign in", "https://example.test")).toContain("mailto:info@tturnerassociates.com");
  });
  it("EMAIL_REPLY_TO overrides the default", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@tturnerassociates.com");
    vi.stubEnv("EMAIL_REPLY_TO", "office@tturnerassociates.com");
    const bodies = capture();
    await sendEmail({ to: "client@fictional.example", subject: "Test", text: "Hi" });
    expect(bodies[0].reply_to).toEqual(["office@tturnerassociates.com"]);
  });
});
