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
    // V4 signing is local RSA with a key file (GOOGLE_APPLICATION_CREDENTIALS,
    // our deployment). Under keyless ADC it becomes a network call to the IAM
    // signBlob API per request — revisit before moving off key-file creds.
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

  /**
   * Rejection may leave a partially deleted prefix (the library deletes with
   * concurrency 10 and aborts on the first error) — safe to retry, since
   * survivors are re-listed on the next attempt.
   */
  async deletePrefix(prefix: string): Promise<void> {
    await this.bucket.deleteFiles({ prefix });
  }
}
