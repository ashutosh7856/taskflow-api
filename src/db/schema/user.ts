import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { bool, enumText, id, json, timestamp, uuidRef } from "./columns";

export const users = sqliteTable(
  "users",
  {
    id: id("id"),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    avatarUrl: text("avatar_url"),
    isAdmin: bool("is_admin").default(false).notNull(),
    /** Refresh tokens issued before this moment are rejected. */
    passwordChangedAt: timestamp("password_changed_at"),
    lastSeenAt: timestamp("last_seen_at"),
    suspendedAt: timestamp("suspended_at"),
    signupSource: text("signup_source"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("users_created_idx").on(table.createdAt)],
);

export const passwordResets = sqliteTable(
  "password_resets",
  {
    id: id("id"),
    userId: uuidRef("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("password_resets_user_idx").on(table.userId, table.createdAt),
  ],
);

export const adminAuditLogs = sqliteTable(
  "admin_audit_logs",
  {
    id: id("id"),
    adminId: uuidRef("admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetUserId: uuidRef("target_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    meta: json("meta"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("admin_audit_created_idx").on(table.createdAt)],
);

/**
 * One-time sign-in codes for the admin panel. Codes are only ever emailed to
 * the configured admin address; the row stores a hash, never the code.
 */
export const adminLoginCodes = sqliteTable(
  "admin_login_codes",
  {
    id: id("id"),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestIp: text("request_ip"),
    createdAt: timestamp("created_at")
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [index("admin_login_codes_created_idx").on(table.createdAt)],
);
