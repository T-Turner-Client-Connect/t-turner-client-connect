import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, resetDb } from "./db";
import { appUrl, isPreviewDeploy } from "@/lib/integrations";
import { sendEmail } from "@/lib/email";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, findOpenPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("preview sites", () => {
  it("links point to the site that created them, and previews don't send email", async () => {
    vi.stubEnv("APP_URL", "https://client.tturnerassociates.com");
    vi.stubEnv("BUILD_CONTEXT", "production");
    expect(appUrl()).toBe("https://client.tturnerassociates.com");
    vi.stubEnv("BUILD_CONTEXT", "deploy-preview");
    vi.stubEnv("BUILD_DEPLOY_URL", "https://deploy-preview-56--tturnerclientconnect.netlify.app");
    expect(isPreviewDeploy()).toBe(true);
    expect(appUrl()).toBe("https://deploy-preview-56--tturnerclientconnect.netlify.app");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "notifications@tturnerassociates.com");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await sendEmail({ to: "client@fictional.example", subject: "Activate", text: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/preview sites/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("activation links", () => {
  beforeEach(resetDb);
  it("opening or previewing the link (even many times) never uses it; only setting the password does", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Lina", lastName: "Fictional", email: "lina@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tab, c.id, { email: "lina@fictional.example", name: "Lina Fictional", role: "OWNER" });
    for (let i = 0; i < 4; i++) expect(await findOpenPortalInvite(token!)).not.toBeNull(); // email scanner + preview + clicks
    const user = await acceptPortalInvite(token!, "Lina-Portal-Pass-123");
    expect(user.email).toBe("lina@fictional.example");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await findOpenPortalInvite(token!)).toBeNull();
    expect(info).toHaveBeenLastCalledWith("Portal invitation link not valid: already used");
    expect(JSON.stringify(info.mock.calls)).not.toContain(token!);
  });

  it("a newer invitation replaces the older one, and a link from another site's database is reported as such", async () => {
    const tab = await makeUser("ADMIN");
    const c = await createClient(tab, { firstName: "Omar", lastName: "Fictional", email: "omar@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const first = await invitePortalUser(tab, c.id, { email: "omar@fictional.example", name: "Omar", role: "OWNER" });
    const second = await invitePortalUser(tab, c.id, { email: "omar@fictional.example", name: "Omar", role: "OWNER" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await findOpenPortalInvite(first.token!)).toBeNull();
    expect(info).toHaveBeenLastCalledWith("Portal invitation link not valid: replaced by a newer invitation");
    expect(await findOpenPortalInvite(second.token!)).not.toBeNull();
    expect(await findOpenPortalInvite("token-created-on-a-preview-site")).toBeNull();
    expect(info).toHaveBeenLastCalledWith(expect.stringMatching(/not found in this site's database/));
  });
});
