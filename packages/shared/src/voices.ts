import { z } from "zod";

/**
 * The prebuilt Gemini TTS voices we expose, in display order (alphabetical).
 * Single source of truth for: the schema (validation), the picker UI
 * (labels + tags), and the sample-generation script (which voices to render).
 */
export const ALLOWED_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
] as const;

export type Voice = (typeof ALLOWED_VOICES)[number];

export const VoiceSchema = z.enum(ALLOWED_VOICES);

export const DEFAULT_VOICE: Voice = "Kore";

/** [descriptor, pitch] tags per voice (spellings copied verbatim from source). */
const VOICE_TAGS: Record<Voice, readonly [string, string]> = {
  Achernar: ["Soft", "Higher pitch"],
  Achird: ["Friendly", "Lower middle pitch"],
  Algenib: ["Gravely", "Lower pitch"],
  Algieba: ["Smooth", "Lower pitch"],
  Alnilam: ["Firm", "Lower middle pitch"],
  Aoede: ["Breezy", "Middle pitch"],
  Autonoe: ["Bright", "Middle pitch"],
  Callirrhoe: ["Easy-going", "Middle pitch"],
  Charon: ["Informative", "Lower pitch"],
  Despina: ["Smooth", "Middle pitch"],
  Enceladus: ["Breathy", "Lower pitch"],
  Erinome: ["Clear", "Middle pitch"],
  Fenrir: ["Excitable", "Lower middle pitch"],
  Gacrux: ["Mature", "Middle pitch"],
  Iapetus: ["Clear", "Lower middle pitch"],
  Kore: ["Firm", "Middle pitch"],
  Laomedeia: ["Upbeat", "Higher pitch"],
  Leda: ["Youthful", "Higher pitch"],
  Orus: ["Firm", "Lower middle pitch"],
  Puck: ["Upbeat", "Middle pitch"],
  Pulcherrima: ["Forward", "Middle pitch"],
  Rasalgethi: ["Informative", "Middle pitch"],
  Sadachbia: ["Lively", "Lower pitch"],
  Sadaltager: ["Knowledgeable", "Middle pitch"],
  Schedar: ["Even", "Lower middle pitch"],
  Sulafat: ["Warm", "Middle pitch"],
  Umbriel: ["Easy-going", "Lower pitch"],
  Vindemiatrix: ["Gentle", "Middle pitch"],
  Zephyr: ["Bright", "Higher pitch"],
  Zubenelgenubi: ["Casual", "Lower middle pitch"],
};

export interface VoiceMeta {
  name: Voice;
  tags: readonly [string, string];
}

export const VOICES: readonly VoiceMeta[] = ALLOWED_VOICES.map((name) => ({
  name,
  tags: VOICE_TAGS[name],
}));
