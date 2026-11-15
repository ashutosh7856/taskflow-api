import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { z } from "zod";

import { db, defer } from "../db";
import { passwordResets, subscriptions, users } from "../db/schema";
import { body, HttpError, publicUser, type AppEnv } from "../lib/http";
import { auth, jwtSecret } from "../middleware/auth";
import { hashResetCode, issuePasswordReset } from "../services/password-reset";
import { frontendUrl, sendEmail } from "../services/email";
import {
  ADMIN_SESSION_MS,
  emailIsConfiguredAdmin,
  issueAdminCode,
  verifyAdminCode,
} from "../services/admin";
import {
  hashPassword,
  passwordHashFormat,
  passwordNeedsRehash,
  verifyPassword,
} from "../services/password";

const authRouter = new Hono<AppEnv>();
const TRIAL_DAYS = 14;

const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8),
});

/**
 * `admUntil` (unix seconds) marks a session opened with an emailed admin
 * code. It is carried through refreshes but never extended, so admin rights
 * expire 12 hours after the code sign-in while the normal session continues.
 */
async function createTokens(userId: string, admUntil?: number) {
  const now = Math.floor(Date.now() / 1000);
  const admin = admUntil && admUntil > now ? { admUntil } : {};
  const accessToken = await sign(
    { sub: userId, type: "access", iat: now, exp: now + 15 * 60, ...admin },
    jwtSecret(),
  );
  const refreshToken = await sign(
    {
      sub: userId,
      type: "refresh",
      iat: now,
      exp: now + 30 * 24 * 60 * 60,
      ...admin,
    },
    jwtSecret(),
  );
  return { accessToken, refreshToken };
}

function sessionUser<T extends { email: string; passwordHash?: string }>(
  user: T,
) {
  return {
    ...publicUser(user),
    isAdmin: emailIsConfiguredAdmin(user.email),
  };
}

authRouter.post("/register", async (c) => {
  const input = await body(
    c,
    credentialsSchema.extend({
      name: z.string().min(1).max(100),
      source: z.string().max(80).optional(),
    }),
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
      passwordHash: await hashPassword(input.password),
      signupSource: input.source || null,
      lastSeenAt: new Date(),
    })
    .returning();
  // Reverse trial: every new account gets Pro for 14 days, then drops to Free
  // automatically (stored as cancelled-with-end-date, so no billing involved).
  await db.insert(subscriptions).values({
    userId: user.id,
    plan: "pro",
    billingStatus: "cancelled",
    currentPeriodEnd: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
  });
  defer(() =>
    sendEmail({
      to: user.email,
      subject: "Welcome to Danto. Your first client portal is 2 minutes away",
      title: `Welcome, ${user.name.split(" ")[0]}!`,
      eyebrow: "Getting started",
      message:
        "You have Danto Pro free for the next 14 days: unlimited client portals, your branding and AI client updates. No card needed, and you drop to the Free plan automatically afterwards.\n\nThe fastest way to see it: create a Client project board, add two or three deliverables, then press “Share with client” and open the link yourself.",
      details: [
        ["Step 1", "Create a Client project board"],
        ["Step 2", "Add deliverables (or paste a brief and let AI plan it)"],
        ["Step 3", "Share with client, then request your first approval"],
      ],
      actionLabel: "Create my first portal",
      actionUrl: frontendUrl("/app"),
      footnote:
        "Questions? Just reply to this email. A real person reads every one.",
    }),
  );

  return c.json(
    { user: sessionUser(user), ...(await createTokens(user.id)) },
    201,
  );
});

authRouter.post("/login", async (c) => {
  const input = await body(c, credentialsSchema);
  const user = await db.query.users.findFirst({
    where: eq(users.email, input.email),
  });
  const passwordMatches = user
    ? await verifyPassword(input.password, user.passwordHash)
    : false;

  if (!user || !passwordMatches) {
    console.warn("Login rejected", {
      userFound: Boolean(user),
      passwordFormat: user ? passwordHashFormat(user.passwordHash) : null,
    });
    return c.json({ error: "Invalid credentials" }, 401);
  }

  if (user.suspendedAt) {
    return c.json(
      { error: "This account is suspended. Contact support@danto.app." },
      403,
    );
  }

  await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, user.id));

  if (passwordNeedsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(input.password) })
      .where(eq(users.id, user.id));
  }

  defer(() =>
    sendEmail({
      to: user.email,
      subject: "New sign-in to your Danto account",
      title: "New sign-in detected",
      message: `Your Danto account was signed in at ${new Date().toLocaleString("en-US", { timeZone: "UTC" })} UTC. If this was not you, change your password immediately.`,
      actionLabel: "Open Danto",
      actionUrl: frontendUrl("/"),
    }),
  );

  return c.json({ user: sessionUser(user), ...(await createTokens(user.id)) });
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
    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.sub),
    });
    const issuedAt = typeof payload.iat === "number" ? payload.iat * 1000 : 0;
    if (
      !user ||
      user.suspendedAt ||
      // A password reset signs out every existing session.
      (user.passwordChangedAt && issuedAt < user.passwordChangedAt.getTime())
    ) {
      throw new Error("Session revoked");
    }
    await db
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, user.id));
    return c.json(
      await createTokens(
        payload.sub,
        typeof payload.admUntil === "number" ? payload.admUntil : undefined,
      ),
    );
  } catch {
    return c.json({ error: "Invalid or expired refresh token" }, 401);
  }
});

authRouter.get("/me", auth, async (c) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });
  return user
    ? c.json(sessionUser(user))
    : c.json({ error: "User not found" }, 404);
});

/* ------------------------------------------------------------------ */
/* Password reset with a 6-digit emailed code                          */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 5;

const emailSchema = z
  .string()
  .email()
  .transform((value) => value.trim().toLowerCase());

authRouter.post("/password/forgot", async (c) => {
  const { email } = await body(c, z.object({ email: emailSchema }));
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  // Same response whether or not the account exists (no email enumeration).
  if (user && !user.suspendedAt) await issuePasswordReset(user);
  return c.json({
    ok: true,
    message:
      "If an account exists for that email, a 6-digit code is on its way.",
  });
});

async function consumeResetCode(email: string, code: string, consume: boolean) {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  const invalid = new HttpError(400, "That code is invalid or has expired.");
  if (!user) throw invalid;
  const reset = await db.query.passwordResets.findFirst({
    where: and(
      eq(passwordResets.userId, user.id),
      isNull(passwordResets.usedAt),
      gte(passwordResets.expiresAt, new Date()),
    ),
    orderBy: desc(passwordResets.createdAt),
  });
  if (!reset || reset.attempts >= MAX_ATTEMPTS) throw invalid;
  if (reset.codeHash !== (await hashResetCode(user.id, code))) {
    await db
      .update(passwordResets)
      .set({ attempts: reset.attempts + 1 })
      .where(eq(passwordResets.id, reset.id));
    throw invalid;
  }
  if (consume)
    await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(eq(passwordResets.userId, user.id));
  return user;
}

const codeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

authRouter.post("/password/verify", async (c) => {
  const { email, code } = await body(
    c,
    z.object({ email: emailSchema, code: codeSchema }),
  );
  await consumeResetCode(email, code, false);
  return c.json({ ok: true });
});

authRouter.post("/password/reset", async (c) => {
  const input = await body(
    c,
    z.object({
      email: emailSchema,
      code: codeSchema,
      password: z.string().min(8).max(200),
    }),
  );
  const user = await consumeResetCode(input.email, input.code, true);
  // Whole seconds, matching JWT `iat`, so tokens minted now stay valid.
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(input.password),
      passwordChangedAt: changedAt,
      lastSeenAt: changedAt,
    })
    .where(eq(users.id, user.id));
  defer(() =>
    sendEmail({
      to: user.email,
      subject: "Your Danto password was changed",
      title: "Password changed",
      eyebrow: "Security",
      message:
        "Your password was just changed and all other sessions were signed out. If you did this, you're all set.",
      details: [["When", changedAt.toUTCString()]],
      footnote:
        "Didn't change it? Reset your password right away and contact support@danto.app.",
      actionLabel: "Secure my account",
      actionUrl: frontendUrl("/forgot-password"),
    }),
  );
  return c.json({ user: sessionUser(user), ...(await createTokens(user.id)) });
});

authRouter.post("/password/change", auth, async (c) => {
  const input = await body(
    c,
    z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(200),
    }),
  );
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });
  if (
    !user ||
    !(await verifyPassword(input.currentPassword, user.passwordHash))
  )
    throw new HttpError(400, "Your current password is incorrect.");
  // Whole seconds, matching JWT `iat`, so tokens minted now stay valid.
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(input.newPassword),
      passwordChangedAt: changedAt,
    })
    .where(eq(users.id, user.id));
  return c.json(await createTokens(user.id));
});

/* ------------------------- Admin code sign-in ------------------------- */
// No email field on purpose: the code always goes to the configured admin
// address, so knowing (or guessing) it doesn't help anyone else.

authRouter.post("/admin/code", async (c) => {
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
  const challengeId = await issueAdminCode(ip);
  return c.json({ challengeId, expiresInSeconds: 600 });
});

authRouter.post("/admin/verify", async (c) => {
  const input = await body(
    c,
    z.object({
      challengeId: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/),
    }),
  );
  const user = await verifyAdminCode(input.challengeId, input.code);
  await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, user.id));
  const admUntil = Math.floor((Date.now() + ADMIN_SESSION_MS) / 1000);
  return c.json({
    user: sessionUser(user),
    ...(await createTokens(user.id, admUntil)),
    adminUntil: new Date(admUntil * 1000).toISOString(),
  });
});

export default authRouter;
