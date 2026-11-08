import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { sign } from "hono/jwt";

import type { AppEnv } from "../lib/http";
import { auth } from "./auth";

const secret = "test-secret-that-is-long-enough";
process.env.JWT_SECRET = secret;

async function requestWith(type: "access" | "refresh") {
  const app = new Hono<AppEnv>();
  app.use("*", auth);
  app.get("/private", (c) => c.json({ userId: c.get("userId") }));
  const token = await sign(
    { sub: "user-1", type, exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  return app.request("/private", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("API authentication", () => {
  test("accepts an access token", async () => {
    const response = await requestWith("access");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "user-1" });
  });

  test("rejects a refresh token on protected API routes", async () => {
    const response = await requestWith("refresh");
    expect(response.status).toBe(401);
  });

  test("rejects a request without a bearer token", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", auth);
    app.get("/private", (c) => c.text("ok"));
    expect((await app.request("/private")).status).toBe(401);
  });
});
