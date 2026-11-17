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
   * Implementations must derive Content-Type from the filename (GCS
   * bucket.upload auto-detects) so signed-URL playback gets correct headers.
   */
  upload(localPath: string, key: string): Promise<{ size: number }>;
  exists(key: string): Promise<boolean>;
  /** Download to localPath, creating parent directories as needed. */
  download(key: string, localPath: string): Promise<void>;
  /**
   * Time-limited read URL (GCS: V4 signed URL). Callers MUST check exists()
   * first: V4 signing is local cryptography, so production implementations
   * sign URLs for nonexistent objects without error. The in-memory fake
   * throws for missing keys to catch precondition violations in tests.
   */
  signedUrl(key: string, ttlMs: number): Promise<string>;
  /** Every object key under the prefix, ascending lexicographic (GCS native order). */
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<void>;
}
