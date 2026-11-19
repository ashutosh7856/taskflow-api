import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { swaggerUI } from "@hono/swagger-ui";
import authRoutes from "./routes/auth";
import apiRoutes from "./routes/api";
import { HttpError, type AppEnv } from "./lib/http";
import { openApi } from "./openapi";
import { dodoWebhook } from "./routes/dodo";
import { publicPortal } from "./routes/portal";
import { publicFiles } from "./routes/files";
import { slackCallback } from "./routes/slack";
import { isAllowedOrigin } from "./lib/origins";
import { type FileBucket, useBucket } from "./services/storage";
import { runWeeklyUpdates } from "./services/client-updates";
import { runLifecycleEmails } from "./services/lifecycle";
import { withDatabase, type D1Binding } from "./db";
import { templates } from "./lib/templates";

const app = new Hono<AppEnv>();
const secure = secureHeaders();
app.use(
  "*",
  logger(),
  // Signed file links set their own headers: they must be embeddable as
  // <img>/<video> from the web app's origin.
  (c, next) => (c.req.path.startsWith("/files/") ? next() : secure(c, next)),
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 86400,
  }),
);
app.use("*", async (c, next) => {
  const env = c.env as { DB?: D1Binding; FILES?: FileBucket } | undefined;
  useBucket(env?.FILES, Boolean(env?.DB));
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    // Not running on Workers (Bun dev server): use the shared pool.
  }
  return withDatabase(next, {
    d1: env?.DB,
    waitUntil,
  });
});
app.get("/", (c) =>
  c.json({ name: "Trello API", docs: "/docs", health: "ok" }),
);
// Board template catalog (stages, fields, wording). Public and cacheable.
app.get("/templates", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(templates);
});
app.get("/openapi.json", (c) => c.json(openApi));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));
app.route("/auth", authRoutes);
app.route("/webhooks", dodoWebhook);
app.route("/portal", publicPortal);
app.route("/files", publicFiles);
app.route("/slack", slackCallback);
app.route("/", apiRoutes);
app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((error, c) => {
  if (error instanceof HttpError)
    return c.json(
      { error: error.message, details: error.details },
      error.status as any,
    );
  // Drizzle wraps the real database error in `cause`; log that, not the wrapper.
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

const DAILY_CRON = "0 14 * * *";

type WorkerEnv = {
  DB?: D1Binding;
  FILES?: FileBucket;
};

export default {
  fetch: app.fetch,
  /**
   * Cloudflare Cron Triggers (see wrangler.jsonc): Friday client updates, and
   * the daily onboarding emails.
   */
  async scheduled(
    event: { cron?: string },
    env: WorkerEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    useBucket(env.FILES, true);
    const job = async () => {
      if (event.cron === DAILY_CRON) await runLifecycleEmails();
      else await runWeeklyUpdates();
    };
    ctx.waitUntil(
      withDatabase(job, {
        d1: env.DB,
        waitUntil: ctx.waitUntil.bind(ctx),
      }),
    );
  },
};
