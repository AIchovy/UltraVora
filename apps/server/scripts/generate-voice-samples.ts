/**
 * One-time, manually-run generator for the voice audition clips used by the
 * settings-dialog voice picker. For each catalog voice it synthesizes one
 * shared sample line via Gemini TTS, then uploads it to the PUBLIC bucket
 * selected by VOICE_SAMPLE_BUCKET at `voices/<Name>.wav`. Re-run when the voice list
 * changes (it overwrites existing objects).
 *
 * Env:
 *   GEMINI_API_KEY                 required — Gemini TTS
 *   GOOGLE_APPLICATION_CREDENTIALS required — SA with write to the bucket
 *   VOICE_SAMPLE_BUCKET            required, your own public bucket
 *
 * Run: pnpm -F @ultracreator/server voices:gen
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICES } from "@ultracreator/shared";
import { GeminiTTSProvider } from "../src/providers/gemini-tts.js";
import { GcsStorageGateway } from "../src/storage/gcs-storage-gateway.js";

// Reuse apps/server/.env (same convention as the API server, server.ts). pnpm
// runs this with CWD=apps/server, so this picks up GEMINI_API_KEY and
// GOOGLE_APPLICATION_CREDENTIALS from that file. Shell-provided vars still win —
// loadEnvFile never overrides existing process.env entries.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on shell env */
}

const SAMPLE_LINE =
  "Bright mornings, better coffee. Discover what your product can be.";
const BUCKET = process.env.VOICE_SAMPLE_BUCKET;
const PREFIX = "voices";

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  if (!BUCKET) throw new Error("VOICE_SAMPLE_BUCKET is required");

  const tts = new GeminiTTSProvider({ apiKey });
  const storage = new GcsStorageGateway({ bucketName: BUCKET });
  const tmp = mkdtempSync(join(tmpdir(), "uc-voice-samples-"));

  for (const v of VOICES) {
    const outputPath = join(tmp, `${v.name}.wav`);
    process.stdout.write(`synth ${v.name}… `);
    await tts.synthesize({ text: SAMPLE_LINE, voice: v.name, outputPath });
    const key = `${PREFIX}/${v.name}.wav`;
    const { size } = await storage.upload(outputPath, key);
    console.log(`uploaded ${key} (${size} bytes)`);
  }

  console.log(`Done: ${VOICES.length} voices → gs://${BUCKET}/${PREFIX}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
