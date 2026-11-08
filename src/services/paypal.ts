import { HttpError } from "../lib/http";

const paypalBase = () =>
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export function paypalConfigured() {
  return Boolean(
    process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET,
  );
}

export async function paypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret)
    throw new HttpError(503, "PayPal billing is not configured");
  const response = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token)
    throw new HttpError(502, "Could not connect to PayPal");
  return data.access_token as string;
}

export async function paypalRequest<T>(
  path: string,
  options: RequestInit = {},
) {
  const token = await paypalAccessToken();
  const response = await fetch(`${paypalBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    console.error("PayPal request failed", response.status, data?.name);
    throw new HttpError(502, data?.message || "PayPal request failed");
  }
  return data as T;
}
