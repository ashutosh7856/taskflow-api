import { and, eq, gte } from "drizzle-orm";

import { db, defer } from "../db";
import { passwordResets } from "../db/schema";
import { jwtSecret } from "../middleware/auth";
import { frontendUrl, sendEmail } from "./email";

export const RESET_TTL_MS = 15 * 60 * 1000;

export async function hashResetCode(userId: string, code: string) {
  const data = new TextEncoder().encode(`${userId}:${code}:${jwtSecret()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function newResetCode() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return value.toString().padStart(6, "0");
}

/** Emails a 6-digit reset code. Returns false when rate-limited (3 per 15 min). */
export async function issuePasswordReset(user: {
  id: string;
  name: string;
  email: string;
}) {
  const recent = await db
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.userId, user.id),
        gte(passwordResets.createdAt, new Date(Date.now() - RESET_TTL_MS)),
      ),
    );
  if (recent.length >= 3) return false;

  const code = newResetCode();
  await db.insert(passwordResets).values({
    userId: user.id,
    codeHash: await hashResetCode(user.id, code),
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  });
  defer(() =>
    sendEmail({
      to: user.email,
      subject: `${code} is your Danto reset code`,
      preheader: `Your password reset code is ${code}. It expires in 15 minutes.`,
      title: "Reset your password",
      eyebrow: "Security code",
      message: `Hi ${user.name.split(" ")[0]}, enter this code to choose a new password.`,
      code,
      actionLabel: "Enter code",
      actionUrl: frontendUrl(
        `/forgot-password?email=${encodeURIComponent(user.email)}`,
      ),
      footnote:
        "Didn't ask for this? You can safely ignore this email. Your password won't change unless someone enters this code.",
    }),
  );
  return true;
}
