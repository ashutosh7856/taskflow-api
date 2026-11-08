import { describe, expect, test } from "bun:test";

import { hasSeatCapacity, planCatalog } from "./entitlements";

describe("account plan entitlements", () => {
  test("plans grow in price, seats, and pooled AI usage", () => {
    expect(planCatalog.free.priceUsd).toBe(0);
    expect(planCatalog.free.aiRequests).toBe(10);
    expect(planCatalog.pro.priceUsd).toBeLessThan(
      planCatalog.business.priceUsd,
    );
    expect(planCatalog.free.seats).toBeLessThan(planCatalog.pro.seats);
    expect(planCatalog.pro.seats).toBeLessThan(planCatalog.business.seats);
    expect(planCatalog.free.aiRequests).toBeLessThan(
      planCatalog.pro.aiRequests,
    );
    expect(planCatalog.pro.aiRequests).toBeLessThan(
      planCatalog.business.aiRequests,
    );
  });

  test.each([
    [0, "free", true],
    [2, "free", true],
    [3, "free", false],
    [4, "pro", true],
    [5, "pro", false],
    [24, "business", true],
    [25, "business", false],
  ] as const)(
    "seat boundary: %i seats on %s is %s",
    (seats, plan, expected) => {
      expect(hasSeatCapacity(seats, plan)).toBe(expected);
    },
  );
});
