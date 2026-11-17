// apps/web/test/helpers/api-mocks.ts
import { vi } from "vitest";

export function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}
