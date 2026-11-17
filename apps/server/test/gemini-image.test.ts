import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiImageProvider, type GeminiImageClient } from "../src/providers/gemini-image.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-gemini-img-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
const fakePngBase64 = PNG.toString("base64");

function fakeClient(capture?: (opts: any) => void): GeminiImageClient {
  return {
    models: {
      generateContent: async (opts: any) => {
        capture?.(opts);
        return {
          candidates: [{
            content: {
              parts: [{
                inlineData: { mimeType: "image/png", data: fakePngBase64 },
              }],
            },
          }],
        };
      },
    },
  };
}

describe("GeminiImageProvider (unit)", () => {
  it("calls the Gemini API and writes a PNG file with the returned bytes", async () => {
    const provider = new GeminiImageProvider({ client: fakeClient(), apiKey: "fake" });
    const out = join(root, "img.png");
    const result = await provider.generate({ prompt: "a green cube", outputPath: out });
    expect(result.imagePath).toBe(out);
    expect(result.mimeType).toBe("image/png");
    expect(existsSync(out)).toBe(true);
    const data = readFileSync(out);
    expect(data.equals(PNG)).toBe(true);
  });

  it("requests the IMAGE response modality and forwards the aspect ratio", async () => {
    let captured: any;
    const provider = new GeminiImageProvider({ client: fakeClient((o) => { captured = o; }), apiKey: "fake" });
    await provider.generate({ prompt: "x", aspectRatio: "16:9", outputPath: join(root, "a.png") });
    expect(captured.config.responseModalities).toContain("IMAGE");
    expect(captured.config.imageConfig.aspectRatio).toBe("16:9");
  });

  it("uses the default model and allows overriding it", async () => {
    let captured: any;
    const dflt = new GeminiImageProvider({ client: fakeClient((o) => { captured = o; }), apiKey: "fake" });
    await dflt.generate({ prompt: "x", outputPath: join(root, "d.png") });
    expect(captured.model).toBe("gemini-3.1-flash-image");

    const custom = new GeminiImageProvider({
      client: fakeClient((o) => { captured = o; }),
      apiKey: "fake",
      model: "some-other-model",
    });
    await custom.generate({ prompt: "x", outputPath: join(root, "c.png") });
    expect(captured.model).toBe("some-other-model");
  });

  it("rejects when the API returns no image inline data", async () => {
    const client: GeminiImageClient = {
      models: {
        generateContent: async () => ({ candidates: [{ content: { parts: [{ text: "no image" }] } }] }),
      },
    };
    const provider = new GeminiImageProvider({ client, apiKey: "fake" });
    await expect(
      provider.generate({ prompt: "x", outputPath: join(root, "x.png") }),
    ).rejects.toThrow(/no image/i);
  });

  it("honors an already-aborted signal before calling the API", async () => {
    let called = false;
    const client: GeminiImageClient = {
      models: {
        generateContent: async () => {
          called = true;
          return { candidates: [] };
        },
      },
    };
    const controller = new AbortController();
    controller.abort();
    const provider = new GeminiImageProvider({ client, apiKey: "fake" });
    await expect(
      provider.generate({ prompt: "x", outputPath: join(root, "x.png"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(called).toBe(false);
  });
});
