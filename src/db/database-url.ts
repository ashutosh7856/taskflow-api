export function normalizeDatabaseUrl(value: string | undefined) {
  if (!value?.trim()) throw new Error("DATABASE_URL is not configured");

  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }

  // Neon includes this libpq option in copied URLs. Postgres.js does not
  // implement it and would otherwise send it as an unsupported startup
  // parameter. TLS is still required through sslmode=require.
  url.searchParams.delete("channel_binding");
  return url.toString();
}
