import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForkedRenderWorkerClient } from "../src/render/render-worker-client.js";
import type { WorkerMessage } from "../src/render/worker-protocol.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-ext-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("[external] real hyperframes render", () => {
  it("renders a 5-second draft MP4 from an authored composition", async () => {
    const projectDir = join(root, "composition");
    const outputPath = join(root, "out.mp4");
    await mkdir(projectDir, { recursive: true });

    const html = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#101010}
.clip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.clip h1{font-family:Inter,sans-serif;color:#fff;font-size:96px}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="5" data-track-index="1"><h1 class="t1">Hi</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
window.__timelines["main"] = tl;
</script></body></html>`;
    await writeFile(join(projectDir, "index.html"), html);

    const client = new ForkedRenderWorkerClient();
    const messages: WorkerMessage[] = [];
    for await (const m of client.render({
      projectDir,
      outputPath,
      quality: "draft",
      timeoutMs: 5 * 60 * 1000,
    })) {
      messages.push(m);
    }

    const last = messages.at(-1)!;
    if (last.type === "error") {
      // Print log lines to help diagnose; then fail.
      const logs = messages.filter((m) => m.type === "log").map((m) => (m as { line: string }).line);
      throw new Error(`Render failed: ${last.message}\n--- recent log lines ---\n${logs.slice(-20).join("\n")}`);
    }
    expect(last).toMatchObject({ type: "done", mp4Path: outputPath });
    expect(statSync(outputPath).size).toBeGreaterThan(1024);
  }, 5 * 60 * 1000);
});
