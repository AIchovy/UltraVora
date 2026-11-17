/**
 * Public URL of a voice's pre-generated audition clip. Self-hosted clips live
 * under /voices/<Name>.wav, or at NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL.
 */
const BASE =
  process.env.NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL ??
  "/voices";

export function voiceSampleUrl(name: string): string {
  return `${BASE}/${name}.wav`;
}
