# Trello backend

```sh
bun install
cp .env.example .env
bun run db:migrate:local   # creates .data/danto.db (SQLite)
bun run dev
```

## Database

Production uses Cloudflare D1 (`danto-db`, binding `DB` in wrangler.jsonc).
Locally, `bun dev` uses a SQLite file at `.data/danto.db` (override with
`SQLITE_URL`). Both speak the same SQL, and both use the same migrations.

- Change the schema in `src/db/schema`, then `bun run db:generate`.
- Apply locally: `bun run db:migrate:local`.
- Apply to production: `bun run db:migrate:remote` (run this before pushing
  code that needs the new schema).

D1 has no interactive transactions. Writes that must succeed together go in
`db.batch([...])` or `atomic([...])`. Each statement can bind at most 100
values, so insert many rows as one statement per row inside a batch.

Swagger UI: `http://localhost:3000/docs`

All API routes except registration, login, and refresh use a bearer access token.
