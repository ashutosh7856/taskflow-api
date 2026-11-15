import { beforeEach, describe, expect, test } from "bun:test";

import {
  cached,
  cachedEdgeJson,
  clearCache,
  invalidate,
  invalidateEdge,
} from "./cache";

describe("read-through cache", () => {
  beforeEach(() => clearCache());

  test("serves repeat reads from memory until TTL or invalidation", async () => {
    let loads = 0;
    const load = async () => ++loads;
    expect(await cached("k", 60, load)).toBe(1);
    expect(await cached("k", 60, load)).toBe(1);
    invalidate("k");
    expect(await cached("k", 60, load)).toBe(2);
  });

  test("expired entries reload", async () => {
    let loads = 0;
    await cached("t", 0, async () => ++loads);
    await new Promise((r) => setTimeout(r, 5));
    expect(await cached("t", 0, async () => ++loads)).toBe(2);
  });

  test("errors are not cached", async () => {
    await expect(
      cached("e", 60, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow();
    expect(await cached("e", 60, async () => "ok")).toBe("ok");
  });

  test("edge cache works without Cache API (Bun) and invalidates", async () => {
    let loads = 0;
    expect(await cachedEdgeJson("p", 20, async () => ({ n: ++loads }))).toEqual(
      { n: 1 },
    );
    expect(await cachedEdgeJson("p", 20, async () => ({ n: ++loads }))).toEqual(
      { n: 1 },
    );
    await invalidateEdge("p");
    expect(await cachedEdgeJson("p", 20, async () => ({ n: ++loads }))).toEqual(
      { n: 2 },
    );
  });
});
