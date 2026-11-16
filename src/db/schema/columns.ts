import { integer, text } from "drizzle-orm/sqlite-core";

/** Column helpers so the SQLite (D1) schema reads like the old Postgres one. */

/** Text UUID primary key generated in JS (D1 has no gen_random_uuid). */
export const id = (name: string) =>
  text(name)
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** A non-key column that defaults to a fresh random UUID (invite tokens). */
export const randomUuid = (name: string) =>
  text(name).$defaultFn(() => crypto.randomUUID());

/** A UUID stored as text (foreign keys). */
export const uuidRef = (name: string) => text(name);

/** Dates are stored as Unix milliseconds and read back as `Date`. */
export const timestamp = (name: string) =>
  integer(name, { mode: "timestamp_ms" });

export const bool = (name: string) => integer(name, { mode: "boolean" });

/** JSON stored as text; Drizzle parses it back into an object. */
export const json = (name: string) => text(name, { mode: "json" });

/** Postgres enums become text columns limited to a set of values. */
export const enumText =
  <const T extends readonly [string, ...string[]]>(values: T) =>
  (name: string) =>
    text(name, { enum: values as unknown as [T[number], ...T[number][]] });
