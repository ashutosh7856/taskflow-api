# Cloudflare Worker deployment

The API is deployed as the `taskflow-api` Cloudflare Worker. Wrangler bundles
`src/index.ts` directly; there is no `dist` output directory and no separate
application build command.

## Runtime configuration

Store application secrets on the Worker, not in GitHub Actions. In Cloudflare,
open **Workers & Pages > taskflow-api > Settings > Variables and Secrets**.

Add these as encrypted **Secrets**:

- `DATABASE_URL`
- `JWT_SECRET`
- `RESEND_API_KEY`
- `OPENAI_API_KEY`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_WEBHOOK_ID`
- `ADMIN_EMAILS`

Add these as ordinary **Variables**:

- `FRONTEND_URL` (for example, `https://danto.app`)
- `CORS_ORIGINS` (comma-separated additional frontend origins)
- `EMAIL_FROM`
- `OPENAI_MODEL` (currently `gpt-6-luna`)
- `OPENAI_FALLBACK_MODEL` (currently `gpt-6.1-sol`)
- `PAYPAL_ENV` (`sandbox` or `live`)

Secrets can also be set interactively from this directory:

```sh
bunx wrangler secret put DATABASE_URL
bunx wrangler secret put JWT_SECRET
```

Never commit `.env`, `.dev.vars`, API keys, or database credentials.

## Deployment system: GitHub Actions

GitHub Actions is the production deployment system for this repository.

In the backend GitHub repository, open **Settings > Secrets and variables >
Actions** and add only:

- `CLOUDFLARE_API_TOKEN`: a token with **Edit Cloudflare Workers** permission
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID

The workflow in `.github/workflows/deploy-worker.yml` type-checks, tests, and
deploys every push to `main`. Runtime application secrets remain in Cloudflare
and are not duplicated in GitHub.

In Cloudflare, open **Workers & Pages > taskflow-api > Settings > Builds** and
disconnect the Git repository or disable automatic production builds. The
Worker remains hosted on Cloudflare; only the system that initiates deployment
changes from Workers Builds to GitHub Actions.

Do not keep Workers Builds enabled for production, or each push may deploy
twice.

## Database migrations

Worker deployment does not run Drizzle migrations. Apply a reviewed migration
to the production database before deploying code that depends on it:

```sh
DATABASE_URL='postgres://...' bun run db:migrate
```

Do this from a trusted machine or a separately protected migration workflow.
It is intentionally not part of the normal deploy action.

For production traffic, Cloudflare Hyperdrive is recommended in front of the
PostgreSQL database to pool connections created from many Worker locations.

## Existing password hashes

New passwords use Web Crypto PBKDF2 and work in both Bun and Workers. Passwords
created by the old API use Bun-specific Argon2 hashes. Bun can still verify
those hashes, but Workers cannot; existing users need to reset their password
as part of the first production migration. Do not delete user or workspace data.
