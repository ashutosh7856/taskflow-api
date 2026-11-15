import { describe, expect, test } from "bun:test";

import { adminEmail, assertAdmin, emailIsConfiguredAdmin } from "./admin";
import { receiptNumber } from "./receipts";

describe("admin access", () => {
  test("uses ADMIN_EMAIL, falling back to the first ADMIN_EMAILS entry", () => {
    const saved = {
      one: process.env.ADMIN_EMAIL,
      many: process.env.ADMIN_EMAILS,
    };
    process.env.ADMIN_EMAIL = "";
    process.env.ADMIN_EMAILS = " Owner@Example.com , other@example.com";
    expect(adminEmail()).toBe("owner@example.com");
    expect(emailIsConfiguredAdmin("OWNER@example.com")).toBe(true);
    expect(emailIsConfiguredAdmin("other@example.com")).toBe(false);
    process.env.ADMIN_EMAIL = "boss@example.com";
    expect(adminEmail()).toBe("boss@example.com");
    process.env.ADMIN_EMAIL = saved.one;
    process.env.ADMIN_EMAILS = saved.many;
  });

  test("a session without an admin code is rejected before any lookup", async () => {
    // No database in this test: the check must fail first.
    await expect(assertAdmin("any-user", false)).rejects.toMatchObject({
      status: 403,
      details: { code: "admin_otp_required" },
    });
  });
});

describe("receipts", () => {
  test("receipt numbers are stable and readable", () => {
    expect(
      receiptNumber({
        id: "3f2a9c1e-0000-4000-8000-000000000000",
        occurredAt: new Date("2026-11-15T10:00:00Z"),
      }),
    ).toBe("DNT-202611-3F2A9C1E");
  });
});
