import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { AppEnv } from "../lib/http";

const secret = () => process.env.JWT_SECRET || "development-only-change-me";

export const auth = createMiddleware<AppEnv>(async (c, next) => {
  const value = c.req.header("Authorization");
  if (!value?.startsWith("Bearer "))
    return c.json({ error: "Unauthorized" }, 401);
  try {
    const payload = await verify(value.slice(7), secret(), "HS256");
    if (typeof payload.sub !== "string") throw new Error();
    c.set("userId", payload.sub);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
});

export { secret as jwtSecret };
