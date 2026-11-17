import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  gw = new GcsStorageGateway({ bucketName: "ultra-creator-prod", storage: f.storage });
});

describe("GcsStorageGateway", () => {
  it("binds the configured bucket", () => {
    expect((f.storage.bucket as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("ultra-creator-prod");
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

  it("download creates parent directories and passes the destination path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "uc-gcs-gw-"));
    try {
      const dest = join(tmp, "deep/nested/out.bin");
      await gw.download("k", dest);
      expect(statSync(dirname(dest)).isDirectory()).toBe(true); // mkdir -p actually ran
      expect(f.file.download).toHaveBeenCalledWith({ destination: dest });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("signedUrl requests a v4 read URL with a future expiry", async () => {
    const before = Date.now();
    const url = await gw.signedUrl("k", 15 * 60 * 1000);
    expect(url).toBe("https://signed.example/x");
    const arg = (f.file.getSignedUrl.mock.calls[0] as unknown[])[0] as {
      version: string;
      action: string;
      expires: number;
    };
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
