import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findHiddenContainerOpacityFroms } from "./scene-reveal-check.js";
import { findSevereContainerOverflows } from "./inspect-overflow-check.js";
import { findSceneBleedHints } from "./inspect-scene-bleed-hint.js";
import { findContrastFailures } from "./contrast-check.js";
import { checkCompositionIconography } from "./iconography-check.js";

export interface QualityResult {
  ok: boolean;
  /** Combined human-readable diagnostics to feed back to the agent. */
  diagnostics: string;
}

export interface QualityRunner {
  check(projectDir: string, signal: AbortSignal): Promise<QualityResult>;
}

export type QualityCheckKind = "lint" | "validate" | "inspect";

export interface HyperframesQualityRunnerOptions {
  /** Override the argv for a given check (used by tests). */
  commandFor?: (kind: QualityCheckKind, dir: string) => string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

function defaultCommand(kind: QualityCheckKind, dir: string): string[] {
  return ["npx", "--package=hyperframes", "hyperframes", kind, "--json", dir];
}

interface RunOutcome { code: number; stdout: string; stderr: string; }

function runProcess(argv: string[], signal: AbortSignal, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(124); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(130); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export class HyperframesQualityRunner implements QualityRunner {
  private commandFor: (kind: QualityCheckKind, dir: string) => string[];
  private timeoutMs: number;

  constructor(opts: HyperframesQualityRunnerOptions = {}) {
    this.commandFor = opts.commandFor ?? defaultCommand;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(projectDir: string, signal: AbortSignal): Promise<QualityResult> {
    if (!signal.aborted) {
      const icons = await checkCompositionIconography(projectDir);
      if (icons.length) {
        return { ok: false, diagnostics: `[iconography] Commercial iconography check failed:\n${icons.join("\n")}` };
      }
    }
    const parts: string[] = [];
    let ok = true;
    for (const kind of ["lint", "validate", "inspect"] as const) {
      if (signal.aborted) break;
      const out = await runProcess(this.commandFor(kind, projectDir), signal, this.timeoutMs);
      if (out.code !== 0) {
        ok = false;
        parts.push(`[${kind}] exited ${out.code}\n${out.stdout}\n${out.stderr}`.trim());
        // A clipped_text blamed on a scene container is usually a decorative
        // bleeding into the scene's scroll box, and the CLI's own fixHint sends
        // the fixing agent the wrong way — burn a hint, not four fix rounds
        // (prod compose 2026-07-09).
        if (kind === "inspect") {
          const hints = findSceneBleedHints(out.stdout);
          if (hints.length > 0) {
            parts.push(`[inspect-hint] likely root cause:\n${hints.map((h) => `- ${h}`).join("\n")}`);
          }
        }
        continue;
      }
      // validate exits 0 on WCAG contrast failures (they are warnings), but
      // the compose system prompt promises the system validates contrast —
      // low-contrast text is a shipped visual bug. Promote failures.
      if (kind === "validate") {
        const contrastFailures = findContrastFailures(out.stdout);
        if (contrastFailures.length > 0) {
          ok = false;
          parts.push(
            `[validate] WCAG contrast failures (reported as warnings by the CLI):\n${contrastFailures.map((v) => `- ${v}`).join("\n")}`,
          );
        }
      }
      // inspect exits 0 on warnings, but a content element hanging far outside
      // its clipping container is a shipped visual bug, not a style note
      // (session e871ba4d: a logo 587px wider than the canvas passed this
      // gate). Promote severe container_overflow findings to failures.
      if (kind === "inspect") {
        const overflows = findSevereContainerOverflows(out.stdout);
        if (overflows.length > 0) {
          ok = false;
          parts.push(
            `[inspect] severe element overflow (reported as warnings by the CLI):\n${overflows.map((v) => `- ${v}`).join("\n")}`,
          );
        }
      }
    }

    // In-process static guard the CLI checks don't cover: a scene-container
    // gsap.from({opacity|autoAlpha}) renders the scene blank (from() captures
    // end=0 on an already-hidden element). Best-effort: skip if no entry HTML.
    if (!signal.aborted) {
      try {
        const html = await readFile(join(projectDir, "index.html"), "utf8");
        const violations = findHiddenContainerOpacityFroms(html);
        if (violations.length > 0) {
          ok = false;
          parts.push(`[scene-reveal] blank-scene risk:\n${violations.map((v) => `- ${v}`).join("\n")}`);
        }
      } catch {
        // No readable index.html to scan — leave the CLI verdict as-is.
      }
    }

    return { ok, diagnostics: parts.join("\n\n") };
  }
}
