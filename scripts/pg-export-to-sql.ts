/**
 * One-off: turns the JSON export of the old Postgres database into a SQL file
 * of INSERTs for D1 (`wrangler d1 execute danto-db --remote --file=...`).
 * Usage: bun run scripts/pg-export-to-sql.ts <export.json> <out.sql>
 */
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { SQLiteTable as TableClass } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";

const [input, output] = process.argv.slice(2);
const data: Record<string, Record<string, unknown>[]> = await Bun.file(
  input,
).json();

// Parents before children so foreign keys hold while inserting.
const order = [
  "users",
  "workspaces",
  "discount_codes",
  "subscriptions",
  "boards",
  "lists",
  "cards",
  "labels",
  "card_labels",
  "card_members",
  "checklists",
  "checklist_items",
  "comments",
  "card_files",
  "client_feedback",
  "activity_logs",
  "invites",
  "workspace_members",
  "board_members",
  "ai_usage_events",
  "discount_redemptions",
  "payment_events",
  "billing_plans",
  "annual_billing_plans",
  "password_resets",
  "admin_audit_logs",
  "admin_login_codes",
];

const tables = new Map<string, SQLiteTable>();
for (const value of Object.values(schema))
  if (is(value, TableClass)) tables.set(getTableConfig(value).name, value);

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const lines: string[] = ["PRAGMA defer_foreign_keys = ON;"];
for (const name of Object.keys(data))
  if (!order.includes(name)) throw new Error(`No import order for ${name}`);

for (const name of order) {
  const rows = data[name] || [];
  const table = tables.get(name);
  if (!table) throw new Error(`Table ${name} is missing from the schema`);
  const columns = getTableConfig(table).columns;
  for (const row of rows) {
    const names: string[] = [];
    const values: string[] = [];
    for (const column of columns) {
      if (!(column.name in row)) continue;
      const raw = row[column.name];
      const type = column.columnType;
      let value: string;
      if (raw === null || raw === undefined) value = "NULL";
      else if (type === "SQLiteTimestamp")
        value = String(new Date(raw as string).getTime());
      else if (type === "SQLiteBoolean") value = raw ? "1" : "0";
      else if (type === "SQLiteTextJson") value = quote(JSON.stringify(raw));
      else if (typeof raw === "number") value = String(raw);
      else value = quote(String(raw));
      names.push(`"${column.name}"`);
      values.push(value);
    }
    const missing = Object.keys(row).filter(
      (key) => !columns.some((column) => column.name === key),
    );
    if (missing.length)
      throw new Error(`${name}: columns not in schema: ${missing.join(", ")}`);
    lines.push(
      `INSERT INTO "${name}" (${names.join(", ")}) VALUES (${values.join(", ")});`,
    );
  }
  console.log(name, rows.length);
}
await Bun.write(output, lines.join("\n") + "\n");
