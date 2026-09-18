import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { swaggerUI } from "@hono/swagger-ui";
import authRoutes from "./routes/auth";
import apiRoutes from "./routes/api";
import { HttpError, type AppEnv } from "./lib/http";
import { openApi } from "./openapi";

const app = new Hono<AppEnv>();
app.use("*", logger(), cors());
app.get("/", (c) =>
  c.json({ name: "Trello API", docs: "/docs", health: "ok" }),
);
app.get("/openapi.json", (c) => c.json(openApi));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));
app.route("/auth", authRoutes);
app.route("/", apiRoutes);
app.notFound((c) => c.json({ error: "Route not found" }, 404));
app.onError((error, c) => {
  if (error instanceof HttpError)
    return c.json(
      { error: error.message, details: error.details },
      error.status as any,
    );
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
