import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  encryptionAvailable,
  generateToken,
  hashPassword,
  maskSecret,
  safeEqual,
  sha256Hex,
  verifyPassword,
} from "@/lib/auth/crypto";

describe("password hashing (scrypt)", () => {
  const password = "correct-horse-battery-staple";

  it("verifies the right password and rejects the wrong one", async () => {
    const encoded = await hashPassword(password);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword(`${password}x`, encoded)).toBe(false);
    expect(await verifyPassword("", encoded)).toBe(false);
  }, 20_000);

  it("produces a different encoding for the same password (random salt)", async () => {
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
    expect(await verifyPassword(password, b)).toBe(true);
  }, 20_000);

  it("never stores the plaintext in the encoded form", async () => {
    const encoded = await hashPassword(password);
    expect(encoded).not.toContain(password);
    expect(encoded.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(encoded.split("$")).toHaveLength(6);
  }, 20_000);

  it("rejects malformed encodings instead of throwing", async () => {
    expect(await verifyPassword(password, "not-a-hash")).toBe(false);
    expect(await verifyPassword(password, "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifyPassword(password, "")).toBe(false);
  });

  it("is case- and whitespace-sensitive", async () => {
    const encoded = await hashPassword("P@ssw0rd-with-length");
    expect(await verifyPassword("p@ssw0rd-with-length", encoded)).toBe(false);
    expect(await verifyPassword(" P@ssw0rd-with-length", encoded)).toBe(false);
  }, 20_000);
});

describe("token generation", () => {
  it("produces unique URL-safe 256-bit tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const token = generateToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(500);
  });

  it("digests deterministically so a stored hash can be looked up", () => {
    const token = generateToken();
    expect(sha256Hex(token)).toBe(sha256Hex(token));
    expect(sha256Hex(token)).not.toBe(sha256Hex(generateToken()));
    expect(sha256Hex(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not leak the token through its digest", () => {
    const token = generateToken();
    expect(sha256Hex(token)).not.toContain(token);
  });
});

describe("authenticated encryption of the TOTP secret", () => {
  it("is available when CONTROL_ENC_KEY is set", () => {
    expect(encryptionAvailable()).toBe(true);
  });

  it("round-trips a base32 secret", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const payload = encryptSecret(secret);
    expect(payload).not.toContain(secret);
    expect(payload.startsWith("v1:")).toBe(true);
    expect(decryptSecret(payload)).toBe(secret);
  });

  it("uses a fresh IV per encryption", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("detects tampering with the ciphertext", () => {
    const payload = encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const parts = payload.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("detects tampering with the auth tag", () => {
    const payload = encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const parts = payload.split(":");
    parts[2] = Buffer.alloc(16).toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("garbage")).toThrow();
    expect(() => decryptSecret("v2:aaa:bbb:ccc")).toThrow();
  });
});

describe("comparison and masking helpers", () => {
  it("compares equal-length strings in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("masks a label without ever emitting the value itself", () => {
    // maskSecret takes a LABEL, not a secret: it exists so a log line can name
    // the thing that was withheld without carrying it.
    expect(maskSecret("gemini_api_key")).toBe("gemini_api_key:[redacted]");
    expect(maskSecret("totp_secret")).toBe("totp_secret:[redacted]");
    expect(maskSecret("gemini_api_key")).toContain("[redacted]");
  });
});
