import { describe, expect, it } from "vitest";
import { actionFailureMessage } from "@/components/action-form";

describe("form error messages say what actually went wrong", () => {
  it("an out-of-date page (deployment changed) asks for a reload, not a connection check", () => {
    const err = new Error('Server Action "70294704f36b7ebbe700f2a429691adee0e73588cd" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action');
    expect(actionFailureMessage(err, true)).toMatch(/updated while this page was open.*Reload the page/);
  });
  it("offline is reported as offline", () => {
    expect(actionFailureMessage(new TypeError("Failed to fetch"), false)).toMatch(/offline/);
  });
  it("anything else is a server-side problem, not the user's connection", () => {
    const m = actionFailureMessage(new Error("An unexpected response was received from the server."), true);
    expect(m).toMatch(/went wrong on our side/);
    expect(m).not.toMatch(/connection/);
  });
});
