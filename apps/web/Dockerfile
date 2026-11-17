# Web (Next.js) production image for Cloud Run.
#
# Build context MUST be the repo root — the build needs the workspace lockfile
# and packages/shared, and COPY cannot reach above the context:
#   docker build -f apps/web/Dockerfile .

FROM node:22-alpine AS builder
RUN npm install -g pnpm@10
WORKDIR /repo

# Manifests only, so the install layer stays cached until dependencies change.
# All four workspace package.json files must be present or --frozen-lockfile
# rejects the lockfile (it lists every importer).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @ultracreator/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN mkdir -p apps/web/public

# Frozen into the client bundle and rewrite manifest at `next build` time.
# Pass your own deployment origins with --build-arg for a remote API.
ARG NEXT_PUBLIC_API_URL=
ARG API_PROXY_TARGET=http://127.0.0.1:3001
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL=/voices
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    API_PROXY_TARGET=$API_PROXY_TARGET \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL=$NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @ultracreator/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # SSR reads this again at runtime (server-session.ts) — without it every
    # logged-in user's first paint shows logged-out. Cloud Run env overrides it.
    API_PROXY_TARGET=http://127.0.0.1:3001 \
    # Next standalone binds to HOSTNAME; the PORT default is overridden by
    # whatever Cloud Run injects.
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

# Standalone output keeps the monorepo layout: the entry is apps/web/server.js.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
