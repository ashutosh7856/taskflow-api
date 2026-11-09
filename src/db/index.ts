import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { normalizeDatabaseUrl } from "./database-url";

const client = postgres(normalizeDatabaseUrl(process.env.DATABASE_URL), {
  max: 3,
  connect_timeout: 10,
  idle_timeout: 20,
  max_lifetime: 10 * 60,
});

export const db = drizzle(client, { schema });
