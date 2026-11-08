import { describe, expect, test } from "bun:test";

import { hasSeatCapacity, planCatalog } from "./entitlements";

describe("account plan entitlements", () => {
  test("plans grow in price, board capacity, and AI usage", () => {
    expect(planCatalog.free.priceUsd).toBe(0);
    expect(planCatalog.free.aiRequests).toBe(20);
    expect(planCatalog.pro.priceUsd).toBeLessThan(
      planCatalog.business.priceUsd,
    );
    expect(planCatalog.free.boards).toBe(3);
    expect(planCatalog.pro.boards).toBeNull();
    expect(planCatalog.free.collaboration).toBe(false);
    expect(planCatalog.pro.collaboration).toBe(false);
    expect(planCatalog.business.collaboration).toBe(true);
    expect(planCatalog.pro.aiRequests).toBe(500);
    expect(planCatalog.business.aiRequests).toBeNull();
  });

  test.each([
    [0, "free", true],
    [1, "free", false],
    [0, "pro", true],
    [1, "pro", false],
    [24, "business", true],
    [25, "business", false],
  ] as const)(
    "seat boundary: %i seats on %s is %s",
    (seats, plan, expected) => {
      expect(hasSeatCapacity(seats, plan)).toBe(expected);
    },
  );
});
