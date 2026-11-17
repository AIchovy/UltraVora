# Self-hosting UltraVora on GCP

Use your own Google Cloud project, domains, service accounts and buckets. This guide contains no production credentials or resource identifiers.

## Runtime

- Run the Fastify API on one persistent VM with Node.js 22+, pnpm 10, PostgreSQL, FFmpeg, Chromium and suitable fonts. Run `pnpm -F @ultracreator/server exec hyperframes doctor` to check rendering dependencies.
- Install the full workspace with `pnpm install --frozen-lockfile`. The API runs TypeScript with `tsx` and uses HyperFrames from development dependencies.
- Keep session workspaces under `apps/server/workspaces` on persistent storage. Composition files, logs and some artifacts stay local even when GCS archiving is enabled.
- Run one API instance. Startup recovers incomplete sessions; multiple instances can run the same task twice.
- Place an HTTPS reverse proxy in front of the API. Support streaming responses for SSE and adequate upload limits.
- The server applies database migrations at startup. Back up PostgreSQL and workspaces before upgrades.

## Configuration

Start from [the server example](../../apps/server/.env.example). Supply your own database connection, auth secret, Google OAuth credentials, Gemini key, Resend key and verified sender address. Keep them in a secret manager or an untracked environment file.

For separate web/API origins:

```dotenv
# API runtime
NODE_ENV=production
BETTER_AUTH_URL=https://api.example.com
WEB_ORIGIN=https://app.example.com
# Web build time
NEXT_PUBLIC_API_URL=https://api.example.com
NEXT_PUBLIC_SITE_URL=https://app.example.com
API_PROXY_TARGET=https://api.example.com
```

Set `API_PROXY_TARGET` in the web runtime environment too, because server-rendered pages use it to resolve the login session. Register `https://api.example.com/api/auth/callback/google` in your Google OAuth application.

Build the optional web container from the repository root:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  --build-arg API_PROXY_TARGET=https://api.example.com \
  --build-arg NEXT_PUBLIC_SITE_URL=https://app.example.com \
  -t ultravora-web .
```

The web container does not include the API. Set its runtime `API_PROXY_TARGET` to the reachable API origin.

## Optional services

- **Storage:** set `GCS_BUCKET` and `GOOGLE_APPLICATION_CREDENTIALS` for your own bucket and service account. Grant only the bucket access needed for uploads and signed downloads.
- **Voice auditions:** set `VOICE_SAMPLE_BUCKET`, run `pnpm -F @ultracreator/server voices:gen`, then build the web app with `NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL` pointing to your public `/voices` prefix. Alternatively serve clips from `apps/web/public/voices`.
- **Payments:** keep `BILLING_STUBS=0` on shared deployments. Real Creem checkout requires your own API key, webhook secret and seven product IDs. The webhook endpoint is `/api/webhooks/creem`; register it in your own dashboard.

## Before exposing the service

Verify email signup, Google sign-in, a complete video render, session recovery and SSE reconnection. Confirm `/api/billing/grant` and `/api/billing/subscribe` return 404. Configure backups, disk monitoring and access controls for your deployment. Review the included privacy and terms pages for your own service.
