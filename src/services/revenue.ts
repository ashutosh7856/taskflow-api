import { planCatalog } from "./entitlements";

/**
 * Revenue bookkeeping for the admin: what a subscription is worth per month
 * and what kind of change moved it.
 */
export type SubState = "none" | "active" | "cancelling" | "past_due" | "ended";

export type SubSnapshot = {
  state: SubState;
  plan: string | null;
  interval: string | null;
};

export type ChangeKind =
  | "subscribed"
  | "cancel_scheduled"
  | "reactivated"
  | "payment_failed"
  | "recovered"
  | "ended"
  | "plan_changed";

/** Monthly value in cents at list price; yearly plans count 1/12. */
export function monthlyCents(plan: string | null, interval: string | null) {
  if (plan !== "pro" && plan !== "business") return 0;
  const price = planCatalog[plan];
  return Math.round(
    (interval === "year" ? price.yearlyPriceUsd / 12 : price.priceUsd) * 100,
  );
}

/**
 * The state of the paid subscription stored on an account. Accounts with no
 * provider subscription (free, reverse trial, comped) are "none".
 */
export function storedState(
  row: {
    billingStatus: string;
    currentPeriodEnd: Date | null;
    providerId: string | null;
  },
  now = new Date(),
): SubState {
  if (!row.providerId) return "none";
  if (row.billingStatus === "active") return "active";
  if (row.billingStatus === "past_due") return "past_due";
  if (row.billingStatus === "cancelled")
    return row.currentPeriodEnd && row.currentPeriodEnd > now
      ? "cancelling"
      : "ended";
  return "none";
}

/** What changed between two snapshots, or null when nothing did. */
export function classifyChange(
  before: SubSnapshot,
  after: SubSnapshot,
): ChangeKind | null {
  if (before.state === after.state) {
    if (
      after.state === "active" &&
      (before.plan !== after.plan || before.interval !== after.interval)
    )
      return "plan_changed";
    return null;
  }
  switch (after.state) {
    case "active":
      if (before.state === "cancelling") return "reactivated";
      if (before.state === "past_due") return "recovered";
      return "subscribed";
    case "cancelling":
      return before.state === "none" ? null : "cancel_scheduled";
    case "past_due":
      return "payment_failed";
    case "ended":
      return before.state === "none" ? null : "ended";
    default:
      return null;
  }
}

/** Value that counts toward MRR in each state. */
export function countedCents(snapshot: SubSnapshot) {
  return snapshot.state === "active" ||
    snapshot.state === "cancelling" ||
    snapshot.state === "past_due"
    ? monthlyCents(snapshot.plan, snapshot.interval)
    : 0;
}
