import { HttpError } from "../lib/http";

/**
 * Dodo Payments (merchant of record) client.
 *
 * Config:
 *  - DODO_API_KEY (secret): test keys start with `dodo_test_`.
 *  - DODO_WEBHOOK_SECRET (secret): `whsec_…` from the Dodo webhook settings.
 *  - DODO_ENV (var): "live" or "test" (default test).
 *  - DODO_PRODUCTS (var): JSON of product ids per plan and interval, e.g.
 *    {"pro_month":"pdt_…","pro_year":"pdt_…","business_month":"pdt_…","business_year":"pdt_…"}
 *    Test and live products have different ids, so this changes at go-live.
 */

export type PaidPlan = "pro" | "business";
export type Interval = "month" | "year";

const dodoBase = () =>
  process.env.DODO_ENV === "live"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";

function productMap(): Partial<Record<`${PaidPlan}_${Interval}`, string>> {
  try {
    return JSON.parse(process.env.DODO_PRODUCTS || "{}");
  } catch {
    return {};
  }
}

export function dodoConfigured() {
  const products = productMap();
  return Boolean(
    process.env.DODO_API_KEY &&
      products.pro_month &&
      products.pro_year &&
      products.business_month &&
      products.business_year,
  );
}

export function dodoProductId(plan: PaidPlan, interval: Interval) {
  const id = productMap()[`${plan}_${interval}`];
  if (!id) throw new HttpError(503, "Checkout is not configured");
  return id;
}

/** Reverse lookup: which plan/interval a Dodo product id stands for. */
export function planForProduct(
  productId: string,
): { plan: PaidPlan; interval: Interval } | null {
  for (const [key, id] of Object.entries(productMap())) {
    if (id !== productId) continue;
    const [plan, interval] = key.split("_") as [PaidPlan, Interval];
    return { plan, interval };
  }
  return null;
}

export async function dodoRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = process.env.DODO_API_KEY;
  if (!key) throw new HttpError(503, "Checkout is not configured");
  const response = await fetch(`${dodoBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    console.error("Dodo request failed", path, response.status, text.slice(0, 300));
    throw new HttpError(
      response.status === 404 ? 404 : 502,
      data?.message || "Payment provider request failed",
    );
  }
  return data as T;
}

export type DodoSubscription = {
  subscription_id: string;
  status:
    | "pending"
    | "active"
    | "on_hold"
    | "paused"
    | "cancelled"
    | "failed"
    | "expired"
    | "past_due";
  product_id: string;
  next_billing_date: string;
  cancel_at_next_billing_date: boolean;
  trial_period_days: number;
  customer: { customer_id: string; email: string };
  metadata: Record<string, string>;
};

/** Whole days left until `end` (rounded up), 0 if it has passed. */
export function trialDaysLeft(end: Date | null | undefined, now = new Date()) {
  if (!end) return 0;
  const ms = end.getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

// ---- Webhook verification (Standard Webhooks spec) -----------------------

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks `webhook-signature` = "v1,<base64 HMAC-SHA256(id.timestamp.body)>"
 * (space-separated list allowed) and rejects events older than 5 minutes.
 */
export async function verifyDodoWebhook(
  rawBody: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret = process.env.DODO_WEBHOOK_SECRET,
  now = Date.now(),
) {
  if (!secret) throw new HttpError(503, "Dodo webhook is not configured");
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > 300)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = bytesToBase64(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
    ),
  );
  return signature
    .split(" ")
    .some((part) => {
      const [version, value] = part.split(",");
      return version === "v1" && Boolean(value) && safeEqual(value, expected);
    });
}
