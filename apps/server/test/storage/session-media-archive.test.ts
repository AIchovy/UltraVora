import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { SessionMediaArchive, isArchivable } from "../../src/storage/session-media-archive.js";
import { InMemoryStorageGateway } from "../helpers/in-memory-storage-gateway.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

const SID = "sess-1";
const UID = "user-1";
const PREFIX = `users/${UID}/sessions/${SID}/`;

let root: string;
let workspaces: WorkspaceManager;
let sessions: InMemorySessionRepository;
let storage: InMemoryStorageGateway;
let archive: SessionMediaArchive;
let logs: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-archive-"));
  workspaces = new WorkspaceManager(root);
  sessions = new InMemorySessionRepository();
  await sessions.create({ id: SID, userId: UID });
  await workspaces.init(SID);
  storage = new InMemoryStorageGateway();
  logs = [];
  archive = new SessionMediaArchive({
    storage, workspaces, sessions,
    attempts: 3, baseDelayMs: 1, log: (m) => logs.push(m),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, content = "x"): string {
  const abs = join(root, SID, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe("isArchivable", () => {
  it.each([
    ["output/final.mp4", true],
    ["output/final.srt", true],
    ["composition/narration-s1.wav", true],
    ["composition/bgm.mp3", true],
    ["assets/hero.png", true],
    ["uploads/spec.pdf", true],        // uploads: any extension
    ["uploads/notes.txt", true],
    ["composition/index.html", false], // composition code stays local
    ["composition/data.json", false],
    ["logs/events.jsonl", false],
    ["artifacts/brief.json", false],
    ["initial-message.json", false],   // root-level bookkeeping
  ])("%s → %s", (rel, expected) => {
    expect(isArchivable(rel)).toBe(expected);
  });
});

describe("archiveSession", () => {
  it("uploads heavy media under the key convention and deletes local copies", async () => {
    const mp4 = put("output/final.mp4", "MP4DATA");
    const wav = put("composition/narration-s1.wav", "WAV");
    const html = put("composition/index.html", "<html>");
    const upload = put("uploads/spec.pdf", "PDF");

    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 3, failed: 0 });
    expect([...storage.objects.keys()].sort()).toEqual([
      `${PREFIX}composition/narration-s1.wav`,
      `${PREFIX}output/final.mp4`,
      `${PREFIX}uploads/spec.pdf`,
    ]);
    expect(storage.objects.get(`${PREFIX}output/final.mp4`)).toEqual(Buffer.from("MP4DATA"));
    expect(existsSync(mp4)).toBe(false);
    expect(existsSync(wav)).toBe(false);
    expect(existsSync(upload)).toBe(false);
    expect(existsSync(html)).toBe(true); // composition code never leaves disk
  });

  it("keeps the local file and counts a failure when uploads exhaust retries", async () => {
    const mp4 = put("output/final.mp4");
    storage.failUploads = 99;
    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 0, failed: 1 });
    expect(existsSync(mp4)).toBe(true);
    expect(logs.some((l) => l.includes("output/final.mp4"))).toBe(true);
  });

  it("retries with backoff and succeeds after transient failures", async () => {
    const mp4 = put("output/final.mp4");
    storage.failUploads = 2; // attempts=3 → third try lands
    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 1, failed: 0 });
    expect(existsSync(mp4)).toBe(false);
  });

  it("keeps the local file when the remote size mismatches (verification failure)", async () => {
    const mp4 = put("output/final.mp4", "123456");
    storage.reportedSizeOverride = 1; // 永远错配 → 重试耗尽
    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 0, failed: 1 });
    expect(existsSync(mp4)).toBe(true);
  });

  it("is a no-op for a session without an owner row", async () => {
    put("output/final.mp4");
    const summary = await archive.archiveSession("ghost");
    expect(summary).toEqual({ uploaded: 0, failed: 0 });
    expect(storage.objects.size).toBe(0);
  });

  it("returns zeros for an empty workspace", async () => {
    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 0, failed: 0 });
  });

  it("archives nested uploads subdirectories wholesale and restores them", async () => {
    const nested = put("uploads/refs/brand/logo.bin", "BIN");
    const summary = await archive.archiveSession(SID);
    expect(summary).toEqual({ uploaded: 1, failed: 0 });
    expect(storage.objects.has(`${PREFIX}uploads/refs/brand/logo.bin`)).toBe(true);
    expect(existsSync(nested)).toBe(false);
    await archive.restoreMissing(SID);
    expect(readFileSync(nested, "utf8")).toBe("BIN");
  });
});

describe("restoreMissing", () => {
  it("downloads archived files that are missing locally, skipping output/", async () => {
    const wav = put("composition/narration-s1.wav", "WAV");
    const png = put("assets/hero.png", "PNG");
    const mp4 = put("output/final.mp4", "MP4");
    await archive.archiveSession(SID); // 全部归档,本地删除
    expect(existsSync(wav)).toBe(false);

    await archive.restoreMissing(SID);
    expect(readFileSync(wav, "utf8")).toBe("WAV");
    expect(readFileSync(png, "utf8")).toBe("PNG");
    expect(existsSync(mp4)).toBe(false); // output 永不回拉
  });

  it("leaves files that are already local untouched", async () => {
    const wav = put("composition/narration-s1.wav", "OLD");
    await archive.archiveSession(SID);
    writeFileSync(wav, "NEW"); // 用户重跑期间产生了新本地版本
    await archive.restoreMissing(SID);
    expect(readFileSync(wav, "utf8")).toBe("NEW");
  });
});

describe("ensureLocal", () => {
  it("returns true immediately when the file is already on disk", async () => {
    put("assets/hero.png");
    expect(await archive.ensureLocal(SID, "assets/hero.png")).toBe(true);
  });

  it("downloads an archived file and returns true", async () => {
    const png = put("assets/hero.png", "PNG");
    await archive.archiveSession(SID);
    expect(existsSync(png)).toBe(false);
    expect(await archive.ensureLocal(SID, "assets/hero.png")).toBe(true);
    expect(readFileSync(png, "utf8")).toBe("PNG");
  });

  it("returns false when the file exists nowhere", async () => {
    expect(await archive.ensureLocal(SID, "assets/nope.png")).toBe(false);
  });

  it("rejects path-escape relative paths", async () => {
    expect(await archive.ensureLocal(SID, "../other/secret.png")).toBe(false);
  });
});

describe("signedUrlFor", () => {
  it("returns a URL for an archived file and null otherwise", async () => {
    put("output/final.mp4");
    await archive.archiveSession(SID);
    const url = await archive.signedUrlFor(SID, "output/final.mp4");
    expect(url).toContain(`${PREFIX}output/final.mp4`);
    expect(await archive.signedUrlFor(SID, "output/nope.mp4")).toBeNull();
    expect(await archive.signedUrlFor(SID, "../escape.mp4")).toBeNull();
  });
});

describe("deleteRemote", () => {
  it("removes every object under the session prefix", async () => {
    put("output/final.mp4");
    put("uploads/spec.pdf");
    await archive.archiveSession(SID);
    expect(storage.objects.size).toBe(2);
    await archive.deleteRemote(SID);
    expect(storage.objects.size).toBe(0);
  });
});

describe("per-session serialization", () => {
  it("restoreMissing waits for an in-flight archiveSession on the same session", async () => {
    put("composition/narration-s1.wav", "WAV");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realUpload = storage.upload.bind(storage);
    storage.upload = async (localPath, key) => {
      order.push("upload-start");
      await gate;
      return realUpload(localPath, key);
    };

    const archiving = archive.archiveSession(SID);
    const restoring = archive.restoreMissing(SID).then(() => order.push("restore-done"));
    // Give the queued restore a chance to (incorrectly) run ahead.
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["upload-start"]); // restore has not started
    release();
    await Promise.all([archiving, restoring]);
    expect(order).toEqual(["upload-start", "restore-done"]);
  });
});
