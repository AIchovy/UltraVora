import { describe, expect, test } from "vitest";
import {
  CREDITS_PER_USD,
  creditsForUsd,
  CREDIT_PACKS,
  CUSTOM_CREDIT_BOUNDS,
  getPlan,
  PLAN_TIERS,
  yearlyUsd,
  CONSUMPTION,
  estimateVideoCredits,
  phaseCredits,
} from "../src/pricing.js";

describe("credit conversion", () => {
  test("1 USD = 100 credits", () => {
    expect(CREDITS_PER_USD).toBe(100);
    expect(creditsForUsd(1)).toBe(100);
    expect(creditsForUsd(20)).toBe(2000);
    expect(creditsForUsd(100)).toBe(10000);
  });
});

describe("credit packs", () => {
  test("offers $20/$50/$100 packs at 100 credits per dollar", () => {
    expect(CREDIT_PACKS).toEqual([
      { usd: 20, credits: 2000 },
      { usd: 50, credits: 5000 },
      { usd: 100, credits: 10000 },
    ]);
  });
  test("custom amount is bounded $5–$1000", () => {
    expect(CUSTOM_CREDIT_BOUNDS).toEqual({ minUsd: 5, maxUsd: 1000 });
  });
});

describe("subscription plans", () => {
  test("the tiers are free, pro, max, ultra in order", () => {
    expect(PLAN_TIERS).toEqual(["free", "pro", "max", "ultra"]);
  });
  test("free grants a one-time 200-credit signup bonus and no monthly refresh", () => {
    const free = getPlan("free");
    expect(free.monthlyUsd).toBe(0);
    expect(free.signupBonus).toBe(200);
    expect(free.monthlyCredits).toBe(0);
  });
  test("pro/max/ultra prices and monthly grants", () => {
    expect(getPlan("pro").monthlyUsd).toBe(20);
    expect(getPlan("pro").monthlyCredits).toBe(3000);
    expect(getPlan("max").monthlyUsd).toBe(40);
    expect(getPlan("max").monthlyCredits).toBe(7000);
    expect(getPlan("ultra").monthlyUsd).toBe(200);
    expect(getPlan("ultra").monthlyCredits).toBe(40000);
  });
  test("yearly billing is 20% off, rounded to whole dollars", () => {
    expect(yearlyUsd(20)).toBe(192); // 20*12*0.8
    expect(yearlyUsd(40)).toBe(384);
    expect(yearlyUsd(200)).toBe(1920);
    expect(yearlyUsd(0)).toBe(0);
  });
});

describe("consumption", () => {
  test("per-operation credit menu", () => {
    expect(CONSUMPTION.researchBrief).toBe(60);
    expect(CONSUMPTION.script).toBe(10);
    expect(CONSUMPTION.designBase).toBe(15);
    expect(CONSUMPTION.imageEach).toBe(20);
    expect(CONSUMPTION.voiceoverPerScene).toBe(10);
    expect(CONSUMPTION.music).toBe(25);
    expect(CONSUMPTION.composeBase).toBe(160);
    expect(CONSUMPTION.render).toBe(15);
  });
  test("a typical 5-scene, 4-image, narrated, BGM video ≈ 415 credits", () => {
    expect(estimateVideoCredits({ images: 4, narratedScenes: 5, bgm: true })).toBe(415);
  });
  test("a leaner video (no music, no images, 3 narrated scenes) costs 290", () => {
    expect(estimateVideoCredits({ images: 0, narratedScenes: 3, bgm: false })).toBe(290);
  });
});

describe("phaseCredits (per-phase charge for the orchestrator gate)", () => {
  test("flat phases", () => {
    expect(phaseCredits("research")).toBe(60);
    expect(phaseCredits("script")).toBe(10);
    expect(phaseCredits("render")).toBe(15);
  });
  test("voiceover scales with narrated scenes (default 5)", () => {
    expect(phaseCredits("voiceover")).toBe(50);
    expect(phaseCredits("voiceover", { narratedScenes: 3 })).toBe(30);
  });
  test("design includes a default 2-image allowance", () => {
    expect(phaseCredits("design")).toBe(55); // 15 + 2*20
    expect(phaseCredits("design", { images: 1 })).toBe(35);
  });
  test("compose = base + images + music (bgm defaults off)", () => {
    expect(phaseCredits("compose", { bgm: true })).toBe(225); // 160 + 2*20 + 25
    expect(phaseCredits("compose", { bgm: false })).toBe(200);
    expect(phaseCredits("compose")).toBe(200);
  });
  test("a compose revision charges the authoring base only (media is reused)", () => {
    expect(phaseCredits("compose", { revision: true })).toBe(160);
    expect(phaseCredits("compose", { revision: true, bgm: true, images: 3 })).toBe(160);
    // Other phases ignore the flag — their price has no reusable-media component.
    expect(phaseCredits("render", { revision: true })).toBe(15);
    expect(phaseCredits("design", { revision: true })).toBe(55);
  });
  test("a default full run (bgm on) sums to 415", () => {
    const total =
      phaseCredits("research") +
      phaseCredits("design") +
      phaseCredits("script") +
      phaseCredits("voiceover") +
      phaseCredits("compose", { bgm: true }) +
      phaseCredits("render");
    expect(total).toBe(415);
  });
});
