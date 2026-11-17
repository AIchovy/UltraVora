import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-ws-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  it("init creates the full session directory layout", async () => {
    const wm = new WorkspaceManager(root);
    const paths = await wm.init("s1");
    expect(existsSync(paths.uploads)).toBe(true);
    expect(existsSync(paths.artifacts)).toBe(true);
    expect(existsSync(paths.composition)).toBe(true);
    expect(existsSync(paths.output)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);
  });

  it("exposes an assets path and creates it on init", async () => {
    const wm = new WorkspaceManager(root);
    const p = wm.paths("s1");
    expect(p.assets).toBe(join(root, "s1", "assets"));
    await wm.init("s1");
    expect(existsSync(p.assets)).toBe(true);
  });

  it("paths returns deterministic locations under the session root", () => {
    const wm = new WorkspaceManager(root);
    const paths = wm.paths("s1");
    expect(paths.root).toBe(join(root, "s1"));
    expect(paths.artifacts).toBe(join(root, "s1", "artifacts"));
  });

  it("saveUpload writes a valid file and returns its stored path", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const stored = await wm.saveUpload("s1", "logo.png", Buffer.from("PNGDATA"));
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored, "utf8")).toBe("PNGDATA");
    expect(stored.startsWith(join(root, "s1", "uploads"))).toBe(true);
  });

  it("saveUpload rejects a disallowed extension", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    await expect(wm.saveUpload("s1", "evil.exe", Buffer.from("x"))).rejects.toThrow(/extension/i);
  });

  it("saveUpload rejects a file over the size limit", async () => {
    const wm = new WorkspaceManager(root, { maxUploadBytes: 4 });
    await wm.init("s1");
    await expect(wm.saveUpload("s1", "big.png", Buffer.from("12345"))).rejects.toThrow(/size/i);
  });

  it("saveUpload sanitizes path-traversal filenames", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const stored = await wm.saveUpload("s1", "../../etc/passwd.png", Buffer.from("x"));
    expect(stored.startsWith(join(root, "s1", "uploads"))).toBe(true);
    expect(stored).not.toContain("..");
    // the file physically lands inside uploads as a flat, sanitized name
    expect(existsSync(join(root, "s1", "uploads", "passwd.png"))).toBe(true);
  });

  it("saveUpload de-duplicates a colliding basename into a distinct stored path", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const first = await wm.saveUpload("s1", "shot.png", Buffer.from("ONE"));
    const second = await wm.saveUpload("s1", "shot.png", Buffer.from("TWO"));
    // Distinct destinations — the second must not clobber the first.
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("ONE");
    expect(readFileSync(second, "utf8")).toBe("TWO");
    expect(basename(first)).toBe("shot.png");
    expect(basename(second)).toBe("shot-2.png");
  });

  it("rejects a path-traversal session id", () => {
    const wm = new WorkspaceManager(root);
    expect(() => wm.paths("../../etc")).toThrow(/invalid session id/i);
  });

  it("rejects an empty or dotted session id", () => {
    const wm = new WorkspaceManager(root);
    expect(() => wm.paths("")).toThrow(/invalid session id/i);
    expect(() => wm.paths("..")).toThrow(/invalid session id/i);
    expect(() => wm.paths("a/b")).toThrow(/invalid session id/i);
  });
});
