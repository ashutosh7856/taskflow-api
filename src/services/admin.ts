import { eq } from "drizzle-orm";

import { db } from "../db";
import { users } from "../db/schema";
import { HttpError } from "../lib/http";

function configuredAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function emailIsConfiguredAdmin(email: string) {
  return configuredAdminEmails().has(email.toLowerCase());
}

export async function assertAdmin(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || (!user.isAdmin && !emailIsConfiguredAdmin(user.email))) {
    throw new HttpError(403, "Administrator access required");
  }
  return user;
}
