import { describe, expect, test } from "bun:test";

import { classifyChange, monthlyCents } from "./revenue";
import { revenueReport, type PaymentRow, type SubRow } from "./revenue-report";

const now = new Date("2026-11-21T12:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const sub = (id: string, extra: Partial<SubRow> = {}): SubRow => ({
  userId: `u-${id}`,
  name: id,
  email: `${id}@x.test`,
  plan: "pro",
  interval: "month",
  billingStatus: "active",
  currentPeriodEnd: days(20),
  providerId: `sub-${id}`,
  ...extra,
});
const pay = (id: string, amount: string, at: Date, status = "completed"): PaymentRow => ({
  userId: `u-${id}`,
  providerSubscriptionId: `sub-${id}`,
  status,
  amount,
  currency: "USD",
  occurredAt: at,
});

describe("subscription changes", () => {
  const snap = (state: any, plan = "pro", interval = "month") => ({ state, plan, interval });
  test("classifies the moves that matter", () => {
    expect(classifyChange(snap("none"), snap("active"))).toBe("subscribed");
    expect(classifyChange(snap("ended"), snap("active"))).toBe("subscribed");
    expect(classifyChange(snap("active"), snap("cancelling"))).toBe("cancel_scheduled");
    expect(classifyChange(snap("cancelling"), snap("active"))).toBe("reactivated");
    expect(classifyChange(snap("active"), snap("past_due"))).toBe("payment_failed");
    expect(classifyChange(snap("past_due"), snap("active"))).toBe("recovered");
    expect(classifyChange(snap("cancelling"), snap("ended"))).toBe("ended");
    expect(classifyChange(snap("active"), snap("active", "business"))).toBe("plan_changed");
    expect(classifyChange(snap("active"), snap("active"))).toBeNull();
  });
  test("yearly plans count a twelfth", () => {
    expect(monthlyCents("pro", "month")).toBe(1900);
    expect(monthlyCents("pro", "year")).toBe(Math.round((190 / 12) * 100));
    expect(monthlyCents("free", "month")).toBe(0);
  });
});

describe("revenue report", () => {
  const report = revenueReport(
    [
      sub("paid"), // paying, monthly pro
      sub("trial"), // card trial, no payment yet
      sub("leaving", { billingStatus: "cancelled", currentPeriodEnd: days(5) }), // paid, cancelling
      sub("quit", { billingStatus: "cancelled", currentPeriodEnd: days(3) }), // cancelled in trial
      sub("gone", { billingStatus: "cancelled", currentPeriodEnd: days(-2) }), // churned
      sub("late", { billingStatus: "past_due", plan: "business" }),
    ],
    [
      pay("paid", "19.00", days(-10)),
      pay("leaving", "19.00", days(-40)),
      pay("gone", "19.00", days(-32)),
      pay("late", "49.00", days(-35)),
      pay("paid", "19.00", days(-3), "refunded"),
    ],
    [],
    { users: 40, users30d: 12, usersPrev30d: 8 },
    now,
  );
  test("MRR counts only subscriptions that have paid", () => {
    expect(report.mrrCents).toBe(3800); // paid + leaving
    expect(report.payingCustomers).toBe(2);
    expect(report.trialPipeline).toEqual({ count: 1, valueCents: 1900, cancelledBeforePaying: 1 });
    expect(report.atRisk).toEqual({ cancelling: 1, pastDue: 1, valueCents: 1900 + 4900 });
  });
  test("30-day movements and cash", () => {
    expect(report.last30Days.newCustomers).toBe(1);
    expect(report.last30Days.churnedCustomers).toBe(1);
    expect(report.last30Days.churnedMrrCents).toBe(1900);
    expect(report.cash.allTimeNetCents).toBe(19 * 4 * 100 + 3000 - 1900);
    expect(report.users.growthRate).toBe(0.5);
    expect(report.customers.map((c) => c.status)).toEqual([
      "paying",
      "past_due",
      "cancelling",
      "trial",
      "trial_cancelled",
      "ended",
    ]);
  });
});
