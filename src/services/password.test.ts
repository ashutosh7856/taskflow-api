import { describe, expect, test } from "bun:test";

import {
  hashPassword,
  passwordHashFormat,
  passwordNeedsRehash,
  verifyPassword,
} from "./password";

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

  test("identifies hashes that need a Worker-compatible rehash", () => {
    expect(passwordHashFormat("$argon2id$v=19$m=65536,t=2,p=1$salt$hash")).toBe(
      "argon2",
    );
    expect(passwordNeedsRehash("$argon2id$v=19$m=65536,t=2,p=1$salt$hash")).toBe(
      true,
    );
    expect(passwordNeedsRehash("pbkdf2-sha256$310000$salt$hash")).toBe(true);
    expect(passwordNeedsRehash("pbkdf2-sha256$100000$salt$hash")).toBe(false);
  });
});
