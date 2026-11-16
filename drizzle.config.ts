import { defineConfig } from "drizzle-kit";

// Generates SQLite migrations for Cloudflare D1. Apply them with:
//   bun run db:migrate:local    (local .data/danto.db)
//   bun run db:migrate:remote   (production D1)
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
