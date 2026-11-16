import { AsyncLocalStorage } from "node:async_hooks";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle as drizzleD1, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * The database is Cloudflare D1 (SQLite). On Workers each request gets the
 * `DB` binding. The Bun dev server and scripts use a local SQLite file
 * through libSQL instead, which speaks the same SQL dialect.
 *
 * D1 has no interactive transactions: group writes that must succeed
 * together with `db.batch([...])`.
 */
export type Database = DrizzleD1Database<typeof schema>;

/** Minimal shape of the Workers D1 binding (avoids a types dependency). */
export type D1Binding = Parameters<typeof drizzleD1>[0];

type RequestScope = { database: Database; tasks: Promise<unknown>[] };
const databaseContext = new AsyncLocalStorage<RequestScope>();

function activeDatabase() {
  const scope = databaseContext.getStore();
  if (!scope) throw new Error("Database used outside a request context");
  return scope.database;
}

// Routes use `db.query`, `db.insert`, `db.batch` etc. while the actual client
// stays scoped to the current request.
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const database = activeDatabase();
    const value = Reflect.get(database, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Runs work after the response is sent (emails, notifications). On Workers
 * it is handed to waitUntil so the request isn't cut off.
 */
export function defer(task: () => Promise<unknown>) {
  const scope = databaseContext.getStore();
  const promise = (async () => {
    try {
      await task();
    } catch (error) {
      console.error("Background task failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  scope?.tasks.push(promise);
  return promise;
}

// Kept on globalThis so `bun --hot` reloads reuse the same local client.
const localHolder = globalThis as typeof globalThis & {
  __dantoLocalDb?: { url: string; database: Database };
};

/** Local SQLite file used outside Workers (dev server, scripts, tests). */
export async function localDatabase(
  url = process.env.SQLITE_URL || "file:.data/danto.db",
) {
  const existing = localHolder.__dantoLocalDb;
  if (existing?.url === url) return existing.database;
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(url.slice(5)), { recursive: true });
  }
  const client = createClient({ url });
  await client.execute("PRAGMA foreign_keys = ON");
  // libSQL and D1 expose the same Drizzle SQLite API (query, batch, ...).
  const database = drizzle(client, { schema }) as unknown as Database;
  localHolder.__dantoLocalDb = { url, database };
  return database;
}

type DatabaseOptions = {
  /** Cloudflare D1 binding, present on Workers. */
  d1?: D1Binding;
  /** Present on Workers: lets deferred work finish after the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

export async function withDatabase<T>(
  callback: () => Promise<T>,
  options: DatabaseOptions = {},
) {
  const database = options.d1
    ? drizzleD1(options.d1, { schema })
    : await localDatabase();
  const scope: RequestScope = { database, tasks: [] };
  try {
    return await databaseContext.run(scope, callback);
  } finally {
    if (options.waitUntil && scope.tasks.length)
      options.waitUntil(Promise.allSettled(scope.tasks));
  }
}

/** Runs a callback with an explicit database (tests and one-off scripts). */
export function runWithDatabase<T>(database: Database, callback: () => T) {
  return databaseContext.run({ database, tasks: [] }, callback);
}

/**
 * Runs a dynamic list of write statements atomically (D1's replacement for
 * a transaction). Use `db.batch([...])` directly when results are needed.
 */
export async function atomic(statements: BatchItem<"sqlite">[]) {
  if (!statements.length) return;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}
