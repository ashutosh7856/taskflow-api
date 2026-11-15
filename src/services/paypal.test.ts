import { afterEach, describe, expect, test } from "bun:test";

import { paypalPlanUsable } from "./paypal";

const realFetch = globalThis.fetch;
const saved = { ...process.env };

function fakePayPal(planStatus: number, body: unknown = {}) {
  process.env.PAYPAL_ENV = "sandbox";
  process.env.PAYPAL_CLIENT_ID = "id";
  process.env.PAYPAL_CLIENT_SECRET = "secret";
  globalThis.fetch = (async (url: string) =>
    String(url).endsWith("/v1/oauth2/token")
      ? Response.json({ access_token: "token" })
      : Response.json(body, { status: planStatus })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...saved };
});

describe("paypalPlanUsable", () => {
  test("no saved plan is never usable", async () => {
    expect(await paypalPlanUsable(null)).toBe(false);
  });

  test("a plan from the other PayPal mode (404) is rebuilt, not reused", async () => {
    fakePayPal(404);
    expect(await paypalPlanUsable("P-LIVE-ONLY")).toBe(false);
  });

  test("an active plan is reused", async () => {
    fakePayPal(200, { status: "ACTIVE" });
    expect(await paypalPlanUsable("P-ACTIVE")).toBe(true);
  });

  test("an inactive plan is rebuilt", async () => {
    fakePayPal(200, { status: "INACTIVE" });
    expect(await paypalPlanUsable("P-OFF")).toBe(false);
  });

  test("a PayPal outage is an error, not a silent rebuild", async () => {
    fakePayPal(500);
    await expect(paypalPlanUsable("P-OUTAGE")).rejects.toMatchObject({
      status: 502,
    });
  });
});
