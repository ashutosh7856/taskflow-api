import { describe, expect, test } from "bun:test";
import { nudgeEmail, trialEndingEmail } from "./lifecycle";

const user = { name: "Maya Lee", email: "maya@example.com" };

describe("onboarding emails", () => {
  test("day 2 nudge picks the step the user is stuck on", () => {
    expect(nudgeEmail(user, "done")).toBeNull();
    const share = nudgeEmail(user, "no_portal")!;
    expect(share.title).toContain("Maya");
    expect(share.actionUrl).toEndWith("/app");
    expect(share.details?.[0][1]).toEndWith("/demo");
    expect(nudgeEmail(user, "no_approval")!.subject).toContain("approval");
  });

  test("trial ending email names the date and says nothing is charged", () => {
    const email = trialEndingEmail(user, new Date("2026-12-03T10:00:00Z"));
    expect(email.subject).toBe("Your Danto Pro trial ends on December 3");
    expect(email.message).toContain("won't be charged");
    expect(email.actionUrl).toEndWith("/billing");
  });
});
