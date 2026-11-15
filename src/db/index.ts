import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { normalizeDatabaseUrl } from "./database-url";

type ClientOptions = { connectionString?: string; pooled?: boolean };

let queueWarned = false;

function createClient(options: ClientOptions = {}) {
  return postgres(
    normalizeDatabaseUrl(options.connectionString || process.env.DATABASE_URL),
    {
      // Prisma's pooler sends this NOTICE when every backend connection is
      // busy. Report it once instead of printing an object per query.
      onnotice: (notice) => {
        if (/client being queued/i.test(notice.message ?? "")) {
          if (queueWarned) return;
          queueWarned = true;
          console.warn(
            "Database pooler is out of connections; queries are waiting. Use DATABASE_URL_UNPOOLED for long-running servers.",
          );
          return;
        }
        console.log("Postgres notice:", notice.message);
      },
      // A Worker request can open at most six simultaneous external
      // connections, so per-request clients stay small. A long-lived server
      // process shares one pool across requests instead.
      max: Number(process.env.DATABASE_POOL_MAX) || (options.pooled ? 10 : 3),
      connect_timeout: 10,
      // A long-running server keeps connections warm: reconnecting costs a
      // TCP + TLS + auth handshake (seconds on a distant database).
      idle_timeout: options.pooled ? 300 : 20,
      max_lifetime: 10 * 60,
      // Skips the pg_type lookup postgres.js runs on every new connection:
      // one fewer network round trip before the first query.
      fetch_types: false,
    },
  );
}

function createDatabase(client: ReturnType<typeof createClient>) {
  return drizzle(client, { schema });
}

type Database = ReturnType<typeof createDatabase>;
type RequestScope = { database: Database; tasks: Promise<unknown>[] };
const databaseContext = new AsyncLocalStorage<RequestScope>();

function activeDatabase() {
  const scope = databaseContext.getStore();
  if (!scope) throw new Error("Database used outside a request context");
  return scope.database;
}

// Routes can retain the existing `db.query`, `db.insert`, and `db.transaction`
// API while the actual client remains scoped to the current request.
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const database = activeDatabase();
    const value = Reflect.get(database, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

/**
 * Runs work after the response is sent (emails, notifications). It keeps the
 * request's database client open until the work finishes.
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

type SharedPool = {
  key: string;
  client: ReturnType<typeof createClient>;
  database: Database;
};
// Kept on globalThis so `bun --hot` reloads reuse the pool instead of opening
// a fresh one on every save and leaking the old connections.
const poolHolder = globalThis as typeof globalThis & {
  __dantoDbPool?: SharedPool;
};

function sharedPool() {
  // A server process already pools its own connections, so it talks to
  // Postgres directly. Going through Prisma's pooler as well adds a second
  // queue with fewer connections ("client being queued").
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const key = `${connectionString}|${process.env.DATABASE_POOL_MAX ?? ""}`;
  const existing = poolHolder.__dantoDbPool;
  if (existing?.key === key) return existing;
  if (existing) void existing.client.end({ timeout: 5 }).catch(() => {});
  const client = createClient({ connectionString, pooled: true });
  const pool = { key, client, database: createDatabase(client) };
  poolHolder.__dantoDbPool = pool;
  return pool;
}

type DatabaseOptions = {
  /** Cloudflare Hyperdrive connection string, when the binding exists. */
  connectionString?: string;
  /** Present on Workers: lets cleanup run after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
};

export async function withDatabase<T>(
  callback: () => Promise<T>,
  options: DatabaseOptions = {},
) {
  // Long-running runtimes (Bun dev server, Node/Bun hosts) reuse one pool, so
  // requests skip the TCP + TLS + auth handshake entirely.
  if (!options.waitUntil) {
    const scope: RequestScope = { database: sharedPool().database, tasks: [] };
    return databaseContext.run(scope, callback);
  }

  // Workers cannot reuse sockets across requests. With Hyperdrive the socket
  // is a cheap local hop to an already-warm pool.
  const client = createClient({ connectionString: options.connectionString });
  const scope: RequestScope = { database: createDatabase(client), tasks: [] };
  try {
    return await databaseContext.run(scope, callback);
  } finally {
    options.waitUntil(
      Promise.allSettled(scope.tasks).then(() =>
        client.end({ timeout: 5 }).catch((error) => {
          console.error("Failed to close database connection", {
            message: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );
  }
}
