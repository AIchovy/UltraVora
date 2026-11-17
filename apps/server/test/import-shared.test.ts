import { describe, it, expect } from "vitest";
import { BriefSchema } from "@ultracreator/shared";

describe("server imports shared", () => {
  it("resolves the workspace package", () => {
    expect(BriefSchema).toBeDefined();
  });
});
