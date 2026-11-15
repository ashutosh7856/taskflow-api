import { and, eq, gte, isNull } from "drizzle-orm";

import { db, defer } from "../db";
import { adminLoginCodes, users } from "../db/schema";
import { cached, invalidate } from "../lib/cache";
import { HttpError } from "../lib/http";
import { jwtSecret } from "../middleware/auth";
import { sendEmail } from "./email";
import { hashPassword } from "./password";

/**
 * The one address that may run the admin panel. Set ADMIN_EMAIL (or, for
 * older configs, the first entry of ADMIN_EMAILS). Admin access also needs a
 * session that was opened with a one-time code sent to this address, so a
 * password alone never grants it.
 */
export function adminEmail() {
  const value =
    process.env.ADMIN_EMAIL || (process.env.ADMIN_EMAILS || "").split(",")[0];
  return value.trim().toLowerCase() || null;
}

export function emailIsConfiguredAdmin(email: string) {
  return adminEmail() === email.toLowerCase();
}

export async function assertAdmin(userId: string, adminSession: boolean) {
  if (!adminSession)
    throw new HttpError(
      403,
      "Sign in to the admin panel with a one-time code",
      {
        code: "admin_otp_required",
      },
    );
  const user = await cached(`admin:${userId}`, 60, () =>
    db.query.users.findFirst({ where: eq(users.id, userId) }),
  );
  if (!user || user.suspendedAt || !emailIsConfiguredAdmin(user.email)) {
    throw new HttpError(403, "Administrator access required");
  }
  return user;
}

export function invalidateAdmin(userId: string) {
  invalidate(`admin:${userId}`);
}

/* ---------------------------- One-time codes ---------------------------- */

export const ADMIN_CODE_TTL_MS = 10 * 60 * 1000;
/** Admin rights last this long after a code sign-in, then must be renewed. */
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export async function hashAdminCode(id: string, code: string) {
  const data = new TextEncoder().encode(`admin:${id}:${code}:${jwtSecret()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function newCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return value.toString().padStart(6, "0");
}

/**
 * Emails a sign-in code to the admin address. Anyone can press "Send code",
 * so sending is capped: 3 codes per 15 minutes and 10 per day.
 */
export async function issueAdminCode(requestIp: string | null) {
  const to = adminEmail();
  if (!to) throw new HttpError(503, "Admin sign-in is not configured");
  const now = Date.now();
  const recent = await db
    .select({ createdAt: adminLoginCodes.createdAt })
    .from(adminLoginCodes)
    .where(gte(adminLoginCodes.createdAt, new Date(now - 24 * 60 * 60 * 1000)));
  const last15 = recent.filter(
    (row) => row.createdAt.getTime() > now - 15 * 60 * 1000,
  ).length;
  if (last15 >= 3 || recent.length >= 10)
    throw new HttpError(
      429,
      "Too many codes requested. Use the latest code you received, or try again later.",
    );

  const code = newCode();
  const id = crypto.randomUUID();
  await db.insert(adminLoginCodes).values({
    id,
    codeHash: await hashAdminCode(id, code),
    expiresAt: new Date(now + ADMIN_CODE_TTL_MS),
    requestIp,
  });
  defer(() =>
    sendEmail({
      to,
      subject: `${code} is your Danto admin code`,
      preheader: `Admin sign-in code ${code}. It expires in 10 minutes.`,
      eyebrow: "Admin sign-in",
      title: "Your admin sign-in code",
      message:
        "Someone asked to sign in to the Danto admin panel. If that was you, enter this code. It works once and expires in 10 minutes.",
      code,
      details: [
        ["Requested from", requestIp || "Unknown"],
        [
          "Time",
          `${new Date(now).toLocaleString("en-US", { timeZone: "UTC" })} UTC`,
        ],
      ],
      footnote:
        "If you didn't request this, ignore it: nobody can sign in without the code.",
    }),
  );
  return id;
}

/** Checks a code. Returns the admin user on success; throws otherwise. */
export async function verifyAdminCode(challengeId: string, code: string) {
  const row = await db.query.adminLoginCodes.findFirst({
    where: eq(adminLoginCodes.id, challengeId),
  });
  const invalid = new HttpError(400, "That code is wrong or has expired");
  if (
    !row ||
    row.usedAt ||
    row.expiresAt.getTime() < Date.now() ||
    row.attempts >= MAX_ATTEMPTS
  )
    throw invalid;

  if ((await hashAdminCode(row.id, code)) !== row.codeHash) {
    await db
      .update(adminLoginCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(adminLoginCodes.id, row.id));
    throw invalid;
  }
  // Single use, even if two requests race with the same code.
  const claimed = await db
    .update(adminLoginCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(adminLoginCodes.id, row.id), isNull(adminLoginCodes.usedAt)))
    .returning({ id: adminLoginCodes.id });
  if (!claimed.length) throw invalid;

  const email = adminEmail()!;
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    if (existing.suspendedAt)
      throw new HttpError(403, "This account is suspended");
    return existing;
  }
  // First admin sign-in before any account exists: create one with a random
  // password (use "Forgot password" later if you also want password sign-in).
  const [created] = await db
    .insert(users)
    .values({
      name: "Admin",
      email,
      passwordHash: await hashPassword(
        crypto.randomUUID() + crypto.randomUUID(),
      ),
    })
    .returning();
  return created;
}
