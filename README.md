# Trello backend

```sh
bun install
cp .env.example .env
bun run db:generate
bun run db:migrate
bun run dev
```

Swagger UI: `http://localhost:3000/docs`

All API routes except registration, login, and refresh use a bearer access token.
