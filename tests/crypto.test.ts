/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import { decryptText, encryptText, hmacHex, redactSecrets, timingSafeEqual } from "../worker/src/platform/crypto";

describe("crypto helpers", () => {
  it("encrypts and decrypts token text", async () => {
    const encrypted = await encryptText("ghp_supersecret123456", "test-secret");

    expect(encrypted).toMatch(/\./);
    await expect(decryptText(encrypted, "test-secret")).resolves.toBe("ghp_supersecret123456");
  });

  it("verifies hmac signatures without plain equality", async () => {
    const signature = await hmacHex("secret", "body");

    expect(timingSafeEqual(signature, signature)).toBe(true);
    expect(timingSafeEqual(signature, `${signature.slice(0, -1)}0`)).toBe(false);
  });

  it("redacts provider tokens from logs", () => {
    const redacted = redactSecrets(
      "Bearer abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnop",
    );

    expect(redacted).toContain("Bearer redacted");
    expect(redacted).toContain("gh-redacted");
    expect(redacted).toContain("sk-redacted");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});
