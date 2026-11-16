/**
 * Web app addresses the API accepts (CORS) and may send people back to.
 * Both the Pages address and the custom domain stay valid, so adding the
 * domain later needs no code change.
 */
let cached: Set<string> | undefined;

export function allowedOrigins() {
  cached ??= new Set(
    [
      "https://taskflow-ui-b5u.pages.dev",
      "https://danto.app",
      "https://www.danto.app",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      process.env.FRONTEND_URL,
      ...(process.env.CORS_ORIGINS || "").split(","),
    ]
      .filter((origin): origin is string => Boolean(origin?.trim()))
      .map((origin) => origin.trim().replace(/\/$/, "")),
  );
  return cached;
}

export function isAllowedOrigin(origin: string | undefined | null) {
  return Boolean(origin && allowedOrigins().has(origin.replace(/\/$/, "")));
}
