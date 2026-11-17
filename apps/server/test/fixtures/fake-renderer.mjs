#!/usr/bin/env node
// Stand-in for `hyperframes render` used by the RenderWorker unit tests.
// CLI: fake-renderer.mjs --output <path> [--fail] [--hang] [--lines <N>]
//                        [--drip <N> | --drip-forever] [--interval <ms>]
import { writeFile } from "node:fs/promises";
import { argv, exit, stdout } from "node:process";

const args = new Map();
for (let i = 2; i < argv.length; i++) {
  const k = argv[i];
  if (!k.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(k.slice(2), next); i++; }
  else args.set(k.slice(2), "true");
}

if (args.get("stream") === "true") {
  // Flood stdout with non-progress log lines forever, in large synchronous
  // bursts. The worker forwards every buffered line inside a single stdout
  // 'data' callback, so a parent IPC disconnect reliably lands while the
  // worker is still mid-burst: it keeps calling process.send() before its
  // event loop ever observes the channel EOF (process.connected still true).
  // A line-by-line trickle leaves that window almost closed and the race
  // only fires under heavy CPU contention — the original full-suite flake.
  let n = 0;
  setInterval(() => {
    let burst = "";
    for (let i = 0; i < 200; i++) burst += `Streaming log line ${++n}\n`;
    stdout.write(burst);
  }, 1);
} else if (args.get("hang") === "true") {
  // Never exit. Used by the timeout/abort tests; the worker must kill us.
  setInterval(() => {}, 1_000_000);
} else if (args.get("drip") || args.get("drip-forever") === "true") {
  // Emit progress lines on an interval — the stall-timer tests: a slow but
  // alive render (drip N then finish) vs an unbounded one (drip-forever).
  const interval = Number(args.get("interval") ?? 100);
  const total = args.get("drip-forever") === "true" ? Infinity : Number(args.get("drip"));
  let i = 0;
  const timer = setInterval(async () => {
    i++;
    const pct = total === Infinity ? Math.min(99, i) : Math.round((i / total) * 100);
    stdout.write(`Rendering frame batch ${i} (${pct}%)\n`);
    if (i >= total) {
      clearInterval(timer);
      const output = args.get("output");
      if (output) await writeFile(output, "FAKE-MP4-BYTES");
      stdout.write("Render complete\n");
      exit(0);
    }
  }, interval);
} else if (args.get("fail") === "true") {
  stdout.write("Encoding failed: synthetic error\n");
  exit(2);
} else {
  const lines = Number(args.get("lines") ?? 3);
  for (let i = 1; i <= lines; i++) {
    const pct = Math.round((i / lines) * 100);
    stdout.write(`Rendering frame batch ${i}/${lines} (${pct}%)\n`);
  }
  const output = args.get("output");
  if (output) await writeFile(output, "FAKE-MP4-BYTES");
  stdout.write("Render complete\n");
  exit(0);
}
