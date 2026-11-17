import { describe, it, expect } from "vitest";
import { PUBLIC_VIDEO_SORTS, isPublicVideoSort } from "../src/public-video.js";

describe("public-video", () => {
  it("lists the two sort orders", () => {
    expect(PUBLIC_VIDEO_SORTS).toEqual(["recent", "likes"]);
  });

  it("validates sort strings", () => {
    expect(isPublicVideoSort("recent")).toBe(true);
    expect(isPublicVideoSort("likes")).toBe(true);
    expect(isPublicVideoSort("nope")).toBe(false);
    expect(isPublicVideoSort(undefined)).toBe(false);
  });
});
