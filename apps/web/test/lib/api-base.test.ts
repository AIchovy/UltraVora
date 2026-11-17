import { describe, it, expect, afterEach } from "vitest";
import { apiBase } from "@/lib/api-base";

const ORIGINAL = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = ORIGINAL;
});

describe("apiBase", () => {
  it("returns '' when NEXT_PUBLIC_API_URL is unset (same-origin via Next rewrites)", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(apiBase()).toBe("");
  });

  it("returns '' when NEXT_PUBLIC_API_URL is the empty string", () => {
    process.env.NEXT_PUBLIC_API_URL = "";
    expect(apiBase()).toBe("");
  });

  it("strips the trailing slash from an explicit override", () => {
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001/";
    expect(apiBase()).toBe("http://127.0.0.1:3001");
  });
});
