import type { LucideIcon } from "lucide-react";
import { Cpu, ListChecks, Zap, Clapperboard } from "lucide-react";

export const ACCENT_KEYS = ["blue", "emerald", "amber", "violet"] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

/**
 * The four "promo style" seeds used by the logged-in home gallery: clicking a
 * style pill expands its preset prompts, and each style is tinted by its accent.
 */
export interface SeedStyle {
  id: string;
  title: string;
  inspiration: string;
  icon: LucideIcon;
  accent: AccentKey;
  prompts: string[];
}

export const SEED_STYLES: SeedStyle[] = [
  {
    id: "minimalist-tech",
    title: "Minimalist Tech",
    inspiration: "Clean, bright, futuristic",
    icon: Cpu,
    accent: "blue",
    prompts: [
      "A clean product reveal: white seamless background, soft studio lighting, the product rotating slowly with crisp UI callouts.",
      "Bright minimal walkthrough of the dashboard's three core features, generous whitespace, subtle depth-of-field, calm pacing.",
      "Futuristic hero shot: the app floating in a softly lit gradient space, thin geometric accents, kinetic typography for each benefit.",
      "Macro close-ups of the interface with smooth pans, a monochrome palette plus one accent color, confident minimal captions.",
    ],
  },
  {
    id: "pro-walkthrough",
    title: "Pro Walkthrough",
    inspiration: "Logical SaaS walkthrough",
    icon: ListChecks,
    accent: "emerald",
    prompts: [
      "A structured SaaS walkthrough: screen recording framed in a clean device mockup, numbered steps, voiceover-friendly pacing.",
      "Explain the core workflow end to end, annotated cursor highlights, section title cards, a professional and reassuring tone.",
      "Before/after comparison of the manual process vs. our product, split-screen, clear labels, a measurable outcome at the end.",
      "Feature deep-dive: zoom into one capability, callout bubbles, a short customer-style scenario, a crisp corporate look.",
    ],
  },
  {
    id: "dynamic-promo",
    title: "Dynamic Promo",
    inspiration: "Fast, punchy, scroll-stopping",
    icon: Zap,
    accent: "amber",
    prompts: [
      "Fast-cut social ad: punchy beat-synced edits, bold full-screen captions, high-energy product moments.",
      "Scroll-stopping vertical teaser: an instant hook, zoom punches, sticker-style text, a trending vibe.",
      "Montage of the product in action set to an upbeat track, snappy transitions, a vivid color grade, a strong end-card CTA.",
      "Event-style hype reel: countdown intro, flashing key features, energetic motion graphics, loud and confident.",
    ],
  },
  {
    id: "brand-narrative",
    title: "Brand Narrative",
    inspiration: "Immersive brand storytelling",
    icon: Clapperboard,
    accent: "violet",
    prompts: [
      "Cinematic brand story: a warm film look, slow push-ins, evocative b-roll, an emotional voiceover arc.",
      "Origin story — the problem we kept hitting and the team that set out to fix it, an intimate tone, textured visuals.",
      "Immersive lifestyle film showing the product woven into real moments, soft music, elegant typography, a premium feel.",
      "Values-driven manifesto: poetic narration, striking hero imagery, a memorable closing brand statement.",
    ],
  },
];
