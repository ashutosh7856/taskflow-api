import { monthlyCents, storedState } from "./revenue";

/**
 * The admin Revenue tab, computed from plain rows so it can be tested.
 *
 * Definitions (kept strict so the numbers are safe to share publicly):
 * - MRR counts subscriptions that have actually paid at least once and are
 *   still active, including ones cancelling at the end of a paid period.
 *   Yearly plans count 1/12 per month. List price, before tax.
 * - Trials with a card are pipeline, not MRR, until their first payment.
 * - Cash numbers are real payments minus refunds, in USD.
 */
export type SubRow = {
  userId: string;
  name: string | null;
  email: string | null;
  plan: string;
  interval: string;
  billingStatus: string;
  currentPeriodEnd: Date | null;
  providerId: string | null;
};

export type PaymentRow = {
  userId: string | null;
  providerSubscriptionId: string | null;
  status: string;
  amount: string;
  currency: string;
  occurredAt: Date;
};

export type EventRow = {
  userId: string | null;
  email: string | null;
  kind: string;
  plan: string | null;
  billingInterval: string | null;
  trial: boolean;
  mrrBeforeCents: number;
  mrrAfterCents: number;
  occurredAt: Date;
};

export type CustomerStatus =
  | "paying"
  | "cancelling"
  | "trial"
  | "trial_cancelled"
  | "past_due"
  | "ended";

const DAY = 86_400_000;
const cents = (amount: string) => Math.round(Number(amount || 0) * 100);
const monthKey = (date: Date) => date.toISOString().slice(0, 7);

export function revenueReport(
  subs: SubRow[],
  payments: PaymentRow[],
  events: EventRow[],
  totals: { users: number; users30d: number; usersPrev30d: number },
  now = new Date(),
) {
  const usd = payments.filter((p) => p.currency.toUpperCase() === "USD");
  const paidBySub = new Map<string, { paid: number; first: Date | null }>();
  for (const payment of usd) {
    if (!payment.providerSubscriptionId) continue;
    const entry = paidBySub.get(payment.providerSubscriptionId) || {
      paid: 0,
      first: null,
    };
    if (payment.status === "completed") {
      entry.paid += cents(payment.amount);
      if (!entry.first || payment.occurredAt < entry.first)
        entry.first = payment.occurredAt;
    } else if (payment.status === "refunded") entry.paid -= cents(payment.amount);
    paidBySub.set(payment.providerSubscriptionId, entry);
  }

  const customers = subs
    .filter((sub) => sub.providerId)
    .map((sub) => {
      const state = storedState(sub, now);
      const paid = paidBySub.get(sub.providerId!);
      const hasPaid = Boolean(paid?.first);
      const status: CustomerStatus =
        state === "active"
          ? hasPaid
            ? "paying"
            : "trial"
          : state === "cancelling"
            ? hasPaid
              ? "cancelling"
              : "trial_cancelled"
            : state === "past_due"
              ? "past_due"
              : "ended";
      const value = monthlyCents(sub.plan, sub.interval);
      return {
        userId: sub.userId,
        name: sub.name,
        email: sub.email,
        plan: sub.plan,
        interval: sub.interval,
        status,
        mrrCents: status === "paying" || status === "cancelling" ? value : 0,
        valueCents: value,
        paidCents: paid?.paid ?? 0,
        firstPaymentAt: paid?.first ?? null,
        periodEnd: sub.currentPeriodEnd,
      };
    });

  const sum = (list: typeof customers, key: "mrrCents" | "valueCents") =>
    list.reduce((total, row) => total + row[key], 0);
  const by = (status: CustomerStatus) =>
    customers.filter((row) => row.status === status);
  const paying = customers.filter(
    (row) => row.status === "paying" || row.status === "cancelling",
  );
  const mrrCents = sum(paying, "mrrCents");

  // Cash, month by month (last 12 months, oldest first).
  const months: Array<{ month: string; grossCents: number; refundCents: number }> = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ month: monthKey(date), grossCents: 0, refundCents: 0 });
  }
  const monthIndex = new Map(months.map((row, index) => [row.month, index]));
  let grossAll = 0;
  let refundsAll = 0;
  for (const payment of usd) {
    const value = cents(payment.amount);
    const index = monthIndex.get(monthKey(payment.occurredAt));
    if (payment.status === "completed") {
      grossAll += value;
      if (index !== undefined) months[index].grossCents += value;
    } else if (payment.status === "refunded") {
      refundsAll += value;
      if (index !== undefined) months[index].refundCents += value;
    }
  }
  const thisMonth = months[11];
  const lastMonth = months[10];

  // MRR movements over the last 30 days.
  const since = new Date(now.getTime() - 30 * DAY);
  const recent = events.filter((event) => event.occurredAt >= since);
  const newPaying = customers.filter(
    (row) => row.firstPaymentAt && row.firstPaymentAt >= since,
  );
  const churned = customers.filter(
    (row) =>
      row.status === "ended" &&
      row.firstPaymentAt &&
      row.periodEnd &&
      row.periodEnd >= since &&
      row.periodEnd <= now,
  );
  const scheduled = recent.filter((event) => event.kind === "cancel_scheduled");
  const mrrStart30 = Math.max(
    0,
    mrrCents - sum(newPaying, "valueCents") + sum(churned, "valueCents"),
  );

  const prev = totals.usersPrev30d;
  return {
    generatedAt: now.toISOString(),
    mrrCents,
    arrCents: mrrCents * 12,
    payingCustomers: paying.length,
    arpuCents: paying.length ? Math.round(mrrCents / paying.length) : 0,
    trialPipeline: {
      count: by("trial").length,
      valueCents: sum(by("trial"), "valueCents"),
      /** Cancelled before the first charge: never paid. */
      cancelledBeforePaying: by("trial_cancelled").length,
    },
    atRisk: {
      cancelling: by("cancelling").length,
      pastDue: by("past_due").length,
      valueCents: sum(by("cancelling"), "valueCents") + sum(by("past_due"), "valueCents"),
    },
    last30Days: {
      newCustomers: newPaying.length,
      newMrrCents: sum(newPaying, "valueCents"),
      churnedCustomers: churned.length,
      churnedMrrCents: sum(churned, "valueCents"),
      cancellationsScheduled: scheduled.length,
      reactivations: recent.filter((event) => event.kind === "reactivated").length,
      failedPayments: recent.filter((event) => event.kind === "payment_failed").length,
      netMrrChangeCents: sum(newPaying, "valueCents") - sum(churned, "valueCents"),
      revenueChurnRate: mrrStart30 ? sum(churned, "valueCents") / mrrStart30 : null,
    },
    cash: {
      thisMonthCents: thisMonth.grossCents - thisMonth.refundCents,
      lastMonthCents: lastMonth.grossCents - lastMonth.refundCents,
      allTimeGrossCents: grossAll,
      allTimeRefundsCents: refundsAll,
      allTimeNetCents: grossAll - refundsAll,
      otherCurrencyPayments: payments.length - usd.length,
      months,
    },
    users: {
      total: totals.users,
      last30Days: totals.users30d,
      growthRate: prev ? (totals.users30d - prev) / prev : null,
    },
    customers: customers.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        b.valueCents - a.valueCents,
    ),
    events: events.slice(0, 60),
  };
}

const STATUS_ORDER: CustomerStatus[] = [
  "paying",
  "past_due",
  "cancelling",
  "trial",
  "trial_cancelled",
  "ended",
];
