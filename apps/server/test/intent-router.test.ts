import { describe, it, expect } from "vitest";
import type { UserMessage } from "@ultracreator/shared";
import { RuleBasedIntentRouter, isAbortText, type RouterState } from "../src/intent/intent-router.js";

const idle: RouterState = { kind: "idle" };
const gateDesign: RouterState = { kind: "awaiting-gate", phase: "design" };
const gateScript: RouterState = { kind: "awaiting-gate", phase: "script" };
const runningResearch: RouterState = { kind: "running", phase: "research" };
const doneState: RouterState = { kind: "done", phase: "render" };

const r = new RuleBasedIntentRouter();
const msg = (text: string, extras: Partial<UserMessage> = {}): UserMessage => ({ text, ...extras });

describe("RuleBasedIntentRouter", () => {
  it("classifies abort keywords regardless of state", async () => {
    for (const text of ["/abort", "abort", "cancel", "stop"]) {
      expect((await r.classify(msg(text), runningResearch)).intent).toBe("abort");
    }
  });

  it("classifies new-project when state is idle and constraints are present", async () => {
    const result = await r.classify(
      msg("Make a promo for Acme", { constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false } }),
      idle,
    );
    expect(result.intent).toBe("new-project");
  });

  it("classifies free text in idle without constraints as ask", async () => {
    expect((await r.classify(msg("hello?"), idle)).intent).toBe("ask");
  });

  it("classifies approve keywords at a gate as approve", async () => {
    for (const text of ["/approve", "approve", "ok", "looks good", "lgtm", "ship it"]) {
      expect((await r.classify(msg(text), gateDesign)).intent).toBe("approve");
    }
  });

  it("classifies non-keyword text at a gate as refine", async () => {
    expect((await r.classify(msg("warmer colors please"), gateDesign)).intent).toBe("refine");
  });

  it("classifies approve keywords when not at a gate as refine", async () => {
    expect((await r.classify(msg("approve"), runningResearch)).intent).toBe("refine");
  });

  it("parses targetPhase from revise-back commands", async () => {
    const a = await r.classify(msg("/back design"), gateScript);
    expect(a.intent).toBe("revise-back");
    expect(a.targetPhase).toBe("design");

    const b = await r.classify(msg("go back to research"), gateScript);
    expect(b.intent).toBe("revise-back");
    expect(b.targetPhase).toBe("research");

    const c = await r.classify(msg("revise design"), gateScript);
    expect(c.intent).toBe("revise-back");
    expect(c.targetPhase).toBe("design");
  });

  it("revise-back without an explicit target falls back to the previous phase", async () => {
    const a = await r.classify(msg("/back"), gateScript);
    expect(a.intent).toBe("revise-back");
    expect(a.targetPhase).toBe("design");
  });

  it("classifies brief-update keywords as update-brief", async () => {
    expect((await r.classify(msg("update duration to 60s"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("change aspect ratio to 9:16"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("turn voiceover off"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("/brief"), gateDesign)).intent).toBe("update-brief");
  });

  it("classifies /branch as branch", async () => {
    expect((await r.classify(msg("/branch"), gateDesign)).intent).toBe("branch");
  });

  it("classifies refine from done state (post-render touch-ups)", async () => {
    expect((await r.classify(msg("make it bluer"), doneState)).intent).toBe("refine");
  });

  it("classifies a short acknowledgement of the finished video as ask, not refine", async () => {
    // A re-run at done charges credits for an identical result — a bare thanks
    // must never trigger one.
    for (const text of ["ok", "looks good!", "thanks", "nice", "谢谢", "很棒"]) {
      expect((await r.classify(msg(text), doneState)).intent).toBe("ask");
    }
  });

  it("still classifies an acknowledgement followed by a change request as refine", async () => {
    expect((await r.classify(msg("ok, but make the logo bigger"), doneState)).intent).toBe("refine");
    expect((await r.classify(msg("looks good but change the ending scene"), doneState)).intent).toBe("refine");
    // Short, but carries a request — the ack guard must not swallow it.
    expect((await r.classify(msg("ok add music"), doneState)).intent).toBe("refine");
    expect((await r.classify(msg("nice, slower please"), doneState)).intent).toBe("refine");
  });

  it("acknowledgement keywords at a gate still approve", async () => {
    expect((await r.classify(msg("looks good"), gateDesign)).intent).toBe("approve");
  });

  it("pure praise at a gate approves instead of billing a re-run", async () => {
    // "perfect"/"thanks" aren't APPROVE_KEYWORDS; without this they'd fall to
    // refine and re-charge the gated phase for a compliment.
    for (const text of ["perfect", "thanks!", "awesome", "很棒"]) {
      expect((await r.classify(msg(text), gateDesign)).intent).toBe("approve");
    }
  });

  it("does not classify abort on stop-substring words", async () => {
    expect((await r.classify(msg("use the stopwatch"), runningResearch)).intent).not.toBe("abort");
  });

  it("does not classify abort on an abort keyword mid-sentence (adjustment text)", async () => {
    // "make the logo stop pulsing" is a change request; a keyword-anywhere match
    // used to swallow it silently as an abort before it ever hit the queue.
    for (const text of [
      "make the logo stop pulsing",
      "the countdown should stop at zero",
      "add a cancel button to scene 2",
      "stop wasting screen space and make the headline bigger",
    ]) {
      expect(isAbortText(text)).toBe(false);
      expect((await r.classify(msg(text), runningResearch)).intent).not.toBe("abort");
    }
  });

  it("still classifies short leading abort imperatives", async () => {
    for (const text of [
      "stop",
      "please cancel",
      "stop the run",
      "abort it now",
      "please stop the render now",
    ]) {
      expect(isAbortText(text)).toBe(true);
      expect((await r.classify(msg(text), runningResearch)).intent).toBe("abort");
    }
  });

  it("at done, a stop-leading adjustment falls through to refine — nothing is running to abort", async () => {
    expect((await r.classify(msg("stop the music"), doneState)).intent).toBe("refine");
    expect((await r.classify(msg("cancel the outro scene"), doneState)).intent).toBe("refine");
  });

  it("at done, a bare stop/cancel is chatter (ask), never a charged re-run", async () => {
    for (const text of ["stop", "cancel", "停止"]) {
      expect((await r.classify(msg(text), doneState)).intent).toBe("ask");
    }
  });

  it("does not classify approve on ok-substring words", async () => {
    expect((await r.classify(msg("use okra"), gateDesign)).intent).not.toBe("approve");
    expect((await r.classify(msg("look out for issues"), gateDesign)).intent).not.toBe("approve");
  });

  it("still classifies abort/approve for the bare keywords", async () => {
    // regression guard
    expect((await r.classify(msg("abort"), runningResearch)).intent).toBe("abort");
    expect((await r.classify(msg("approve"), gateDesign)).intent).toBe("approve");
  });

  it("does not misclassify mentions of brief keywords without a verb cue", async () => {
    expect((await r.classify(msg("the duration looks fine"), gateDesign)).intent).toBe("refine");
    expect((await r.classify(msg("keep the aspect of the layout"), gateDesign)).intent).toBe("refine");
    expect((await r.classify(msg("who's the audience here?"), gateDesign)).intent).toBe("refine");
  });

  it("does not misclassify substring matches inside unrelated words", async () => {
    // 'audience' word-boundary; 'aspectual' should NOT trigger 'aspect'.
    expect((await r.classify(msg("be more aspectual"), gateDesign)).intent).toBe("refine");
  });

  it("requires both a verb cue AND a brief keyword for update-brief (without /brief)", async () => {
    // Verb cue with no keyword — not update-brief.
    expect((await r.classify(msg("update the colors"), gateDesign)).intent).toBe("refine");
  });

  it("still classifies update-brief for /brief and verb+keyword forms", async () => {
    expect((await r.classify(msg("/brief"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("update duration to 60s"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("change aspect ratio to 9:16"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("turn voiceover off"), gateDesign)).intent).toBe("update-brief");
  });
});

describe("abort keywords (CJK)", () => {
  it("classifies short Chinese abort words as abort", async () => {
    for (const text of ["停止", "取消", "中止", "取消吧"]) {
      expect((await r.classify(msg(text), runningResearch)).intent).toBe("abort");
    }
  });

  it("does not treat longer messages mentioning 取消 as abort", async () => {
    const result = await r.classify(msg("把取消按钮改成红色"), runningResearch);
    expect(result.intent).not.toBe("abort");
  });

  it("exports isAbortText for the orchestrator's pre-queue bypass", () => {
    expect(isAbortText("/abort")).toBe(true);
    expect(isAbortText("stop")).toBe(true);
    expect(isAbortText("停止")).toBe(true);
    expect(isAbortText("把取消按钮改成红色")).toBe(false);
    expect(isAbortText("make it warmer")).toBe(false);
  });
});
