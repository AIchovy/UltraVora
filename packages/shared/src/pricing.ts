// Pricing, credit conversion, subscription plans, and per-operation credit
// consumption. Single source of truth shared by the server (billing + the
// generation pipeline's per-phase credit charges) and the web app (pricing UI).
//
// Cost basis behind the numbers: a typical 1-min / 5-scene video costs us
// ~$1.35 to produce; charging ~400 credits ($4 retail at 100 credits = $1) is a
// ~3x markup. See docs/superpowers/specs/2026-06-25-pricing-credits-design.md.

import type { PhaseId } from "./events.js";

export const CREDITS_PER_USD = 100;

/** Credits a given USD amount buys (1 USD = 100 credits). */
export function creditsForUsd(usd: number): number {
  return Math.round(usd * CREDITS_PER_USD);
}

export interface CreditPack {
  usd: number;
  credits: number;
}

/** One-time credit top-up packs offered in the purchase modal. */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { usd: 20, credits: creditsForUsd(20) },
  { usd: 50, credits: creditsForUsd(50) },
  { usd: 100, credits: creditsForUsd(100) },
] as const;

/** Bounds for a custom top-up amount (in USD). */
export const CUSTOM_CREDIT_BOUNDS = { minUsd: 5, maxUsd: 1000 } as const;

export const PLAN_TIERS = ["free", "pro", "max", "ultra"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface Plan {
  tier: PlanTier;
  name: string;
  /** Recurring monthly price in USD (0 for free). */
  monthlyUsd: number;
  /** Credits granted at the start of every billing month while subscribed. */
  monthlyCredits: number;
  /** One-time credits granted once, on first signup. Only Free uses this. */
  signupBonus: number;
}

// Tiers differ only by price + monthly credit grant — no resolution or
// watermark gating (every tier renders full resolution, no watermark).
const PLANS: Record<PlanTier, Plan> = {
  free: { tier: "free", name: "Free", monthlyUsd: 0, monthlyCredits: 0, signupBonus: 200 },
  pro: { tier: "pro", name: "Pro", monthlyUsd: 20, monthlyCredits: 3000, signupBonus: 0 },
  max: { tier: "max", name: "Max", monthlyUsd: 40, monthlyCredits: 7000, signupBonus: 0 },
  ultra: { tier: "ultra", name: "Ultra", monthlyUsd: 200, monthlyCredits: 40000, signupBonus: 0 },
};

export function getPlan(tier: PlanTier): Plan {
  return PLANS[tier];
}

/** Plans in display order (free → ultra). */
export const PLAN_LIST: readonly Plan[] = PLAN_TIERS.map((t) => PLANS[t]);

export const YEARLY_DISCOUNT = 0.2;

/** Yearly price = 12 months at a 20% discount, rounded to whole dollars. */
export function yearlyUsd(monthlyUsd: number): number {
  return Math.round(monthlyUsd * 12 * (1 - YEARLY_DISCOUNT));
}

/**
 * Per-operation credit prices, charged as the generation pipeline runs. These
 * are a fixed menu (not metered to actual token cost); the orchestrator debits
 * them op-by-op and pauses the session when the balance can't cover the next op.
 */
export const CONSUMPTION = {
  /** research phase: product research + brief */
  researchBrief: 60,
  /** script phase */
  script: 10,
  /** design phase base (excludes generated images) */
  designBase: 15,
  /** each generated image (design or compose) */
  imageEach: 20,
  /** voiceover phase, per narrated scene (one TTS call each) */
  voiceoverPerScene: 10,
  /** compose phase: one background-music track (when BGM is on) */
  music: 25,
  /** compose phase base: authoring the animated HTML */
  composeBase: 160,
  /** render phase: headless-Chrome capture + encode */
  render: 15,
} as const;

export interface VideoCreditEstimateInput {
  images: number;
  narratedScenes: number;
  bgm: boolean;
}

/** Estimate the total credits a video will consume across all phases. */
export function estimateVideoCredits(input: VideoCreditEstimateInput): number {
  return (
    CONSUMPTION.researchBrief +
    CONSUMPTION.script +
    CONSUMPTION.designBase +
    CONSUMPTION.imageEach * input.images +
    CONSUMPTION.voiceoverPerScene * input.narratedScenes +
    (input.bgm ? CONSUMPTION.music : 0) +
    CONSUMPTION.composeBase +
    CONSUMPTION.render
  );
}

// When the exact count isn't known at charge time, the gate assumes these.
const DEFAULT_DESIGN_IMAGES = 2;
const DEFAULT_COMPOSE_IMAGES = 2;
const DEFAULT_NARRATED_SCENES = 5;

export interface PhaseCreditContext {
  /** Narrated scene count (known once the script artifact exists). */
  narratedScenes?: number;
  /** Generated-image count for this phase. */
  images?: number;
  /** Whether background music is enabled (from the brief constraints). */
  bgm?: boolean;
  /**
   * True when the run revises an existing result from a user refinement
   * rather than authoring from scratch. A compose revision edits the current
   * composition and reuses its generated media, so it charges the authoring
   * base without the image/music menu.
   */
  revision?: boolean;
}

/**
 * Credits the orchestrator charges before running a phase. Sums the phase's
 * operations from the CONSUMPTION menu, falling back to representative defaults
 * for counts not yet known at charge time.
 */
export function phaseCredits(phase: PhaseId, ctx: PhaseCreditContext = {}): number {
  switch (phase) {
    case "research":
      return CONSUMPTION.researchBrief;
    case "script":
      return CONSUMPTION.script;
    case "render":
      return CONSUMPTION.render;
    case "voiceover":
      return CONSUMPTION.voiceoverPerScene * (ctx.narratedScenes ?? DEFAULT_NARRATED_SCENES);
    case "design":
      return CONSUMPTION.designBase + CONSUMPTION.imageEach * (ctx.images ?? DEFAULT_DESIGN_IMAGES);
    case "compose":
      if (ctx.revision) return CONSUMPTION.composeBase;
      return (
        CONSUMPTION.composeBase +
        CONSUMPTION.imageEach * (ctx.images ?? DEFAULT_COMPOSE_IMAGES) +
        (ctx.bgm ? CONSUMPTION.music : 0)
      );
  }
}

/** The pipeline's first phase — the orchestrator charges it before anything else runs. */
export const FIRST_PHASE: PhaseId = "research";
