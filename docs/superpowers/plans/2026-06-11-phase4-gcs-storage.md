# Phase 4: GCS Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `render.done`, archive heavy media to the GCS bucket (upload → verify → delete local), serve archived files via 302 signed-URL fallback in the files route, pull archived files back to disk before phase re-runs, and clean the GCS prefix on session delete. Acceptance (spec §1): delete the local mp4 — the frontend still plays it.

**Architecture:** A narrow `StorageGateway` interface (spec §9) with a production `GcsStorageGateway` (official `@google-cloud/storage`) and a test `InMemoryStorageGateway`. A `SessionMediaArchive` service owns the key convention `users/<userId>/sessions/<sid>/<workspace-relative path>`, the archive policy, per-file retry/backoff, restore, signed URLs, and remote delete — all per-session serialized on the existing `SessionQueue`. Triggering: `EventBus` gains `subscribeAll`; the composition root subscribes and fires a background archive on every `render.done`. The orchestrator gets an optional `media` dep and awaits `restoreMissing` at the start of every `runFromPhase`. Everything is optional: no `GCS_BUCKET` → behavior identical to today (dev/test default).

**Tech Stack:** `@google-cloud/storage` (V4 signed URLs, crc32c upload validation), Fastify 5 routes, Vitest with in-memory fakes. TS ESM NodeNext — all relative imports need the `.js` suffix.

---

## Design decisions (read before implementing)

| 决策点 | 结论 | 理由 |
|---|---|---|
| GCS 抽象 | `StorageGateway` 接口 + 内存 fake | spec §9 明确要求;测试不打真桶 |
| 上传校验 | 库自带 `validation: "crc32c"` + 比对返回的 size | 官方库在 crc32c 不匹配时报错并删除远端坏对象;resolve 即已校验。size 比对是第二道保险(spec §5 "size/crc32c") |
| `ensureLocal` 位置 | `SessionMediaArchive`,**不在** WorkspaceManager | spec §5 原文写在 WorkspaceManager,但对象键内嵌 userId,WorkspaceManager 不知道用户。行为意图(缺失自动拉回)不变,只调整归属。终审时按此口径评审 |
| 归档触发 | `EventBus.subscribeAll` 监听 `render.done` | orchestrator 不耦合存储策略;装配全部留在 composition root |
| 重跑前恢复 | orchestrator 可选 `media.restoreMissing`,`runFromPhase` 开头 await | 恢复必须先于 handler 读文件,只能在运行路径上同步等待 |
| 归档范围 | `uploads/` 整目录(任意扩展名);`assets/`、`composition/`、`output/` 按重媒体扩展名;`logs/`、`artifacts/`、根级文件(initial-message.json)永不归档 | spec §5:"成品 mp4/srt、配音与音乐音频、生成图、用户上传件"。composition 代码(.html/.tsx/.json)是阶段输入,永远留本地 |
| restore 范围 | 跳过 `output/` | output 是最终交付物,任何阶段都不读它;签名 URL 直接服务。否则每次重跑都要回拉历史 mp4,纯浪费 |
| 失败语义 | 归档失败:留本地、逐文件指数退避、永不抛给用户;DELETE 清桶 best-effort;restore 整体 catch | spec §8:"GCS 上传失败:本地不删、退避重试,不影响用户观看" |
| 并发 | `SessionMediaArchive` 内部自持一个 `SessionQueue`,archive/restore/deleteRemote 同会话串行 | 后台归档删文件不能与重跑前的 restore 交错 |
| 功能开关 | `GCS_BUCKET` 未设置 → 整个子系统关闭 | 本地开发、CI、现有全部测试零感知 |

### ⚠️ 测试 gotcha(吃过亏的都在这)

1. **ownerOf 返回 null 则一切 no-op。** `SessionMediaArchive` 每个方法先查 `sessions.get(sid)?.userId`。直接调 `orchestrator.handleMessage("s1", …)` 的测试**必须先** `await sessions.create({ id: "s1", userId: "u-test" })`,否则归档静默跳过、断言莫名超时。
2. **新项目消息必须带 `constraints`。** `RuleBasedIntentRouter` 只在 idle + 有 constraints 时判 new-project;裸 text 会被归为 "ask",管线根本不跑。
3. **归档是后台 fire-and-forget。** 断言桶内容用 `vi.waitFor`,不要在 `handleMessage` resolve 后立刻断言。
4. **重试退避在测试里传 `baseDelayMs: 1` 进 `SessionMediaArchive`**,否则注入失败的用例要等真实秒级退避。

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/server/src/storage/storage-gateway.ts` | Create | 对象存储窄接口(upload/exists/download/signedUrl/list/deletePrefix) |
| `apps/server/test/helpers/in-memory-storage-gateway.ts` | Create | Map 存对象的 fake;可注入失败/size 错配 |
| `apps/server/src/storage/gcs-storage-gateway.ts` | Create | @google-cloud/storage 薄封装 |
| `apps/server/src/storage/session-media-archive.ts` | Create | 键约定 + 归档/恢复/签名 URL/删除 + 重试 + 串行 |
| `apps/server/src/events/event-bus.ts` | Modify | 增 `subscribeAll` |
| `apps/server/src/orchestrator/session-orchestrator.ts` | Modify | 可选 `media` 依赖;runFromPhase 前 restoreMissing |
| `apps/server/src/compose-orchestrator.ts` | Modify | 可选 `storageGateway`;构建 media;订阅 render.done |
| `apps/server/src/api/app.ts` | Modify | AppDeps 可选 `media` |
| `apps/server/src/api/files-routes.ts` | Modify | 本地 miss → 302 签名 URL |
| `apps/server/src/api/sessions-routes.ts` | Modify | DELETE 先清 GCS 前缀 |
| `apps/server/src/api/server.ts` | Modify | GCS_BUCKET 装配 |
| `.gitignore` | Modify | 加 `apps/server/secrets/` |
| `apps/server/test/storage/*.test.ts` | Create | T1/T2/T3 单测 |
| `apps/server/test/events/event-bus.test.ts` | Create | subscribeAll 行为 |
| `apps/server/test/storage/archive-integration.test.ts` | Create | T6 端到端验收 |

测试命令(根目录执行):
- 单文件:`pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/session-media-archive.test.ts`
- 全量:`pnpm test`;类型:`pnpm typecheck`

---

### Task 1: StorageGateway 接口 + InMemoryStorageGateway

**Files:**
- Create: `apps/server/src/storage/storage-gateway.ts`
- Create: `apps/server/test/helpers/in-memory-storage-gateway.ts`
- Test: `apps/server/test/storage/in-memory-storage-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/storage/in-memory-storage-gateway.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/in-memory-storage-gateway.test.ts`
Expected: FAIL — cannot find module `../helpers/in-memory-storage-gateway.js`

- [ ] **Step 3: Write the interface**

```ts
// apps/server/src/storage/storage-gateway.ts
/**
 * Narrow abstraction over the media object store (GCS in production, an
 * in-memory fake in tests — spec §9). Keys are full object names, e.g.
 * `users/<userId>/sessions/<sid>/output/final.mp4`. The key convention lives
 * in SessionMediaArchive, not here.
 */
export interface StorageGateway {
  /**
   * Upload with integrity validation. Resolves only after the object is
   * verified server-side (GCS: crc32c — the client library deletes the remote
   * object and rejects on mismatch). Returns the remote size so the caller can
   * run its own size check before deleting the local copy.
   */
  upload(localPath: string, key: string): Promise<{ size: number }>;
  exists(key: string): Promise<boolean>;
  /** Download to localPath, creating parent directories as needed. */
  download(key: string, localPath: string): Promise<void>;
  /** Time-limited read URL (GCS: V4 signed URL). */
  signedUrl(key: string, ttlMs: number): Promise<string>;
  /** Every object key under the prefix (recursive, no delimiter semantics). */
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}
```

- [ ] **Step 4: Write the fake**

```ts
// apps/server/test/helpers/in-memory-storage-gateway.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StorageGateway } from "../../src/storage/storage-gateway.js";

/**
 * In-memory StorageGateway: objects live in a Map, but upload/download still
 * touch the real filesystem so archive/restore flows are exercised end to end.
 * Test-only knobs: `objects` (direct inspection), `failUploads` (transient
 * failure simulation), `reportedSizeOverride` (verification-mismatch simulation).
 */
export class InMemoryStorageGateway implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  /** While > 0, each upload() call throws and decrements. */
  failUploads = 0;
  /** When set, upload() reports this size instead of the stored byte length. */
  reportedSizeOverride: number | null = null;

  async upload(localPath: string, key: string): Promise<{ size: number }> {
    if (this.failUploads > 0) {
      this.failUploads--;
      throw new Error("injected upload failure");
    }
    const bytes = await readFile(localPath);
    this.objects.set(key, bytes);
    return { size: this.reportedSizeOverride ?? bytes.byteLength };
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async download(key: string, localPath: string): Promise<void> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`no such object: ${key}`);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, bytes);
  }

  async signedUrl(key: string, ttlMs: number): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`no such object: ${key}`);
    return `https://storage.fake/${key}?ttl=${ttlMs}&sig=fake`;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) this.objects.delete(k);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/in-memory-storage-gateway.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm typecheck
git add apps/server/src/storage/storage-gateway.ts apps/server/test/helpers/in-memory-storage-gateway.ts apps/server/test/storage/in-memory-storage-gateway.test.ts
git commit -m "feat(server): StorageGateway interface + in-memory fake (phase 4 T1)"
```

---

### Task 2: GcsStorageGateway

**Files:**
- Modify: `apps/server/package.json`(添加 `@google-cloud/storage` 依赖,经 pnpm 安装)
- Create: `apps/server/src/storage/gcs-storage-gateway.ts`
- Modify: `.gitignore`(加 `apps/server/secrets/`)
- Test: `apps/server/test/storage/gcs-storage-gateway.test.ts`

- [ ] **Step 1: Install the dependency**

```bash
pnpm -C apps/server add @google-cloud/storage
```

- [ ] **Step 2: Write the failing test**

测试注入一个 fake `Storage`,断言委托参数(不打真桶)。

```ts
// apps/server/test/storage/gcs-storage-gateway.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Storage } from "@google-cloud/storage";
import { GcsStorageGateway } from "../../src/storage/gcs-storage-gateway.js";

/** Minimal fake of the @google-cloud/storage surface the gateway touches. */
function fakeStorage() {
  const file = {
    exists: vi.fn(async () => [true]),
    download: vi.fn(async () => undefined),
    getSignedUrl: vi.fn(async () => ["https://signed.example/x"]),
  };
  const bucket = {
    upload: vi.fn(async () => [{ metadata: { size: "5" } }]),
    file: vi.fn(() => file),
    getFiles: vi.fn(async () => [[{ name: "p/a" }, { name: "p/b" }]]),
    deleteFiles: vi.fn(async () => undefined),
  };
  const storage = { bucket: vi.fn(() => bucket) };
  return { storage: storage as unknown as Storage, bucket, file };
}

let f: ReturnType<typeof fakeStorage>;
let gw: GcsStorageGateway;

beforeEach(() => {
  f = fakeStorage();
  gw = new GcsStorageGateway({ bucketName: "YOUR_PRIVATE_BUCKET", storage: f.storage });
});

describe("GcsStorageGateway", () => {
  it("binds the configured bucket", () => {
    expect((f.storage.bucket as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("YOUR_PRIVATE_BUCKET");
  });

  it("upload delegates with destination key and crc32c validation, returns numeric size", async () => {
    const res = await gw.upload("/tmp/a.mp4", "users/u/sessions/s/output/a.mp4");
    expect(f.bucket.upload).toHaveBeenCalledWith("/tmp/a.mp4", {
      destination: "users/u/sessions/s/output/a.mp4",
      validation: "crc32c",
    });
    expect(res).toEqual({ size: 5 });
  });

  it("exists unwraps the [boolean] tuple", async () => {
    expect(await gw.exists("k")).toBe(true);
    expect(f.bucket.file).toHaveBeenCalledWith("k");
  });

  it("download passes the destination path", async () => {
    await gw.download("k", "/tmp/deep/out.bin");
    expect(f.file.download).toHaveBeenCalledWith({ destination: "/tmp/deep/out.bin" });
  });

  it("signedUrl requests a v4 read URL with a future expiry", async () => {
    const before = Date.now();
    const url = await gw.signedUrl("k", 15 * 60 * 1000);
    expect(url).toBe("https://signed.example/x");
    const arg = f.file.getSignedUrl.mock.calls[0]![0] as { version: string; action: string; expires: number };
    expect(arg.version).toBe("v4");
    expect(arg.action).toBe("read");
    expect(arg.expires).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
  });

  it("list maps getFiles results to names", async () => {
    expect(await gw.list("p/")).toEqual(["p/a", "p/b"]);
    expect(f.bucket.getFiles).toHaveBeenCalledWith({ prefix: "p/" });
  });

  it("deletePrefix delegates to deleteFiles", async () => {
    await gw.deletePrefix("p/");
    expect(f.bucket.deleteFiles).toHaveBeenCalledWith({ prefix: "p/" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/gcs-storage-gateway.test.ts`
Expected: FAIL — cannot find module `gcs-storage-gateway.js`

- [ ] **Step 4: Write the implementation**

```ts
// apps/server/src/storage/gcs-storage-gateway.ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Storage } from "@google-cloud/storage";
import type { Bucket } from "@google-cloud/storage";
import type { StorageGateway } from "./storage-gateway.js";

export interface GcsStorageGatewayOptions {
  bucketName: string;
  /**
   * Injectable for tests. Default `new Storage()` — the client reads
   * GOOGLE_APPLICATION_CREDENTIALS from the environment by itself.
   */
  storage?: Storage;
}

export class GcsStorageGateway implements StorageGateway {
  private bucket: Bucket;

  constructor(opts: GcsStorageGatewayOptions) {
    this.bucket = (opts.storage ?? new Storage()).bucket(opts.bucketName);
  }

  async upload(localPath: string, key: string): Promise<{ size: number }> {
    // crc32c validation: the library compares its local checksum against the
    // metadata GCS returns and deletes the remote object on mismatch, so a
    // resolved promise means a verified upload.
    const [file] = await this.bucket.upload(localPath, {
      destination: key,
      validation: "crc32c",
    });
    return { size: Number(file.metadata.size) };
  }

  async exists(key: string): Promise<boolean> {
    const [ok] = await this.bucket.file(key).exists();
    return ok;
  }

  async download(key: string, localPath: string): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    await this.bucket.file(key).download({ destination: localPath });
  }

  async signedUrl(key: string, ttlMs: number): Promise<string> {
    const [url] = await this.bucket.file(key).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + ttlMs,
    });
    return url;
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.bucket.getFiles({ prefix });
    return files.map((file) => file.name);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.bucket.deleteFiles({ prefix });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/gcs-storage-gateway.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Gitignore the secrets directory**

`.gitignore`(repo 根)在 `workspaces/` 行后追加一行:

```
apps/server/secrets/
```

验证:`git check-ignore -v apps/server/secrets/gcp-service-account.json` 输出该规则。

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck
git add apps/server/package.json pnpm-lock.yaml apps/server/src/storage/gcs-storage-gateway.ts apps/server/test/storage/gcs-storage-gateway.test.ts .gitignore
git commit -m "feat(server): GcsStorageGateway over @google-cloud/storage (phase 4 T2)"
```

---

### Task 3: SessionMediaArchive

**Files:**
- Create: `apps/server/src/storage/session-media-archive.ts`
- Test: `apps/server/test/storage/session-media-archive.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/storage/session-media-archive.test.ts
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
    storage.reportedSizeOverride = 1; //永远错配 → 重试耗尽
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/session-media-archive.test.ts`
Expected: FAIL — cannot find module `session-media-archive.js`

- [ ] **Step 3: Write the implementation**

```ts
// apps/server/src/storage/session-media-archive.ts
import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { SessionRepository } from "../sessions/session-repository.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import { SessionQueue } from "../orchestrator/session-queue.js";
import { sleepUnlessAborted } from "../retry.js";
import type { StorageGateway } from "./storage-gateway.js";

/**
 * Heavy media (spec §5): rendered video + subtitles, voiceover/music audio,
 * generated/downloaded images. Composition code (.html/.tsx/.json) is a phase
 * input and stays local-only.
 */
const HEAVY_MEDIA_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".srt",
]);

/**
 * `uploads/` archives wholesale (user files of any type); `assets/`,
 * `composition/` and `output/` archive heavy media only; `logs/`, `artifacts/`
 * and root-level bookkeeping files (initial-message.json) never leave disk.
 */
export function isArchivable(rel: string): boolean {
  const slash = rel.indexOf("/");
  if (slash === -1) return false; // root-level bookkeeping file
  const top = rel.slice(0, slash);
  if (top === "logs" || top === "artifacts") return false;
  if (top === "uploads") return true;
  return HEAVY_MEDIA_EXTENSIONS.has(extname(rel).toLowerCase());
}

/** No leading slash, no empty/"."/".." segments — keys must stay under the prefix. */
function isSafeRelPath(rel: string): boolean {
  if (rel.startsWith("/")) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Phases read uploads/assets/composition; output/ holds final deliverables
 * that are only ever served (via signed URL once archived), so restore skips
 * it — otherwise every re-run would pull historical mp4s back for nothing.
 */
const RESTORE_EXCLUDED_TOP_DIRS = new Set(["output"]);

export interface SessionMediaArchiveOptions {
  storage: StorageGateway;
  workspaces: WorkspaceManager;
  sessions: SessionRepository;
  /** Per-file upload attempts including the first; default 4. */
  attempts?: number;
  /** First backoff delay, doubling per retry; default 2000ms. Tests pass 1. */
  baseDelayMs?: number;
  /** Failure sink; default console.warn. */
  log?: (message: string) => void;
  /** Signed URL lifetime; default 15 minutes (spec §5). */
  signedUrlTtlMs?: number;
}

export interface ArchiveSummary {
  uploaded: number;
  failed: number;
}

/**
 * Owns the workspace ⇄ object-store media lifecycle (spec §5):
 *  - archiveSession: after render.done, upload heavy media, verify (gateway
 *    validation + size check), delete the local copy only on success. Per-file
 *    failures keep the local file and never throw — the user keeps watching
 *    from disk; the next render.done re-attempts.
 *  - restoreMissing / ensureLocal: pull archived files back before a phase
 *    re-run reads them.
 *  - signedUrlFor: files-route fallback once the local copy is gone.
 *  - deleteRemote: prefix cleanup on session delete.
 *
 * Key convention: users/<userId>/sessions/<sid>/<workspace-relative path>.
 * Mutating flows are serialized per session on a SessionQueue so a background
 * archive cannot delete files while a restore repopulates them.
 */
export class SessionMediaArchive {
  private queue = new SessionQueue();
  private attempts: number;
  private baseDelayMs: number;
  private log: (message: string) => void;
  private signedUrlTtlMs: number;

  constructor(private opts: SessionMediaArchiveOptions) {
    this.attempts = opts.attempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 2000;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.signedUrlTtlMs = opts.signedUrlTtlMs ?? 15 * 60 * 1000;
  }

  /** Trailing slash keeps sibling session ids with a shared prefix disjoint. */
  private prefixOf(userId: string, sessionId: string): string {
    return `users/${userId}/sessions/${sessionId}/`;
  }

  private async ownerOf(sessionId: string): Promise<string | null> {
    const row = await this.opts.sessions.get(sessionId);
    return row?.userId ?? null;
  }

  async archiveSession(sessionId: string): Promise<ArchiveSummary> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return { uploaded: 0, failed: 0 };
      const root = this.opts.workspaces.paths(sessionId).root;
      const summary: ArchiveSummary = { uploaded: 0, failed: 0 };
      for (const rel of await this.archivableFiles(root)) {
        try {
          await this.uploadVerifyDelete(join(root, rel), this.prefixOf(userId, sessionId) + rel);
          summary.uploaded++;
        } catch (err) {
          // Local copy stays — the user keeps watching from disk (spec §8).
          summary.failed++;
          this.log(
            `[media-archive] ${sessionId}: upload failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return summary;
    });
  }

  /**
   * Download every archived object (except output/) whose local copy is
   * missing. Called before a phase (re-)run; per-file failures are logged, not
   * thrown — a phase that truly needs the file fails with its own clear error.
   */
  async restoreMissing(sessionId: string): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return;
      const prefix = this.prefixOf(userId, sessionId);
      const root = this.opts.workspaces.paths(sessionId).root;
      for (const key of await this.opts.storage.list(prefix)) {
        const rel = key.slice(prefix.length);
        if (RESTORE_EXCLUDED_TOP_DIRS.has(rel.split("/")[0]!)) continue;
        const abs = join(root, rel);
        if (existsSync(abs)) continue;
        try {
          await this.opts.storage.download(key, abs);
        } catch (err) {
          this.log(
            `[media-archive] ${sessionId}: restore failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  /** Make one workspace-relative file present locally; true if it now exists. */
  async ensureLocal(sessionId: string, rel: string): Promise<boolean> {
    if (!isSafeRelPath(rel)) return false;
    return this.queue.enqueue(sessionId, async () => {
      const abs = join(this.opts.workspaces.paths(sessionId).root, rel);
      if (existsSync(abs)) return true;
      const userId = await this.ownerOf(sessionId);
      if (!userId) return false;
      const key = this.prefixOf(userId, sessionId) + rel;
      if (!(await this.opts.storage.exists(key))) return false;
      await this.opts.storage.download(key, abs);
      return true;
    });
  }

  /** Signed read URL for an archived file, or null when no such object exists. */
  async signedUrlFor(sessionId: string, rel: string): Promise<string | null> {
    if (!isSafeRelPath(rel)) return null;
    const userId = await this.ownerOf(sessionId);
    if (!userId) return null;
    const key = this.prefixOf(userId, sessionId) + rel;
    if (!(await this.opts.storage.exists(key))) return null;
    return this.opts.storage.signedUrl(key, this.signedUrlTtlMs);
  }

  /**
   * Delete every archived object for the session. MUST run before the
   * creator_sessions row is deleted — the key prefix embeds the owner's id.
   */
  async deleteRemote(sessionId: string): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const userId = await this.ownerOf(sessionId);
      if (!userId) return;
      await this.opts.storage.deletePrefix(this.prefixOf(userId, sessionId));
    });
  }

  /** Workspace-relative archivable paths, sorted for deterministic order. */
  private async archivableFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(root, join(e.parentPath, e.name)))
      .filter((rel) => isArchivable(rel))
      .sort();
  }

  /** Upload with retry/backoff, verify remote size, then delete the local copy. */
  private async uploadVerifyDelete(abs: string, key: string): Promise<void> {
    const localSize = (await stat(abs)).size;
    for (let attempt = 1; ; attempt++) {
      try {
        const { size } = await this.opts.storage.upload(abs, key);
        if (size !== localSize) {
          throw new Error(`size mismatch after upload: local ${localSize}, remote ${size}`);
        }
        break;
      } catch (err) {
        if (attempt >= this.attempts) throw err;
        await sleepUnlessAborted(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    await unlink(abs);
  }
}
```

注意:重试循环刻意重试**任何**错误(不是只有 isTransientNetworkError)——GCS 客户端的失败形态多样,且此路径在后台、不影响用户,宽松重试代价低。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/session-media-archive.test.ts`
Expected: PASS(约 17 tests)

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add apps/server/src/storage/session-media-archive.ts apps/server/test/storage/session-media-archive.test.ts
git commit -m "feat(server): SessionMediaArchive — archive/restore/signed-url/delete lifecycle (phase 4 T3)"
```

---

### Task 4: EventBus.subscribeAll + 触发/恢复接线

**Files:**
- Modify: `apps/server/src/events/event-bus.ts`
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/src/compose-orchestrator.ts`
- Modify: `apps/server/src/api/server.ts`
- Test: `apps/server/test/events/event-bus.test.ts`(新建)
- Test: `apps/server/test/orchestrator.test.ts`(追加一个 describe)
- Test: `apps/server/test/compose-orchestrator-integration.test.ts`(追加一个用例)

- [ ] **Step 1: Write the failing EventBus test**

```ts
// apps/server/test/events/event-bus.test.ts
import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/events/event-bus.js";
import type { ServerEvent } from "@ultracreator/shared";

const evt = (msg: string): ServerEvent => ({ type: "phase.progress", phase: "render", message: msg });

describe("EventBus.subscribeAll", () => {
  it("receives every session's events with the session id", () => {
    const bus = new EventBus();
    const seen: Array<[string, ServerEvent]> = [];
    bus.subscribeAll((sid, e) => seen.push([sid, e]));
    bus.emit("a", evt("1"));
    bus.emit("b", evt("2"));
    expect(seen).toEqual([["a", evt("1")], ["b", evt("2")]]);
  });

  it("fires even when the session has no per-session listeners", () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribeAll(() => count++);
    bus.emit("nobody-listening", evt("x"));
    expect(count).toBe(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribeAll(() => count++);
    bus.emit("a", evt("1"));
    off();
    bus.emit("a", evt("2"));
    expect(count).toBe(1);
  });

  it("does not disturb per-session listeners", () => {
    const bus = new EventBus();
    const perSession: ServerEvent[] = [];
    bus.subscribe("a", (e) => perSession.push(e));
    bus.subscribeAll(() => {});
    bus.emit("a", evt("1"));
    expect(perSession).toEqual([evt("1")]);
  });
});
```

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/events/event-bus.test.ts`
Expected: FAIL — `subscribeAll is not a function`

- [ ] **Step 2: Implement subscribeAll**

`apps/server/src/events/event-bus.ts` 全文替换为:

```ts
import type { ServerEvent } from "@ultracreator/shared";

export type EventListener = (event: ServerEvent) => void;
export type GlobalEventListener = (sessionId: string, event: ServerEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private globalListeners = new Set<GlobalEventListener>();

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  /** Cross-session firehose (e.g. the media archiver watching render.done). */
  subscribeAll(listener: GlobalEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  emit(sessionId: string, event: ServerEvent): void {
    const set = this.listeners.get(sessionId);
    if (set) for (const listener of [...set]) listener(event);
    for (const listener of [...this.globalListeners]) listener(sessionId, event);
  }
}
```

Run the test again — PASS (4 tests)。

- [ ] **Step 3: Orchestrator — optional media dep, failing test first**

在 `apps/server/test/orchestrator.test.ts` 末尾追加 describe。该文件已有 `buildOrchestrator` helper(返回 `{orchestrator, events, artifacts, sessions, messages, root}`,接受 `{handlers?}`);本用例需要自定义依赖,直接 inline 构造(模仿文件内既有模式,使用文件内已 import 的 fakes):

```ts
describe("media restore before phase runs", () => {
  it("awaits media.restoreMissing before the first handler starts", async () => {
    const calls: string[] = [];
    const handler: PhaseHandler = {
      phase: "research",
      // eslint-disable-next-line require-yield
      async *run() {
        calls.push("handler");
        return;
      },
    };
    const media = {
      restoreMissing: async (sid: string) => {
        calls.push(`restore:${sid}`);
      },
    };
    const root = mkdtempSync(join(tmpdir(), "uc-orch-media-"));
    try {
      const events = new EventBus();
      const orchestrator = new SessionOrchestrator({
        workspaces: new WorkspaceManager(root),
        events,
        artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers: new Map([["research", handler]]),
        sessions: new InMemorySessionRepository(),
        messages: new InMemoryMessageStore(),
        media,
      });
      await orchestrator.handleMessage("m1", {
        text: "make a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      expect(calls[0]).toBe("restore:m1");
      expect(calls).toContain("handler");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a throwing restoreMissing does not break the run", async () => {
    let ran = false;
    const handler: PhaseHandler = {
      phase: "research",
      // eslint-disable-next-line require-yield
      async *run() {
        ran = true;
        return;
      },
    };
    const root = mkdtempSync(join(tmpdir(), "uc-orch-media2-"));
    try {
      const events = new EventBus();
      const orchestrator = new SessionOrchestrator({
        workspaces: new WorkspaceManager(root),
        events,
        artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers: new Map([["research", handler]]),
        sessions: new InMemorySessionRepository(),
        messages: new InMemoryMessageStore(),
        media: { restoreMissing: async () => { throw new Error("GCS down"); } },
      });
      await orchestrator.handleMessage("m2", {
        text: "make a promo",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      expect(ran).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

若文件顶部缺少其中某个 import(`PhaseHandler` 类型等),按文件既有 import 风格补齐。

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/orchestrator.test.ts`
Expected: FAIL — `media` 不是合法依赖(TS 报错)或 restore 未被调用。

- [ ] **Step 4: Implement the orchestrator hook**

`apps/server/src/orchestrator/session-orchestrator.ts`:

(a) 在 `OrchestratorDeps` 上方加窄接口,并在 deps 中登记:

```ts
/** Narrow slice of SessionMediaArchive the orchestrator depends on. */
export interface MediaRestorer {
  restoreMissing(sessionId: string): Promise<void>;
}

export interface OrchestratorDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  intentRouter: IntentRouter;
  handlers: ReadonlyMap<PhaseId, PhaseHandler>;
  sessions: SessionRepository;
  messages: MessageStore;
  /** Optional: pulls archived media back to disk before a phase (re-)run. */
  media?: MediaRestorer;
}
```

(b) `runFromPhase` 函数体最前面(`const controller = new AbortController()` 之前)插入:

```ts
    // Archived media (post-render cleanup, spec §5) must be back on disk
    // before a phase re-run reads it. Best-effort: when the store is
    // unreachable but the inputs are still local, the run proceeds anyway.
    if (this.deps.media) {
      await this.deps.media.restoreMissing(sessionId).catch(() => undefined);
    }
```

Run the orchestrator test — PASS。

- [ ] **Step 5: composeOrchestrator wiring, failing test first**

在 `apps/server/test/compose-orchestrator-integration.test.ts` 追加用例(模仿文件内既有构造,所有 composeOrchestrator 调用参数与该文件现状一致,新增两个参数):

```ts
it("archives heavy media to the storage gateway after render.done", async () => {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_design", designData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  const sessions = new InMemorySessionRepository();
  await sessions.create({ id: "arch-1", userId: "u-test" });
  const gateway = new InMemoryStorageGateway();
  const { orchestrator, media } = composeOrchestrator({
    baseDir: root,
    model: faux.getModel("uc-test")!,
    fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
    tts: new StubTTSProvider(),
    renderWorkerClient: new StubRenderWorkerClient({ writeOutput: true }),
    composeHandlerOverride: new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    }),
    sessions,
    artifactRepo: new InMemoryArtifactRepository(),
    messageStore: new InMemoryMessageStore(),
    storageGateway: gateway,
  });
  expect(media).toBeDefined();

  await orchestrator.handleMessage("arch-1", {
    text: "Make a 30-second promo for https://acme.example",
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
  });
  await orchestrator.handleMessage("arch-1", { text: "approve" });
  await orchestrator.handleMessage("arch-1", { text: "approve" });
  expect(orchestrator.getState("arch-1")).toEqual({ kind: "done", lastPhase: "render" });

  // Archive runs in the background off render.done — poll the bucket.
  await vi.waitFor(() => {
    const keys = [...gateway.objects.keys()];
    expect(keys.some((k) => /^users\/u-test\/sessions\/arch-1\/output\/.+\.mp4$/.test(k))).toBe(true);
  });
});
```

注意:该文件的 faux 响应 fixture(briefData/designData/scriptData/VALID_HTML/passRunner)如已存在则复用;若该文件没有,从 `apps/server/test/pipeline-e2e.test.ts` 复制同名常量。`vi` 需在 import 中包含。`InMemoryStorageGateway` 从 `./helpers/in-memory-storage-gateway.js` import。

Run: Expected FAIL — `storageGateway` 不是合法参数 / `media` undefined。

- [ ] **Step 6: Implement composeOrchestrator + server.ts wiring**

`apps/server/src/compose-orchestrator.ts`:

(a) imports 追加:

```ts
import type { StorageGateway } from "./storage/storage-gateway.js";
import { SessionMediaArchive } from "./storage/session-media-archive.js";
```

(b) `ComposeOrchestratorOptions` 追加(放在 `messageStore` 之后):

```ts
  /**
   * Optional object store for heavy-media archiving (spec §5). When omitted
   * (dev/test default), nothing is archived and all files stay on local disk.
   */
  storageGateway?: StorageGateway;
```

(c) `ComposedOrchestrator` 追加:

```ts
  media?: SessionMediaArchive;
```

(d) 函数体:在 `const orchestrator = new SessionOrchestrator({...})` 之前构建并订阅:

```ts
  const media = opts.storageGateway
    ? new SessionMediaArchive({
        storage: opts.storageGateway,
        workspaces,
        sessions: opts.sessions,
      })
    : undefined;
  if (media) {
    // Background archive on every completed render (spec §5). archiveSession
    // already swallows per-file failures; the catch covers owner-lookup faults.
    events.subscribeAll((sessionId, event) => {
      if (event.type === "render.done") void media.archiveSession(sessionId).catch(() => undefined);
    });
  }
```

(e) `SessionOrchestrator` deps 追加 `...(media ? { media } : {})`;return 改为:

```ts
  return { orchestrator, workspaces, events, artifacts, phases, providers, ...(media ? { media } : {}) };
```

`apps/server/src/api/server.ts`:

(a) import 追加:

```ts
import { GcsStorageGateway } from "../storage/gcs-storage-gateway.js";
```

(b) env 区(`GOOGLE_CLIENT_SECRET` 行后)追加:

```ts
// GCS media archiving (spec §5). Unset → archiving disabled, files stay local.
const GCS_BUCKET = process.env.GCS_BUCKET;
if (!GCS_BUCKET) {
  console.log("GCS_BUCKET not set — media archiving disabled; session files stay on local disk.");
}
```

(c) `composeOrchestrator({...})` 参数追加:

```ts
  ...(GCS_BUCKET ? { storageGateway: new GcsStorageGateway({ bucketName: GCS_BUCKET }) } : {}),
```

`createApp` 的 deps 是 `{ ...composed, eventLog, auth, sessions }` 展开,`composed.media` 会自动流入 AppDeps(T5 增加该字段)——本任务无需改 createApp 调用。

- [ ] **Step 7: Run tests + typecheck + commit**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/events/event-bus.test.ts apps/server/test/orchestrator.test.ts apps/server/test/compose-orchestrator-integration.test.ts
pnpm typecheck
git add apps/server/src/events/event-bus.ts apps/server/src/orchestrator/session-orchestrator.ts apps/server/src/compose-orchestrator.ts apps/server/src/api/server.ts apps/server/test/events/event-bus.test.ts apps/server/test/orchestrator.test.ts apps/server/test/compose-orchestrator-integration.test.ts
git commit -m "feat(server): wire media archiving — subscribeAll trigger on render.done, restore before phase runs (phase 4 T4)"
```

---

### Task 5: files 路由 302 回退 + DELETE 清理 GCS

**Files:**
- Modify: `apps/server/src/api/app.ts`
- Modify: `apps/server/src/api/files-routes.ts`
- Modify: `apps/server/src/api/sessions-routes.ts`
- Test: `apps/server/test/api/files-routes.test.ts`(追加 describe)
- Test: `apps/server/test/api/sessions-routes.test.ts`(追加用例)

- [ ] **Step 1: Write the failing route tests**

`apps/server/test/api/files-routes.test.ts`:beforeEach 中构造 `SessionMediaArchive` 并放入 deps(import `SessionMediaArchive`、`InMemoryStorageGateway`;模块顶部加 `let storage: InMemoryStorageGateway;`):

```ts
  storage = new InMemoryStorageGateway();
  const media = new SessionMediaArchive({ storage, workspaces, sessions });
  deps = { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions, media };
```

文件末尾追加:

```ts
describe("GCS fallback", () => {
  it("302-redirects to a signed URL when the file is archived but not local", async () => {
    storage.objects.set(
      `users/u-test/sessions/${sessionId}/output/final.mp4`,
      Buffer.from("MP4"),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/final.mp4`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain(`users/u-test/sessions/${sessionId}/output/final.mp4`);
  });

  it("404s when the file exists neither locally nor in the bucket", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/output/nope.mp4`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("prefers the local file when present (no redirect)", async () => {
    writeFileSync(join(root, sessionId, "uploads/hi.txt"), "local");
    storage.objects.set(`users/u-test/sessions/${sessionId}/uploads/hi.txt`, Buffer.from("remote"));
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/uploads/hi.txt`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("local");
  });
});
```

注意:fakeAuthService 默认用户 id 是 `u-test`(TEST_USER),POST /api/sessions 创建的行 userId 即它,键前缀据此断言。

`apps/server/test/api/sessions-routes.test.ts`:在 DELETE 相关 describe 中追加(该文件的 deps 构造同样注入 media,与上面一致;若该文件 beforeEach 结构不同,按其现状最小化适配):

```ts
  it("DELETE clears the session's GCS prefix", async () => {
    const create = await app.inject({ method: "POST", url: "/api/sessions" });
    const sid = (create.json() as { sessionId: string }).sessionId;
    storage.objects.set(`users/u-test/sessions/${sid}/output/final.mp4`, Buffer.from("MP4"));
    storage.objects.set(`users/u-test/sessions/other/output/keep.mp4`, Buffer.from("KEEP"));
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sid}` });
    expect(res.statusCode).toBe(204);
    expect(storage.objects.has(`users/u-test/sessions/${sid}/output/final.mp4`)).toBe(false);
    expect(storage.objects.has(`users/u-test/sessions/other/output/keep.mp4`)).toBe(true);
  });
```

Run both files: Expected FAIL — AppDeps 没有 media 字段(TS)/ 路由不回退。

- [ ] **Step 2: Implement**

`apps/server/src/api/app.ts`:

```ts
import type { SessionMediaArchive } from "../storage/session-media-archive.js";
```

`AppDeps` 追加:

```ts
  /** Optional: GCS-backed media archive (files-route fallback + delete cleanup). */
  media?: SessionMediaArchive;
```

`apps/server/src/api/files-routes.ts` — 把现有的

```ts
      if (!existsSync(target)) {
        reply.code(404).send({ error: "file not found" });
        return;
      }
```

替换为:

```ts
      if (!existsSync(target)) {
        // Local miss → archived copy? 302 to a short-lived signed URL. The
        // browser follows the redirect for <video>/<audio>/<img>, and Range
        // requests work natively against GCS signed URLs (spec §5). When the
        // signature expires the player re-requests this route for a fresh one.
        const url = deps.media ? await deps.media.signedUrlFor(sid, relative) : null;
        if (url) {
          return reply.redirect(url, 302);
        }
        reply.code(404).send({ error: "file not found" });
        return;
      }
```

`apps/server/src/api/sessions-routes.ts` — DELETE handler 的 `await deps.eventLog.close(sid);` 之后、`await rm(...)` 之前插入:

```ts
      // GCS prefix first: the object keys embed userId, which dies with the
      // row below. Best-effort — a bucket outage must not block the delete
      // (orphaned objects can be swept manually; spec §8 keeps UX unblocked).
      if (deps.media) await deps.media.deleteRemote(sid).catch(() => undefined);
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/api/files-routes.test.ts apps/server/test/api/sessions-routes.test.ts`
Expected: PASS(含既有用例)

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm typecheck
git add apps/server/src/api/app.ts apps/server/src/api/files-routes.ts apps/server/src/api/sessions-routes.ts apps/server/test/api/files-routes.test.ts apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server): files-route signed-URL fallback + GCS prefix cleanup on delete (phase 4 T5)"
```

---

### Task 6: 端到端归档集成测试 + 全量回归

**Files:**
- Test: `apps/server/test/storage/archive-integration.test.ts`(新建)

- [ ] **Step 1: Write the integration test**

完整闭环:管线跑完 → 后台归档(本地删、桶有)→ files 路由 302 → refine 重跑前自动回拉。faux fixture 与 `pipeline-e2e.test.ts` 同款。

```ts
// apps/server/test/storage/archive-integration.test.ts
//
// Phase 4 acceptance (spec §1): "删掉本地 mp4 后前端仍能播放"。
// Drives the real composed graph with faux LLM + stub renderer, then asserts
// the full archive lifecycle: render.done → background upload+verify+local
// delete → files route 302 to a signed URL → refine pulls inputs back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { composeOrchestrator } from "../../src/compose-orchestrator.js";
import { createApp } from "../../src/api/app.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { StubTTSProvider } from "../../src/providers/stub-tts.js";
import { StubRenderWorkerClient } from "../../src/render/stub-render-worker.js";
import { PiAgentFactory } from "../../src/phases/pi-agent-factory.js";
import { PiComposePhaseHandler } from "../../src/phases/pi-compose-handler.js";
import type { QualityRunner } from "../../src/render/quality-runner.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { InMemoryStorageGateway } from "../helpers/in-memory-storage-gateway.js";
import { fakeAuthService, TEST_USER } from "../helpers/fake-auth.js";

const SID = "archive-e2e";
const PREFIX = `users/${TEST_USER.id}/sessions/${SID}/`;

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#FF3366"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#FF3366" }, { name: "bg", hex: "#101010" }],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", onScreenText: "Acme" },
    { id: "s2", startSec: 6, durationSec: 24, visual: "feature grid", onScreenText: "Fast" },
  ],
};
const VALID_HTML = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>.scene-content{width:100%;height:100%;display:flex}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="30" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="6" data-track-index="1"><h1 class="t1">Acme</h1></div>
  <div id="s2" class="clip" data-start="6" data-duration="24" data-track-index="1"><h1 class="t2">Fast</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
tl.from(".t2", { duration: 0.6, opacity: 0, y: 40 }, 6.1);
window.__timelines["main"] = tl;
</script></body></html>`;
const passRunner: QualityRunner = { check: async () => ({ ok: true, diagnostics: "" }) };

/**
 * One pipeline pass. The later refine re-runs only the render phase (stub
 * renderer — no LLM), so a single set of faux responses covers the whole test.
 */
function fauxPipelineResponses() {
  return [
    fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_design", designData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
  ];
}

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-archive-e2e-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

describe("archive lifecycle end to end", () => {
  it("archives after render.done, serves via 302, restores inputs for a re-run", async () => {
    faux.setResponses(fauxPipelineResponses());
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: SID, userId: TEST_USER.id });
    const gateway = new InMemoryStorageGateway();

    const composed = composeOrchestrator({
      baseDir: root,
      model: faux.getModel("uc-test")!,
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) }),
      tts: new StubTTSProvider(),
      renderWorkerClient: new StubRenderWorkerClient({ writeOutput: true }),
      composeHandlerOverride: new PiComposePhaseHandler({
        agentFactory: new PiAgentFactory({}),
        model: faux.getModel("uc-test")!,
        qualityRunner: passRunner,
      }),
      sessions,
      artifactRepo: new InMemoryArtifactRepository(),
      messageStore: new InMemoryMessageStore(),
      storageGateway: gateway,
    });
    const { orchestrator, workspaces } = composed;
    const eventLog = new SessionEventLog({ events: composed.events, store: new InMemoryEventStore(), batchMs: 0 });
    const app = await createApp({ ...composed, eventLog, auth: fakeAuthService(), sessions });

    try {
      // ---- 1. Drive the pipeline to done. ----
      await orchestrator.handleMessage(SID, {
        text: "Make a 30-second promo for https://acme.example",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      });
      // Simulated user upload + downloaded asset, present before render.done.
      writeFileSync(join(root, SID, "uploads/source.pdf"), "PDF");
      writeFileSync(join(root, SID, "assets/hero.png"), "PNG");
      await orchestrator.handleMessage(SID, { text: "approve" }); // design gate
      await orchestrator.handleMessage(SID, { text: "approve" }); // script gate
      expect(orchestrator.getState(SID)).toEqual({ kind: "done", lastPhase: "render" });

      // ---- 2. Background archive lands: bucket has the media, disk doesn't. ----
      await vi.waitFor(() => {
        const keys = [...gateway.objects.keys()];
        expect(keys.some((k) => /output\/.+\.mp4$/.test(k))).toBe(true);
        expect(keys).toContain(`${PREFIX}uploads/source.pdf`);
        expect(keys).toContain(`${PREFIX}assets/hero.png`);
      });
      const mp4Key = [...gateway.objects.keys()].find((k) => /output\/.+\.mp4$/.test(k))!;
      const mp4Rel = mp4Key.slice(PREFIX.length); // output/<uuid>.mp4
      await vi.waitFor(() => {
        expect(existsSync(join(root, SID, mp4Rel))).toBe(false);
        expect(existsSync(join(root, SID, "uploads/source.pdf"))).toBe(false);
        expect(existsSync(join(root, SID, "assets/hero.png"))).toBe(false);
      });
      // Composition code never leaves disk.
      expect(existsSync(join(root, SID, "composition/index.html"))).toBe(true);

      // ---- 3. Acceptance: local mp4 is gone, the files route still serves it. ----
      const res = await app.inject({ method: "GET", url: `/api/sessions/${SID}/files/${mp4Rel}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(mp4Key);

      // ---- 4. Re-run: refine at done re-renders; inputs are restored first. ----
      const before = readdirSync(join(root, SID, "output")).filter((f) => f.endsWith(".mp4"));
      await orchestrator.handleMessage(SID, { text: "make the pacing snappier" });
      expect(orchestrator.getState(SID)).toEqual({ kind: "done", lastPhase: "render" });
      // restoreMissing pulled the archived inputs back before the run.
      expect(existsSync(join(root, SID, "uploads/source.pdf"))).toBe(true);
      expect(existsSync(join(root, SID, "assets/hero.png"))).toBe(true);
      // A fresh mp4 was rendered (output/ is excluded from restore).
      const after = readdirSync(join(root, SID, "output")).filter((f) => f.endsWith(".mp4"));
      expect(after.length).toBeGreaterThan(before.length);
    } finally {
      await app.close();
      await eventLog.closeAll();
    }
  });
});
```

⚠️ 实现提示:
- refine at `done` 状态会从 `lastPhase`(render)重跑——只消耗 stub renderer,不消耗 faux 响应。
- 第 4 步 refine 之后归档会再次后台触发(第二个 render.done);测试在断言完后直接退出,SessionQueue 的尾部 swallow 保证不会未处理拒绝。若出现资源泄漏告警,在 finally 前加 `await vi.waitFor(() => expect([...gateway.objects.keys()].filter((k) => /output\/.+\.mp4$/.test(k)).length).toBeGreaterThanOrEqual(2))` 等归档完成再退出。
- `uploads/source.pdf` 必须在 render.done 之前写入(放在第一个 gate 等待时),否则赶不上第一轮归档。

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/storage/archive-integration.test.ts`
Expected: PASS。若 FAIL,按失败信息回到对应任务的实现修复(常见:gotcha 清单第 1、3 条)。

- [ ] **Step 3: Full regression + typecheck**

```bash
pnpm test
pnpm typecheck
```

Expected: 全部通过(本地 PG 在跑;pg suite 用 ultracreator_test)。如出现与本阶段无关的偶发(已知:end-to-end.test.ts 在高负载下 hook 超时),单独重跑该文件确认。

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/storage/archive-integration.test.ts
git commit -m "test(server): end-to-end archive lifecycle — render.done → GCS → 302 → restore (phase 4 T6)"
```

---

## 手工验收清单(用户执行,需真桶)

1. `apps/server/.env` 追加:
   - `GCS_BUCKET=YOUR_PRIVATE_BUCKET`
   - `GOOGLE_APPLICATION_CREDENTIALS=<绝对路径>/apps/server/secrets/gcp-service-account.json`(用绝对路径,避免 cwd 歧义)
2. 把 service account JSON 放到 `apps/server/secrets/gcp-service-account.json`(该目录已 gitignore;`git status` 确认不可见)。
3. 跑一个完整会话到渲染完成 → 服务器日志无 `[media-archive]` 失败;`gcloud storage ls gs://YOUR_PRIVATE_BUCKET/users/<uid>/sessions/<sid>/` 看到 mp4/上传件;本地 `workspaces/<sid>/output/` 里 mp4 已消失。
4. 前端会话页:视频照常播放(network 面板可见 302 → stor.googleapis.com 签名 URL,拖动进度条正常)。
5. 发一条 refine(改个文案重渲染):管线正常完成,新 mp4 可播。
6. 删除该会话:PG 行、本地 workspace、GCS 前缀三者皆空。
7. 不配 `GCS_BUCKET` 启动:日志出现 "media archiving disabled",一切行为与阶段③一致。

## Self-review 记录

- spec §5 全覆盖:对象键约定 ✓(T3)、render.done 后台归档+校验+清本地 ✓(T3/T4)、签名 URL 回源 ✓(T5)、拉回机制 ✓(T3/T4)、删除会话清前缀 ✓(T5)、凭证 gitignore ✓(T2)。
- spec §8 错误处理:上传失败留本地+退避 ✓、双 miss 404 ✓、签名过期由播放器重新请求 ✓(无需服务端动作,302 路径天然支持)。
- spec §9 测试策略:StorageGateway 接口+内存实现 ✓、路由 fake 登录态 ✓、专门集成测试 ✓。
- 类型一致性:`StorageGateway` 六个方法签名在 T1 定义、T2/T3 实现与调用一致;`MediaRestorer` 是 `SessionMediaArchive` 的结构子集 ✓。
- 占位符扫描:无 TBD/TODO;所有测试均含完整代码 ✓。
