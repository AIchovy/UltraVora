import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RenderCommand, WorkerMessage } from "./worker-protocol.js";

// The hard cap bounds runaways only; liveness is judged by the stall timer.
// Prod evidence (2026-07-13): successful renders on the 2-vCPU VM take
// 221-264s — the old 5-min total cap killed renders still progressing at
// 55-78%. Silence is the failure signal, not duration.
const DEFAULT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;

// Matches percent tokens like "(42%)", " 42%", "42%\n", "(42% )" — both fake-renderer
// and real `npx hyperframes render` output. The percent number must be 1–3 digits and
// must be bounded by start/whitespace/`(` on the left and whitespace/`)`/end on the right.
const PROGRESS_RE = /(?:^|[\s(])(\d{1,3})%(?=[\s)]|$)/;

// Strip ANSI escape sequences (CSI, OSC, etc.) so the progress regex sees clean text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

function send(msg: WorkerMessage): void {
  if (!process.send) {
    // Running standalone (not forked). Useful for ad-hoc debugging only.
    process.stdout.write(`[worker-msg] ${JSON.stringify(msg)}\n`);
    return;
  }
  // Best-effort forwarder: the parent can tear down the IPC channel at any time
  // (iterator abandoned, abort, parent exit) while the renderer's buffered stdout
  // is still arriving. Dropping the message beats crashing on a closed channel.
  //
  // The callback is load-bearing. After the parent closes its end of the
  // channel there is a window where this process has not yet observed the
  // EOF — process.connected is still true — and the underlying write fails
  // with EPIPE. Node reports send() failures asynchronously: with no
  // callback it emits 'error' on `process` on a later tick, which is an
  // uncaught exception (exit code 1) that no try/catch here can intercept.
  // With a callback, the same failures are handed to the callback instead.
  if (!process.connected) return;
  try {
    process.send(msg, (err: Error | null) => { void err; });
  } catch {
    // Defensive only: current Node never throws synchronously from send().
  }
}

function defaultRendererCommand(cmd: RenderCommand): string[] {
  const base = ["npx", "--package=hyperframes", "hyperframes", "render", "--output", cmd.outputPath];
  if (cmd.quality) { base.push("--quality", cmd.quality); }
  if (cmd.fps) { base.push("--fps", String(cmd.fps)); }
  return base;
}

async function runRender(cmd: RenderCommand): Promise<void> {
  await mkdir(dirname(cmd.outputPath), { recursive: true });
  const argv = cmd.rendererCommand ?? defaultRendererCommand(cmd);
  const [exe, ...args] = argv;
  if (!exe) {
    send({ type: "error", message: "rendererCommand is empty" });
    return;
  }

  const child: ChildProcess = spawn(exe, args, { cwd: cmd.projectDir, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let settled = false;
  let lastPercent = 0;

  const settleError = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    clearTimeout(stallTimer);
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    send({ type: "error", message });
  };

  const hardMs = cmd.timeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
  const stallMs = cmd.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const hardTimer = setTimeout(
    () => settleError(`Render timed out after ${Math.round(hardMs / 60000)} minutes (reached ${lastPercent}%)`),
    hardMs,
  );
  let stallTimer = setTimeout(onStall, stallMs);
  function onStall(): void {
    settleError(`Render stalled — no renderer output for ${Math.round(stallMs / 60000)} minutes (at ${lastPercent}%)`);
  }
  /** Any renderer output = alive: push the stall deadline out. */
  function pulse(): void {
    if (settled) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(onStall, stallMs);
  }

  // If the parent goes away (IPC disconnect), kill the subprocess.
  process.on("disconnect", () => { try { child.kill("SIGKILL"); } catch { /* ignore */ } });

  // Real hyperframes emits progress with carriage-return + ANSI; the fake-renderer
  // emits with newline. Split on any of \r, \n, or \r\n so both shapes work.
  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pulse();
    stdoutBuf += chunk.toString("utf8");
    let match: RegExpExecArray | null;
    const splitRe = /\r\n|\r|\n/;
    while ((match = splitRe.exec(stdoutBuf)) !== null) {
      const line = stdoutBuf.slice(0, match.index);
      stdoutBuf = stdoutBuf.slice(match.index + match[0].length);
      const clean = line.replace(ANSI_RE, "").trim();
      if (!clean) continue;
      const m = PROGRESS_RE.exec(clean);
      if (m) {
        const percent = Math.min(100, Math.max(0, Number(m[1])));
        lastPercent = Math.max(lastPercent, percent);
        send({ type: "progress", percent, message: clean });
      } else {
        send({ type: "log", line: clean });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { pulse(); stderr += chunk.toString("utf8"); });

  child.on("error", (err) => settleError(err.message));
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    clearTimeout(stallTimer);
    if (code === 0) {
      send({ type: "progress", percent: 100 });
      send({ type: "done", mp4Path: cmd.outputPath });
    } else {
      const tail = stderr.split("\n").slice(-10).join("\n").trim();
      send({ type: "error", message: `Renderer exited with code ${code}${tail ? `: ${tail}` : ""}` });
    }
    // Allow the parent to consume the final message, then exit cleanly.
    process.nextTick(() => process.exit(0));
  });
}

process.on("message", (msg: unknown) => {
  const m = msg as RenderCommand;
  if (m && typeof m === "object" && m.type === "render") {
    void runRender(m);
  }
});

send({ type: "ready" });
