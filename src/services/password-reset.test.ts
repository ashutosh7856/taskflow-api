import { describe, expect, test } from "bun:test";

import { hashResetCode } from "./password-reset";

describe("password reset codes", () => {
  test("hash is deterministic per user and differs across users and codes", async () => {
    const a = await hashResetCode("user-1", "123456");
    expect(a).toBe(await hashResetCode("user-1", "123456"));
    expect(a).not.toBe(await hashResetCode("user-2", "123456"));
    expect(a).not.toBe(await hashResetCode("user-1", "123457"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
