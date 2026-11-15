import { describe, expect, test } from "bun:test";

import { hasSeatCapacity, planCatalog } from "./entitlements";

describe("account plan entitlements", () => {
  test("plans grow in price, board capacity, and AI usage", () => {
    expect(planCatalog.free.priceUsd).toBe(0);
    expect(planCatalog.free.aiRequests).toBe(10);
    expect(planCatalog.pro.priceUsd).toBeLessThan(
      planCatalog.business.priceUsd,
    );
    expect(planCatalog.free.boards).toBe(3);
    expect(planCatalog.pro.boards).toBeNull();
    expect(planCatalog.free.collaboration).toBe(false);
    expect(planCatalog.pro.collaboration).toBe(true);
    expect(planCatalog.pro.workspacePulse).toBe(false);
    expect(planCatalog.business.collaboration).toBe(true);
    expect(planCatalog.business.workspacePulse).toBe(true);
    expect(planCatalog.pro.aiRequests).toBe(300);
    expect(planCatalog.business.aiRequests).toBe(1500);
  });

  test("client portal entitlements gate the paid upgrade path", () => {
    expect(planCatalog.free.clientPortals).toBe(1);
    expect(planCatalog.free.portalBranding).toBe(false);
    expect(planCatalog.free.whiteLabel).toBe(false);
    expect(planCatalog.pro.clientPortals).toBeNull();
    expect(planCatalog.pro.portalBranding).toBe(true);
    expect(planCatalog.pro.whiteLabel).toBe(false);
    expect(planCatalog.business.whiteLabel).toBe(true);
    expect(planCatalog.pro.priceUsd).toBe(19);
    expect(planCatalog.business.priceUsd).toBe(49);
  });

  test.each([
    [0, "free", true],
    [1, "free", false],
    [0, "pro", true],
    [2, "pro", true],
    [3, "pro", false],
    [9, "business", true],
    [10, "business", false],
  ] as const)(
    "seat boundary: %i seats on %s is %s",
    (seats, plan, expected) => {
      expect(hasSeatCapacity(seats, plan)).toBe(expected);
    },
  );
});
