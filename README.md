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

## Vercel

Import the repository with the Hono framework preset. Keep the install command,
build command, and output directory at their detected defaults. Configure
`DATABASE_URL`, `JWT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, and `FRONTEND_URL`
in the Vercel project environment before deploying.
