import type { Model } from "@earendil-works/pi-ai";
import type { Brief, Design, LineageRef, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentForArtifact, type TransientAgentRetryOptions } from "./pi-handler-helpers.js";
import { makeWriteScriptTool } from "../tools/artifact-write-tools.js";
import { COMMERCIAL_ICONOGRAPHY_PROMPT } from "../render/iconography-check.js";

export const SYSTEM_PROMPT = `You are the SCRIPT phase of a promo-video pipeline.

You receive a brief and a design. Produce a scene-by-scene script for the video.

${COMMERCIAL_ICONOGRAPHY_PROMPT}

Tools:
- write_script: persist the final script. Call this EXACTLY ONCE when ready.

STRUCTURE (a promo video is rhythm and escalation, not a slideshow):
- Open with a HOOK (2-3s): one arresting claim, question, or visual promise that earns
  the next 10 seconds — never the product name alone, never "Introducing X".
- Then escalate: problem → solution / feature beats → proof (a number, a quote, social
  proof) → CTA. One idea per scene; don't cram.
- End on a CTA scene HELD for at least 3s: product name/logo plus exactly one action.
- Scene count by duration: ≤15s → 3-5 scenes; ~30s → 5-7; ~60s → 7-10.
- VARY scene lengths deliberately (e.g. 2.5s hook, 6s feature, 4s proof). Adjacent
  scenes should rarely share the same duration — equal slices read as a monotone.

WRITING RULES:
- onScreenText: at most 6 words per scene. It is a headline, not a paragraph — the
  narration carries the detail.
- narration: written for the EAR — short sentences, present tense, concrete verbs, no
  subclauses. Leave room for pauses: target roughly durationSec × 1.8-2.1 words and
  never exceed durationSec × 2.4 words. Short narration creates intentional breathing
  room; narration that overruns its window gets re-timed and destroys your pacing.
- visual: an art-direction directive the compose phase will realize with layout, motion
  and imagery (e.g. "logo sweeps in over a slow-zooming product screenshot, stat counter
  ticks up") — NOT literal on-screen text.
- Cover all keyMessages from the brief across the scenes.

DIRECTOR / STORYBOARD PLAN (required in productionPlan):
- First declare one rhythmPattern and an energyCurve across all scenes. Every level must
  be exactly low, medium, high, or peak. Design the arc; do not give every scene identical
  tempo or intensity.
- Pick ONE primary transition for 60-70% of handoffs and at most two accent
  transitions for the hero reveal / major register shift. A hard cut is valid for an
  intentionally percussive beat and uses durationSec: 0; every animated transition needs
  a positive duration up to 1.5s. Transitions are editorial decisions, not decoration.
- For every scene describe an experiential concept and purpose, mood direction, shot
  type, camera move, and a scene-local heroFrameAtSec.
- Give every scene 3 depth layers: atmospheric background, content-bearing midground,
  and structural/accent foreground. Name the actual elements in each layer.
- Choreograph important elements with concrete physical verbs (SLAMS, DRAWS, TYPES ON,
  FLOATS, LOCKS IN), timing, and deliberate easing. Every visible focal element needs a
  verb; avoid repeating one entrance recipe everywhere.
- effectSlots describe the few moments that deserve a production effect (text emphasis,
  device/UI chrome, light treatment, texture, transition). Effects must serve a beat.
- Plan sparse SFX cues at meaningful sync points: hook, proof hit, hero reveal, CTA.
  atSec and heroFrameAtSec are relative to the scene start. Use no more than 6 SFX cues
  across the whole video; leave breathing room and state the purpose of every cue.
- recurringMotifs must create visual continuity across scenes. soundDirection explains
  the intended relationship between VO, music, silence, impacts and whooshes.
- productionPlan.scenes must map one-to-one to scenes by sceneId. The final scene has no
  transitionOut. Do not omit productionPlan — it is the director handoff used by Compose.

MECHANICS:
- The total duration MUST equal brief.constraints.durationSec.
- If brief.constraints.withVoiceover is true, every scene should have narration.
  If false, leave narration unset (rely on onScreenText).
- Each scene needs startSec and durationSec; consecutive scenes must not overlap.
- Call write_script with the complete script object when finished. Do not call it more than once.

CRITICAL: You are NOT done until you call write_script. Never end your turn with only a
prose summary — the script is only saved when you emit the write_script tool call.`;

export interface PiScriptPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  /** Retry policy for transient network failures talking to the LLM. */
  retry?: TransientAgentRetryOptions;
}

export class PiScriptPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "script";
  constructor(private opts: PiScriptPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    if (!briefEnv) throw new Error("script phase requires a brief artifact, none found");
    if (!designEnv) throw new Error("script phase requires a design artifact, none found");

    const prevScriptEnv = await ctx.artifacts.get(ctx.sessionId, "script");
    const derivedFrom: LineageRef[] = prevScriptEnv
      ? [
          { kind: "script", version: prevScriptEnv.version },
          { kind: "design", version: designEnv.version },
          { kind: "brief", version: briefEnv.version },
        ]
      : [
          { kind: "design", version: designEnv.version },
          { kind: "brief", version: briefEnv.version },
        ];

    const tools = [
      makeWriteScriptTool({
        sessionId: ctx.sessionId,
        artifacts: ctx.artifacts,
        derivedFrom,
        expectedDurationSec: briefEnv.data.constraints.durationSec,
      }),
    ];

    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const promptParts: string[] = [
      `Brief: ${JSON.stringify(briefEnv.data, null, 2)}`,
      `Design: ${JSON.stringify(designEnv.data, null, 2)}`,
    ];
    if (prevScriptEnv) {
      promptParts.push(`Previous script: ${JSON.stringify(prevScriptEnv.data, null, 2)}`);
    }
    if (ctx.refinement) {
      promptParts.push(`Refinement: ${ctx.refinement}`);
    }

    yield* runAgentForArtifact({
      phase: this.phase,
      agent,
      prompt: promptParts.join("\n\n"),
      artifacts: ctx.artifacts,
      sessionId: ctx.sessionId,
      kind: "script",
      toolName: "write_script",
      signal: ctx.signal,
      retry: this.opts.retry,
    });
  }
}
