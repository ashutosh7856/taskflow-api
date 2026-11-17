import { describe, expect, test } from "bun:test";

import { trialDaysLeft, verifyDodoWebhook } from "./dodo";
import { deferredDays } from "../routes/dodo";

const secret = "whsec_" + btoa("danto-test-secret-0123456789abcdef");

async function sign(id: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe("verifyDodoWebhook", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"payment.succeeded"}';

  test("accepts a valid signature, also among several", async () => {
    const sig = await sign("msg_1", ts, body);
    const headers = { id: "msg_1", timestamp: ts, signature: `v1,${sig}` };
    expect(await verifyDodoWebhook(body, headers, secret, now)).toBe(true);
    headers.signature = `v1,bogus v1,${sig}`;
    expect(await verifyDodoWebhook(body, headers, secret, now)).toBe(true);
  });

  test("rejects tampered body, wrong id and stale timestamps", async () => {
    const sig = `v1,${await sign("msg_1", ts, body)}`;
    expect(
      await verifyDodoWebhook(body + " ", { id: "msg_1", timestamp: ts, signature: sig }, secret, now),
    ).toBe(false);
    expect(
      await verifyDodoWebhook(body, { id: "msg_2", timestamp: ts, signature: sig }, secret, now),
    ).toBe(false);
    expect(
      await verifyDodoWebhook(body, { id: "msg_1", timestamp: ts, signature: sig }, secret, now + 10 * 60_000),
    ).toBe(false);
    expect(await verifyDodoWebhook(body, { id: "msg_1", timestamp: ts }, secret, now)).toBe(false);
  });
});

describe("trial deferral", () => {
  const base = {
    userId: "u",
    paypalSubscriptionId: null,
    dodoSubscriptionId: null,
    dodoCustomerId: null,
    billingInterval: "month" as const,
    discountCodeId: null,
    aiRequestsThisMonth: 0,
    aiPeriodStart: new Date(),
    updatedAt: new Date(),
  };
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 - 60_000);

  test("trial users pay nothing until the trial ends, for any plan", () => {
    const trial = { ...base, plan: "pro" as const, billingStatus: "cancelled" as const, currentPeriodEnd: inDays(9) };
    expect(deferredDays(trial, "pro")).toBe(9);
    expect(deferredDays(trial, "business")).toBe(9);
  });

  test("expired trial, free plan and renewing subscribers pay now", () => {
    expect(deferredDays({ ...base, plan: "pro", billingStatus: "cancelled", currentPeriodEnd: inDays(-1) }, "pro")).toBe(0);
    expect(deferredDays({ ...base, plan: "free", billingStatus: "inactive", currentPeriodEnd: null }, "pro")).toBe(0);
    expect(deferredDays({ ...base, plan: "pro", billingStatus: "active", dodoSubscriptionId: "sub", currentPeriodEnd: inDays(20) }, "pro")).toBe(0);
  });

  test("paid-then-cancelled access carries over only to the same plan", () => {
    const row = { ...base, plan: "pro" as const, billingStatus: "cancelled" as const, dodoSubscriptionId: "sub", currentPeriodEnd: inDays(5) };
    expect(deferredDays(row, "pro")).toBe(5);
    expect(deferredDays(row, "business")).toBe(0);
  });

  test("trialDaysLeft rounds up partial days", () => {
    expect(trialDaysLeft(new Date(Date.now() + 1000))).toBe(1);
    expect(trialDaysLeft(null)).toBe(0);
  });
});
