import { describe, expect, test } from "bun:test";

import { normalizeDatabaseUrl } from "./database-url";

describe("database URL normalization", () => {
  test("removes Neon's unsupported channel binding parameter", () => {
    const normalized = normalizeDatabaseUrl(
      "postgresql://user:pass@example.com/app?sslmode=require&channel_binding=require",
    );

    expect(normalized).toContain("sslmode=require");
    expect(normalized).not.toContain("channel_binding");
  });

  test("rejects missing or non-PostgreSQL URLs", () => {
    expect(() => normalizeDatabaseUrl(undefined)).toThrow();
    expect(() => normalizeDatabaseUrl("https://example.com")).toThrow();
  });
});
