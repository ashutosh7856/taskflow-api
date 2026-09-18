import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { z } from "zod";

import { db } from "../db";
import { users } from "../db/schema";
import { body, publicUser, type AppEnv } from "../lib/http";
import { auth, jwtSecret } from "../middleware/auth";
import { frontendUrl, sendEmail } from "../services/email";

const authRouter = new Hono<AppEnv>();

const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8),
});

async function createTokens(userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await sign(
    { sub: userId, type: "access", exp: now + 15 * 60 },
    jwtSecret(),
  );
  const refreshToken = await sign(
    { sub: userId, type: "refresh", exp: now + 30 * 24 * 60 * 60 },
    jwtSecret(),
  );
  return { accessToken, refreshToken };
}

authRouter.post("/register", async (c) => {
  const input = await body(
    c,
    credentialsSchema.extend({ name: z.string().min(1).max(100) }),
  );

  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });
  if (existingUser) return c.json({ error: "Email already registered" }, 409);

  const [user] = await db
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      passwordHash: await Bun.password.hash(input.password),
    })
    .returning();

  return c.json(
    { user: publicUser(user), ...(await createTokens(user.id)) },
    201,
  );
});

authRouter.post("/login", async (c) => {
  const input = await body(c, credentialsSchema);
  const user = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });
  const passwordMatches = user
    ? await Bun.password.verify(input.password, user.passwordHash)
    : false;

  if (!user || !passwordMatches) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  await sendEmail({
    to: user.email,
    subject: "New sign-in to your TaskFlow account",
    title: "New sign-in detected",
    message: `Your TaskFlow account was signed in at ${new Date().toLocaleString("en-US", { timeZone: "UTC" })} UTC. If this was not you, change your password immediately.`,
    actionLabel: "Open TaskFlow",
    actionUrl: frontendUrl("/"),
  });

  return c.json({ user: publicUser(user), ...(await createTokens(user.id)) });
});

authRouter.post("/refresh", async (c) => {
  const { refreshToken } = await body(
    c,
    z.object({ refreshToken: z.string() }),
  );

  try {
    const payload = await verify(refreshToken, jwtSecret(), "HS256");
    if (payload.type !== "refresh" || typeof payload.sub !== "string") {
      throw new Error("Invalid token type");
    }
    return c.json(await createTokens(payload.sub));
  } catch {
    return c.json({ error: "Invalid or expired refresh token" }, 401);
  }
});

authRouter.get("/me", auth, async (c) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });
  return user
    ? c.json(publicUser(user))
    : c.json({ error: "User not found" }, 404);
});

export default authRouter;
