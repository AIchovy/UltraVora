export type ProviderType = "tts" | "image" | "music";

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface SpeakerSpec {
  speaker: string;
  voice: string;
}

export interface TTSInput {
  text: string;
  voice?: string;
  language?: string;
  /**
   * Natural-language delivery direction (tone, pace, energy), e.g.
   * "Say in a warm, confident tone". Providers that support style prompts
   * pass it as direction, never as spoken content.
   */
  styleInstruction?: string;
  /** When set, request multi-speaker synthesis. Each speaker label in the prompt maps to a voice. */
  speakers?: SpeakerSpec[];
  /** Output path the provider should write to (absolute path, .mp3 or .wav extension). */
  outputPath: string;
  signal?: AbortSignal;
}

export interface TTSResult {
  audioPath: string;
  durationMs: number;
  wordTimings?: WordTiming[];
}

export interface TTSProvider {
  readonly id: string;
  synthesize(input: TTSInput): Promise<TTSResult>;
}

export interface ImageInput {
  /** Text-to-image prompt describing the desired image. */
  prompt: string;
  /** Optional aspect ratio hint, e.g. "16:9", "1:1", "9:16". */
  aspectRatio?: string;
  /** Output path the provider should write to (absolute path, .png extension). */
  outputPath: string;
  signal?: AbortSignal;
}

export interface ImageResult {
  imagePath: string;
  mimeType: string;
}

export interface ImageProvider {
  readonly id: string;
  generate(input: ImageInput): Promise<ImageResult>;
}

export interface MusicInput {
  /** Text prompt describing the desired background music (mood, genre, instrumentation). */
  prompt: string;
  /** Target length in seconds. The track should be at least this long. */
  durationSec: number;
  /** Output path the provider should write to (absolute path). */
  outputPath: string;
  signal?: AbortSignal;
}

export interface MusicResult {
  audioPath: string;
  mimeType: string;
}

export interface MusicProvider {
  readonly id: string;
  generate(input: MusicInput): Promise<MusicResult>;
}

export interface ProviderTypeMap {
  tts: TTSProvider;
  image: ImageProvider;
  music: MusicProvider;
}
