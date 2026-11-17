import { and, eq, isNull } from "drizzle-orm";

import { db, defer } from "../db";
import { paymentEvents, subscriptions, users } from "../db/schema";
import { frontendUrl, sendEmail } from "./email";

export const SELLER = {
  name: "Danto",
  website: "danto.app",
  email: "support@danto.app",
};

const planNames: Record<string, string> = {
  pro: "Pro",
  business: "Team",
  free: "Free",
};

type PaymentRow = typeof paymentEvents.$inferSelect;

/** Human-friendly, stable receipt number derived from the payment id. */
export function receiptNumber(payment: Pick<PaymentRow, "id" | "occurredAt">) {
  const month = payment.occurredAt.toISOString().slice(0, 7).replace("-", "");
  return `DNT-${month}-${payment.id.slice(0, 8).toUpperCase()}`;
}

export function money(amount: string | number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(amount));
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Everything a receipt page or email needs, or null if not this user's. */
export async function receiptDetails(paymentId: string, userId?: string) {
  const payment = await db.query.paymentEvents.findFirst({
    where: userId
      ? and(eq(paymentEvents.id, paymentId), eq(paymentEvents.userId, userId))
      : eq(paymentEvents.id, paymentId),
  });
  if (!payment?.userId) return null;
  const [customer, subscription] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, payment.userId) }),
    db.query.subscriptions.findFirst({
      where: eq(subscriptions.userId, payment.userId),
    }),
  ]);
  if (!customer) return null;
  const interval =
    subscription?.billingInterval === "year" ? "Yearly" : "Monthly";
  return {
    id: payment.id,
    number: receiptNumber(payment),
    status: payment.status,
    issuedAt: payment.occurredAt.toISOString(),
    amount: Number(payment.amount),
    currency: payment.currency,
    plan: planNames[payment.plan || ""] || "Subscription",
    interval,
    paymentMethod: payment.provider === "dodo" ? "Dodo Payments" : "PayPal",
    reference: payment.providerEventId,
    subscriptionId: payment.providerSubscriptionId,
    customer: { name: customer.name, email: customer.email },
    seller: SELLER,
  };
}

/** Emails a receipt (or refund confirmation) for one payment. */
export async function sendReceipt(paymentId: string) {
  const receipt = await receiptDetails(paymentId);
  if (!receipt) return { sent: false };
  const refunded = receipt.status === "refunded";
  const amount = money(receipt.amount, receipt.currency);
  return sendEmail({
    to: receipt.customer.email,
    subject: refunded
      ? `Refund processed: ${amount} (${receipt.number})`
      : `Your Danto receipt ${receipt.number}`,
    preheader: refunded
      ? `We refunded ${amount} to your original payment method.`
      : `Payment of ${amount} received for Danto ${receipt.plan}. Thank you!`,
    eyebrow: refunded ? "Refund" : "Receipt",
    title: refunded ? "Your refund is on its way" : "Thanks for your payment",
    message: refunded
      ? `We refunded ${amount} for your Danto ${receipt.plan} plan. It usually shows up within a few business days.`
      : `We received your payment for Danto ${receipt.plan}. Keep this email for your records. You can also download a printable receipt anytime from your billing page.`,
    details: [
      ["Receipt number", receipt.number],
      ["Date", formatDate(new Date(receipt.issuedAt))],
      ["Plan", `${receipt.plan}, billed ${receipt.interval.toLowerCase()}`],
      [refunded ? "Refunded" : "Amount paid", amount],
      ["Paid with", receipt.paymentMethod],
      ["Billed to", `${receipt.customer.name} (${receipt.customer.email})`],
    ],
    actionLabel: "View receipt",
    actionUrl: frontendUrl(`/billing/receipts/${receipt.id}`),
    footnote: `Questions about this charge? Reply to ${SELLER.email}.`,
  });
}

/**
 * PayPal's first payment webhook can arrive before the app links the
 * subscription to the account. Once it's linked, attach those payments and
 * send the receipts that couldn't be sent earlier.
 */
export async function claimUnlinkedPayments(
  subscriptionId: string,
  userId: string,
  plan: PaymentRow["plan"],
) {
  const claimed = await db
    .update(paymentEvents)
    .set({ userId, plan })
    .where(
      and(
        eq(paymentEvents.providerSubscriptionId, subscriptionId),
        isNull(paymentEvents.userId),
      ),
    )
    .returning({ id: paymentEvents.id });
  for (const row of claimed) defer(() => sendReceipt(row.id));
}
