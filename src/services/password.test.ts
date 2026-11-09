import { describe, expect, test } from "bun:test";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  test("hashes and verifies a password without Bun-specific APIs", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash).toStartWith("pbkdf2-sha256$");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  test("rejects malformed hashes", async () => {
    expect(await verifyPassword("password", "not-a-password-hash")).toBe(false);
  });
});
