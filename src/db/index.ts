import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { normalizeDatabaseUrl } from "./database-url";

function createClient() {
  return postgres(normalizeDatabaseUrl(process.env.DATABASE_URL), {
    // A Worker request can open at most six simultaneous external connections.
    // Keep this request-local pool deliberately small.
    max: 3,
    connect_timeout: 10,
    idle_timeout: 20,
    max_lifetime: 10 * 60,
  });
}

function createDatabase(client: ReturnType<typeof createClient>) {
  return drizzle(client, { schema });
}

type Database = ReturnType<typeof createDatabase>;
const databaseContext = new AsyncLocalStorage<Database>();

function activeDatabase() {
  const database = databaseContext.getStore();
  if (!database) throw new Error("Database used outside a request context");
  return database;
}

// Routes can retain the existing `db.query`, `db.insert`, and `db.transaction`
// API while the actual client remains scoped to the current Worker request.
export const db = new Proxy({} as Database, {
  get(_target, property) {
    const database = activeDatabase();
    const value = Reflect.get(database, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

export async function withDatabase<T>(callback: () => Promise<T>) {
  const client = createClient();
  const database = createDatabase(client);
  try {
    return await databaseContext.run(database, callback);
  } finally {
    await client.end({ timeout: 1 }).catch((error) => {
      console.error("Failed to close database connection", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
