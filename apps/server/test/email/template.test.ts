import { describe, it, expect } from "vitest";
import { renderVerificationEmail, loadVerificationTemplate } from "../../src/email/template.js";

const template = `<p>Code: {{VERIFICATION_CODE}}</p><p>Expires in {{EXPIRES_IN}}.</p>`;

describe("renderVerificationEmail", () => {
  it("replaces both placeholders", () => {
    const html = renderVerificationEmail({ code: "123456", expiresInMinutes: 15, template });
    expect(html).toContain("123456");
    expect(html).toContain("15 minutes");
    expect(html).not.toContain("{{");
  });
  it("singularizes a 1-minute expiry", () => {
    expect(renderVerificationEmail({ code: "000000", expiresInMinutes: 1, template })).toContain("1 minute.");
  });
  it("throws if any mustache placeholder is left unreplaced", () => {
    expect(() =>
      renderVerificationEmail({ code: "1", expiresInMinutes: 5, template: "{{VERIFICATION_CODE}} {{UNKNOWN}}" }),
    ).toThrow(/UNKNOWN/);
  });
});

describe("loadVerificationTemplate", () => {
  it("reads the real UltraVora template from the repo", () => {
    const html = loadVerificationTemplate();
    expect(html).toContain("{{VERIFICATION_CODE}}");
    expect(html).toContain("UltraVora");
  });
  it("throws when the directory has no template", () => {
    expect(() => loadVerificationTemplate("/no/such/dir")).toThrow();
  });
});
