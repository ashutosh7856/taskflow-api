/** Applies drizzle/ migrations to the local SQLite file used by `bun dev`. */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";

const url = process.env.SQLITE_URL || "file:.data/danto.db";
if (url.startsWith("file:")) mkdirSync(".data", { recursive: true });
const client = createClient({ url });
await migrate(drizzle(client), { migrationsFolder: "drizzle" });
console.log(`Migrations applied to ${url}`);
client.close();
