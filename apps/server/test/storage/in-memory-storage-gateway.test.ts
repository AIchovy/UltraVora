import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStorageGateway } from "../helpers/in-memory-storage-gateway.js";

let dir: string;
let gw: InMemoryStorageGateway;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uc-storage-"));
  gw = new InMemoryStorageGateway();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("InMemoryStorageGateway", () => {
  it("upload stores bytes under the key and reports the byte length", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("hello"));
    const { size } = await gw.upload(src, "users/u/sessions/s/a.bin");
    expect(size).toBe(5);
    expect(await gw.exists("users/u/sessions/s/a.bin")).toBe(true);
    expect(await gw.exists("users/u/sessions/s/missing")).toBe(false);
  });

  it("download writes the object to disk, creating parent directories", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("payload"));
    await gw.upload(src, "k/a.bin");
    const dest = join(dir, "deep/nested/out.bin");
    await gw.download("k/a.bin", dest);
    expect(readFileSync(dest)).toEqual(Buffer.from("payload"));
  });

  it("download rejects for a missing key", async () => {
    await expect(gw.download("nope", join(dir, "x"))).rejects.toThrow(/no such object/);
  });

  it("list returns keys under the prefix, sorted", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("x"));
    await gw.upload(src, "p/b");
    await gw.upload(src, "p/a");
    await gw.upload(src, "q/c");
    expect(await gw.list("p/")).toEqual(["p/a", "p/b"]);
  });

  it("deletePrefix removes only matching keys", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("x"));
    await gw.upload(src, "p/a");
    await gw.upload(src, "q/b");
    await gw.deletePrefix("p/");
    expect(await gw.exists("p/a")).toBe(false);
    expect(await gw.exists("q/b")).toBe(true);
  });

  it("signedUrl returns a URL embedding the key; rejects for missing keys", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("x"));
    await gw.upload(src, "p/a");
    expect(await gw.signedUrl("p/a", 60_000)).toContain("p/a");
    await expect(gw.signedUrl("nope", 60_000)).rejects.toThrow(/no such object/);
  });

  it("injected failures: failUploads burns down per call", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("x"));
    gw.failUploads = 1;
    await expect(gw.upload(src, "k")).rejects.toThrow(/injected/);
    expect(await gw.exists("k")).toBe(false); // a failed upload leaves nothing remote
    await expect(gw.upload(src, "k")).resolves.toEqual({ size: 1 });
  });

  it("injected size mismatch: reportedSizeOverride wins over the real length", async () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from("xyz"));
    gw.reportedSizeOverride = 999;
    const { size } = await gw.upload(src, "k");
    expect(size).toBe(999);
  });
});
