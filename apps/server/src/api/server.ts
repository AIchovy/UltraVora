// apps/server/src/api/server.ts
//
// Production bootstrap: the ONLY place that calls composeOrchestrator with real
// LLM / TTS / render deps.  Tests build their own dep graph through createApp()
// directly using fakes — they never go through this file.

import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { composeOrchestrator } from "../compose-orchestrator.js";
import { GeminiTTSProvider } from "../providers/gemini-tts.js";
import { SessionEventLog } from "../events/session-event-log.js";
import { PgEventStore } from "../events/pg-event-store.js";
import { createApp } from "./app.js";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createAuth, betterAuthService, deriveCookieDomain } from "../auth/better-auth.js";
import { ResendEmailService } from "../email/resend-email-service.js";
import { PgSessionRepository } from "../sessions/pg-session-repository.js";
import { PgArtifactRepository } from "../artifacts/pg-artifact-repository.js";
import { PgCreditRepository } from "../credits/pg-credit-repository.js";
import { PgMessageStore } from "../messages/pg-message-store.js";
import { GcsStorageGateway } from "../storage/gcs-storage-gateway.js";
import { PgPublicVideoRepository } from "../public/pg-public-video-repository.js";
import { creemConfigFromEnv } from "../billing/creem-config.js";
import { HttpCreemClient } from "../billing/creem-client.js";

// Load apps/server/.env when present (dev convenience). Shell-provided env
// vars win — loadEnvFile never overrides existing process.env entries.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on shell env */
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";
const BASE_DIR = process.env.WORKSPACES_DIR ?? "./workspaces";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const VISUAL_CRITIC_MODEL = process.env.VISUAL_CRITIC_MODEL;

/**
 * LLM_PROVIDER selects which model backend to use.
 *   "anthropic"   → claude-opus-4-7  (needs ANTHROPIC_API_KEY)
 *   "openrouter"  → configurable via LLM_MODEL, default deepseek/deepseek-v4-pro (needs OPENROUTER_API_KEY)
 *   "gemini"      → gemini-3.1-pro-preview (needs GEMINI_API_KEY)
 */
const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "gemini";
const LLM_MODEL = process.env.LLM_MODEL;

/**
 * Optional dedicated model for intent classification. Unset → the main model
 * classifies intents too. INTENT_LLM_PROVIDER picks its backend (defaults to
 * LLM_PROVIDER), so a cheap model from a different provider works, e.g.
 *   LLM_PROVIDER=openrouter INTENT_LLM_PROVIDER=gemini INTENT_LLM_MODEL=gemini-3.5-flash
 */
const INTENT_LLM_MODEL = process.env.INTENT_LLM_MODEL;
const INTENT_LLM_PROVIDER = process.env.INTENT_LLM_PROVIDER ?? LLM_PROVIDER;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator";
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const BETTER_AUTH_SECRET = required("BETTER_AUTH_SECRET");
const GOOGLE_CLIENT_ID = required("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = required("GOOGLE_CLIENT_SECRET");
// Email-verification delivery (Resend) — RESEND_API_KEY is required now that
// email+password signup sends a 6-digit verification code before login.
// EMAIL_FROM must use the deployer's verified domain. OTP_EXPIRES_MINUTES is optional.
const RESEND_API_KEY = required("RESEND_API_KEY");
const EMAIL_FROM = required("EMAIL_FROM");
const OTP_EXPIRES_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES ?? 15);

// Cross-origin prod: the browser (app.<domain>) calls this API (api.<domain>)
// directly. WEB_ORIGIN is the only thing to set — the CORS allowlist + an extra
// trusted origin. The cross-subdomain cookie domain is derived from WEB_ORIGIN +
// BETTER_AUTH_URL (e.g. app./api.example.com → .example.com); COOKIE_DOMAIN
// overrides it only if the hosts don't share a parent. WEB_ORIGIN unset → CORS
// reflects any origin without credentials and the cookie stays host-only — i.e.
// the same-origin dev setup.
// See docs/superpowers/specs/2026-06-13-cross-origin-auth-design.md
const corsAllowlist = process.env.WEB_ORIGIN
  ? process.env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const cookieDomain =
  process.env.COOKIE_DOMAIN ??
  (corsAllowlist?.[0] ? deriveCookieDomain(corsAllowlist[0], BETTER_AUTH_URL) : undefined);

// DEV payment stubs (/api/billing/grant|subscribe mint credits without
// payment). Anything but exactly "1" keeps them unregistered (404) — the
// production default.
const BILLING_STUBS = process.env.BILLING_STUBS === "1";

// Creem payments: enabled only when the API key, webhook secret, and all
// seven product ids are present (see creem-config.ts). Test vs live is pure
// env config — a creem_test_ key targets test-api.creem.io automatically.
const creemConfig = creemConfigFromEnv(process.env);
if (!creemConfig) {
  console.log(
    `Creem env not fully set — real billing disabled${BILLING_STUBS ? " (dev payment stubs active)" : ""}.`,
  );
}

// Max renders forked at once, process-wide. A render forks a headless-Chrome
// process per session; on the 2-vCPU prod host, several finishing compose at
// once contend for the same CPU, slowing every render down and risking the
// render timeouts (or OOM from multiple simultaneous Chrome instances).
// Default 1: renders queue instead of piling on top of each other. Raise via
// env on a bigger host.
const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY ?? 1);
// Optional render-quality override (draft|standard|high). Unset → the
// orchestrator's default ("high" — final delivery tier).
const RENDER_QUALITY = (() => {
  const raw = process.env.RENDER_QUALITY;
  if (raw === undefined) return undefined;
  if (raw === "draft" || raw === "standard" || raw === "high") return raw;
  throw new Error(`Invalid RENDER_QUALITY "${raw}" (expected draft|standard|high)`);
})();

// GCS media archiving (spec §5). Unset → archiving disabled, files stay local.
const GCS_BUCKET = process.env.GCS_BUCKET;
if (!GCS_BUCKET) {
  console.log("GCS_BUCKET not set — media archiving disabled; session files stay on local disk.");
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

function resolveModel() {
  switch (LLM_PROVIDER) {
    case "anthropic":
      if (!ANTHROPIC_API_KEY) { process.stderr.write("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY\n"); process.exit(1); }
      return requireKnownModel("anthropic", LLM_MODEL ?? "claude-opus-4-7");
    case "openrouter":
      if (!OPENROUTER_API_KEY) { process.stderr.write("LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY\n"); process.exit(1); }
      return requireKnownModel("openrouter", LLM_MODEL ?? "deepseek/deepseek-v4-pro");
    case "gemini":
      if (!GEMINI_API_KEY) { process.stderr.write("LLM_PROVIDER=gemini requires GEMINI_API_KEY\n"); process.exit(1); }
      return requireKnownModel("google", LLM_MODEL ?? "gemini-3.1-pro-preview");
    default:
      process.stderr.write(`Unknown LLM_PROVIDER: ${LLM_PROVIDER}. Use "anthropic", "openrouter", or "gemini".\n`);
      process.exit(1);
  }
}

function requireKnownModel(provider: string, modelId: string): Model<any> {
  const selected = getModel(provider as any, modelId as any) as Model<any> | undefined;
  if (!selected) {
    throw new Error(`Unknown model "${provider}/${modelId}" in the installed pi-ai catalog`);
  }
  return selected;
}

const model = resolveModel();

function resolveIntentModel() {
  if (!INTENT_LLM_MODEL) return undefined;
  switch (INTENT_LLM_PROVIDER) {
    case "anthropic":
      if (!ANTHROPIC_API_KEY) { process.stderr.write("INTENT_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY\n"); process.exit(1); }
      return requireKnownModel("anthropic", INTENT_LLM_MODEL);
    case "openrouter":
      if (!OPENROUTER_API_KEY) { process.stderr.write("INTENT_LLM_PROVIDER=openrouter requires OPENROUTER_API_KEY\n"); process.exit(1); }
      return requireKnownModel("openrouter", INTENT_LLM_MODEL);
    case "gemini":
      if (!GEMINI_API_KEY) { process.stderr.write("INTENT_LLM_PROVIDER=gemini requires GEMINI_API_KEY\n"); process.exit(1); }
      return requireKnownModel("google", INTENT_LLM_MODEL);
    default:
      process.stderr.write(`Unknown INTENT_LLM_PROVIDER: ${INTENT_LLM_PROVIDER}. Use "anthropic", "openrouter", or "gemini".\n`);
      process.exit(1);
  }
}

const intentModel = resolveIntentModel();

// Adapt globalThis.fetch to the narrow signature expected by WebFetchToolOptions.
async function fetchAdapter(url: string, signal?: AbortSignal) {
  const res = await globalThis.fetch(url, signal ? { signal } : undefined);
  return { status: res.status, text: await res.text() };
}

// Binary fetch for download_asset: returns raw bytes + content-type. Caps the
// download so a hostile/huge URL can't exhaust memory before the tool's own
// size check runs (the tool re-validates the final byte length).
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
async function fetchBinaryAdapter(url: string, signal?: AbortSignal) {
  const res = await globalThis.fetch(url, signal ? { signal } : undefined);
  const contentType = res.headers.get("content-type") ?? "";
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Asset too large: ${declared} bytes (max ${MAX_DOWNLOAD_BYTES})`);
  }
  if (!res.body) {
    return { status: res.status, contentType, bytes: Buffer.alloc(0) };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`Asset too large: exceeded ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return { status: res.status, contentType, bytes: Buffer.concat(chunks) };
}

if (!GEMINI_API_KEY) {
  process.stderr.write("GEMINI_API_KEY is required (used for TTS, image generation, and music).\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database + auth
// ---------------------------------------------------------------------------

const { db, pool } = createDb(DATABASE_URL);
// Fail fast when PG is unreachable (spec §8) — migrate connects immediately.
await runMigrations(db);

const sessions = new PgSessionRepository(db);
const credits = new PgCreditRepository(db);
const publicVideos = new PgPublicVideoRepository(db);

const auth = createAuth({
  db,
  baseURL: BETTER_AUTH_URL,
  secret: BETTER_AUTH_SECRET,
  google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
  email: new ResendEmailService({ apiKey: RESEND_API_KEY, from: EMAIL_FROM }),
  otpExpiresMinutes: OTP_EXPIRES_MINUTES,
  ...(corsAllowlist ? { webOrigin: corsAllowlist } : {}),
  ...(cookieDomain ? { cookieDomain } : {}),
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const composed = composeOrchestrator({
  baseDir: BASE_DIR,
  model,
  fetch: fetchAdapter,
  fetchBinary: fetchBinaryAdapter,
  tts: new GeminiTTSProvider({ apiKey: GEMINI_API_KEY }),
  anthropicApiKey: ANTHROPIC_API_KEY,
  openrouterApiKey: OPENROUTER_API_KEY,
  visualCriticModel: VISUAL_CRITIC_MODEL,
  geminiApiKey: GEMINI_API_KEY,
  ...(intentModel ? { intentModel } : {}),
  sessions,
  credits,
  artifactRepo: new PgArtifactRepository(db),
  messageStore: new PgMessageStore(db),
  ...(GCS_BUCKET ? { storageGateway: new GcsStorageGateway({ bucketName: GCS_BUCKET }) } : {}),
  renderConcurrency: RENDER_CONCURRENCY,
  ...(RENDER_QUALITY ? { renderQuality: RENDER_QUALITY } : {}),
});

const eventLog = new SessionEventLog({
  events: composed.events,
  store: new PgEventStore(db),
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = await createApp(
  {
    ...composed,
    eventLog,
    auth: betterAuthService(auth),
    sessions,
    credits,
    publicVideos,
    ...(creemConfig ? { creem: { config: creemConfig, client: new HttpCreemClient(creemConfig) } } : {}),
  },
  {
    logger: true,
    authPublicOrigin: BETTER_AUTH_URL,
    ...(corsAllowlist ? { corsOrigin: corsAllowlist } : {}),
    billingStubs: BILLING_STUBS,
    webOrigin: corsAllowlist?.[0] ?? BETTER_AUTH_URL,
    healthCheck: () => pool.query("select 1"),
  },
);

// Startup recovery (spec §4): re-enqueue messages interrupted by the previous
// process. One SELECT + enqueue — the resumed runs proceed in the background
// after listen.
await composed.orchestrator.recover();

await app.listen({ host: HOST, port: PORT });
console.log(`UltraVora server listening on http://${HOST}:${PORT}`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) process.exit(1);
  closing = true;
  console.log(`Received ${signal}, closing…`);
  // Open SSE streams keep app.close() waiting forever — don't let a stuck
  // close prevent the process from exiting.
  setTimeout(() => {
    console.error("Graceful shutdown timed out after 10s — forcing exit.");
    process.exit(1);
  }, 10_000).unref();
  await app.close();
  await eventLog.closeAll();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
