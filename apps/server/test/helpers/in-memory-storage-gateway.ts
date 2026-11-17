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
