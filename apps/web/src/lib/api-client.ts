// apps/web/src/lib/api-client.ts
import type {
  CheckoutResponse,
  CreateSessionResponse,
  CreditsResponse,
  GetSessionResponse,
  PublicVideoSummary,
  PublicVideoSort,
  SequencedEvent,
  SessionSummary,
  TypedArtifactEnvelope,
  UploadResponse,
} from "./api-types.js";
import type { ArtifactDescriptor, ArtifactKind, UserMessage } from "@ultracreator/shared";
import { apiBase } from "./api-base.js";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit, opts: { allow404?: boolean } = {}): Promise<T | null> {
  // credentials:'include' sends the session cookie even when apiBase() points
  // at a different origin (prod: api.<domain> vs the app's app.<domain>).
  // Harmless same-origin; callers may still override via init.
  const res = await fetch(url, { credentials: "include", ...init });
  if (opts.allow404 && res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${url} → ${res.status}`, body);
  }
  if (res.status === 204) return null;
  // Some 2xx endpoints reply with no body (e.g. /resume → 202 empty). Calling
  // res.json() on an empty body throws "Unexpected end of JSON input", so read
  // the text first and only parse when there is something to parse.
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : null);
}

export async function listSessions(): Promise<SessionSummary[]> {
  return (await jsonFetch<SessionSummary[]>(`${apiBase()}/api/sessions`)) ?? [];
}

export async function createSession(
  opts: { autoApprove: boolean; isPublic?: boolean; productUrl?: string } = { autoApprove: true },
): Promise<CreateSessionResponse> {
  const out = await jsonFetch<CreateSessionResponse>(`${apiBase()}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      autoApprove: opts.autoApprove,
      ...(opts.isPublic ? { isPublic: true } : {}),
      ...(opts.productUrl ? { productUrl: opts.productUrl } : {}),
    }),
  });
  if (!out) throw new ApiError(0, "createSession: empty response");
  return out;
}

export async function patchSession(sid: string, body: { autoApprove: boolean }): Promise<void> {
  await jsonFetch<null>(`${apiBase()}/api/sessions/${sid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getSession(sid: string): Promise<GetSessionResponse | null> {
  return jsonFetch<GetSessionResponse>(`${apiBase()}/api/sessions/${sid}`, undefined, { allow404: true });
}

export async function postMessage(sid: string, message: UserMessage): Promise<void> {
  try {
    await jsonFetch<{ accepted: true }>(`${apiBase()}/api/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (err) {
    // Content-moderation outcomes deserve human copy — the composers toast
    // whatever message this throws.
    if (err instanceof ApiError && err.status === 422) {
      throw new Error("This prompt appears to violate our content policy. Please rephrase and try again.");
    }
    if (err instanceof ApiError && err.status === 503) {
      throw new Error("Content moderation is temporarily unavailable. Please try again in a moment.");
    }
    throw err;
  }
}

export async function uploadFiles(sid: string, files: File[]): Promise<UploadResponse> {
  const fd = new FormData();
  for (const f of files) fd.append("file", f, f.name);
  const out = await jsonFetch<UploadResponse>(`${apiBase()}/api/sessions/${sid}/uploads`, {
    method: "POST",
    body: fd,
  });
  if (!out) throw new ApiError(0, "uploadFiles: empty response");
  return out;
}

export async function listArtifacts(sid: string): Promise<ArtifactDescriptor[]> {
  return (await jsonFetch<ArtifactDescriptor[]>(`${apiBase()}/api/sessions/${sid}/artifacts`)) ?? [];
}

/**
 * Curate the brief's source images (remove low-quality captures, add uploaded
 * shots). Writes a new brief version; 409 while a phase is running.
 */
export async function patchBriefAssets(
  sid: string,
  body: { add?: string[]; remove?: string[] },
): Promise<TypedArtifactEnvelope<"brief">> {
  const out = await jsonFetch<TypedArtifactEnvelope<"brief">>(
    `${apiBase()}/api/sessions/${sid}/brief/assets`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!out) throw new ApiError(0, "patchBriefAssets: empty response");
  return out;
}

export async function getArtifact<K extends ArtifactKind>(
  sid: string,
  kind: K,
  version?: number,
): Promise<TypedArtifactEnvelope<K> | null> {
  const qs = version !== undefined ? `?version=${version}` : "";
  return jsonFetch<TypedArtifactEnvelope<K>>(
    `${apiBase()}/api/sessions/${sid}/artifacts/${kind}${qs}`,
    undefined,
    { allow404: true },
  );
}

/**
 * Promote an older mp4 version back to "current" (the server copies it forward
 * as a new latest version). 404 unknown version; 409 while a run is in flight.
 */
export async function restoreMp4Version(
  sid: string,
  version: number,
): Promise<{ restored: boolean; version: number }> {
  const out = await jsonFetch<{ restored: boolean; version: number }>(
    `${apiBase()}/api/sessions/${sid}/artifacts/mp4/${version}/restore`,
    { method: "POST" },
  );
  if (!out) throw new ApiError(0, "restoreMp4Version: empty response");
  return out;
}

export async function deleteSession(sid: string): Promise<void> {
  await jsonFetch<null>(`${apiBase()}/api/sessions/${sid}`, { method: "DELETE" });
}

export function fileUrl(sid: string, relative: string): string {
  return `${apiBase()}/api/sessions/${sid}/files/${relative.replace(/^\//, "")}`;
}

// ---- Billing / credits ----------------------------------------------------

export async function getCredits(): Promise<CreditsResponse> {
  return (
    (await jsonFetch<CreditsResponse>(`${apiBase()}/api/credits`)) ?? {
      balance: 0,
      breakdown: { subscription: 0, bonus: 0, purchased: 0 },
      subscription: null,
      freePublicAvailable: false,
    }
  );
}

export type CheckoutIntent =
  | { kind: "credits"; usd: number }
  | { kind: "subscription"; tier: "pro" | "max" | "ultra"; interval: "monthly" | "yearly" };

/**
 * Start a purchase. Real billing returns a Creem checkout URL to redirect to;
 * the BILLING_STUBS dev fallback applies the effects directly and returns the
 * new balance with url:null.
 */
export async function createCheckout(intent: CheckoutIntent): Promise<CheckoutResponse> {
  const out = await jsonFetch<CheckoutResponse>(`${apiBase()}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intent),
  });
  if (!out) throw new ApiError(0, "createCheckout: empty response");
  return out;
}

/** Creem customer portal (manage/cancel the subscription). 404 → no portal. */
export async function createPortalSession(): Promise<{ url: string }> {
  const out = await jsonFetch<{ url: string }>(`${apiBase()}/api/billing/portal`, { method: "POST" });
  if (!out) throw new ApiError(0, "createPortalSession: empty response");
  return out;
}

/** Resume a session parked in awaiting-credits (the in-chat "Continue" button). */
export async function resumeSession(sid: string): Promise<void> {
  await jsonFetch<null>(`${apiBase()}/api/sessions/${sid}/resume`, { method: "POST" });
}

// ---- Product Plaza / public videos ---------------------------------------

export async function listPublicVideos(sort: PublicVideoSort = "recent"): Promise<PublicVideoSummary[]> {
  return (await jsonFetch<PublicVideoSummary[]>(`${apiBase()}/api/public/videos?sort=${sort}`)) ?? [];
}

export async function getPublicVideo(sid: string): Promise<PublicVideoSummary | null> {
  return jsonFetch<PublicVideoSummary>(`${apiBase()}/api/public/videos/${sid}`, undefined, { allow404: true });
}

export async function likeVideo(sid: string): Promise<{ likeCount: number; liked: boolean }> {
  const out = await jsonFetch<{ likeCount: number; liked: boolean }>(
    `${apiBase()}/api/public/videos/${sid}/like`,
    { method: "POST" },
  );
  if (!out) throw new ApiError(0, "likeVideo: empty response");
  return out;
}

export async function unlikeVideo(sid: string): Promise<{ likeCount: number; liked: boolean }> {
  const out = await jsonFetch<{ likeCount: number; liked: boolean }>(
    `${apiBase()}/api/public/videos/${sid}/like`,
    { method: "DELETE" },
  );
  if (!out) throw new ApiError(0, "unlikeVideo: empty response");
  return out;
}

/** Playback URL for a public video (unguarded streaming endpoint). */
export function publicVideoUrl(sid: string): string {
  return `${apiBase()}/api/public/videos/${sid}/video`;
}

export type { SequencedEvent };
