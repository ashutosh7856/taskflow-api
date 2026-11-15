import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { swaggerUI } from "@hono/swagger-ui";
import authRoutes from "./routes/auth";
import apiRoutes from "./routes/api";
import { HttpError, type AppEnv } from "./lib/http";
import { openApi } from "./openapi";
import { paypalWebhook } from "./routes/billing";
import { publicPortal } from "./routes/portal";
import { withDatabase } from "./db";

const app = new Hono<AppEnv>();
const allowedOrigins = new Set(
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
app.use(
  "*",
  logger(),
  secureHeaders(),
  cors({
    origin: (origin) =>
      allowedOrigins.has(origin.replace(/\/$/, "")) ? origin : null,
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 86400,
  }),
);
app.use("*", async (c, next) => {
  const env = c.env as
    { HYPERDRIVE?: { connectionString: string } } | undefined;
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    // Not running on Workers (Bun dev server): use the shared pool.
  }
  return withDatabase(next, {
    connectionString: env?.HYPERDRIVE?.connectionString,
    waitUntil,
  });
});
app.get("/", (c) =>
  c.json({ name: "Trello API", docs: "/docs", health: "ok" }),
);
app.get("/openapi.json", (c) => c.json(openApi));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));
app.route("/auth", authRoutes);
app.route("/webhooks", paypalWebhook);
app.route("/portal", publicPortal);
app.route("/", apiRoutes);
app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((error, c) => {
  if (error instanceof HttpError)
    return c.json(
      { error: error.message, details: error.details },
      error.status as any,
    );
  // Drizzle wraps the real Postgres error in `cause`; log that, not the wrapper.
  const databaseError = ((error as Error & { cause?: unknown }).cause ||
    error) as Error & {
    code?: string;
    detail?: string;
    hint?: string;
    schema_name?: string;
    table_name?: string;
    column_name?: string;
    constraint_name?: string;
  };
  console.error("Unhandled API error", {
    name: databaseError.name,
    message: databaseError.message,
    code: databaseError.code,
    detail: databaseError.detail,
    hint: databaseError.hint,
    schema: databaseError.schema_name,
    table: databaseError.table_name,
    column: databaseError.column_name,
    constraint: databaseError.constraint_name,
    query: (error as Error).message.split("\n")[0].slice(0, 300),
    stack: databaseError.stack,
  });
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
