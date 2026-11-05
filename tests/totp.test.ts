import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpConfig,
  totpNow,
  verifyTotp,
} from "@/lib/auth/totp";

/**
 * RFC 6238 conformance.
 *
 * The reference secret is the ASCII string "12345678901234567890", whose
 * base32 form is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. The RFC publishes 8-digit
 * values; this implementation truncates to 6, so the expected codes below are
 * the last six digits of each published vector.
 */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"], // RFC 8-digit: 94287082
  [1111111109, "081804"], // 07081804
  [1111111111, "050471"], // 14050471
  [1234567890, "005924"], // 89005924
  [2000000000, "279037"], // RFC 8-digit 69279037
];

describe("RFC 6238 vectors (SHA-1, 30s step, 6 digits)", () => {
  it.each(RFC_VECTORS)("generates %s at T=%d", (seconds, expected) => {
    expect(totpNow(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  it.each(RFC_VECTORS)("accepts the published code at T=%d", (seconds, code) => {
    const result = verifyTotp(RFC_SECRET, code, seconds * 1000);
    expect(result.valid).toBe(true);
    expect(result.step).toBe(Math.floor(seconds / 30));
  });
});

describe("verification window", () => {
  const at = 1234567890 * 1000;
  const current = totpNow(RFC_SECRET, at);
  const previous = totpNow(RFC_SECRET, at - 30_000);
  const next = totpNow(RFC_SECRET, at + 30_000);

  it("accepts the neighbouring step to absorb clock skew", () => {
    expect(verifyTotp(RFC_SECRET, previous, at).valid).toBe(true);
    expect(verifyTotp(RFC_SECRET, next, at).valid).toBe(true);
  });

  it("rejects a code two steps away", () => {
    const far = totpNow(RFC_SECRET, at - 90_000);
    expect(verifyTotp(RFC_SECRET, far, at).valid).toBe(false);
  });

  it("rejects malformed input without doing any crypto", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 56x", "0000000"]) {
      expect(verifyTotp(RFC_SECRET, bad, at).valid).toBe(false);
    }
  });

  it("tolerates whitespace and grouping in a typed code", () => {
    expect(verifyTotp(RFC_SECRET, current.replace(/(\d{3})(\d{3})/, "$1 $2"), at).valid).toBe(true);
  });
});

describe("base32 codec", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0xfe]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("ignores padding and case", () => {
    expect(base32Decode("gezdgnbvgy3tqojqgezdgnbvgy3tqojq")).toEqual(base32Decode(RFC_SECRET));
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base32Decode("0189")).toThrow();
  });
});

describe("secret generation and enrolment URI", () => {
  it("produces unique base32 secrets of the expected length", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      seen.add(secret);
    }
    expect(seen.size).toBe(200);
  });

  it("builds an otpauth URI carrying the issuer, algorithm, digits and period", () => {
    const uri = otpauthUri({ secretBase32: RFC_SECRET, account: "admin@example.com" });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("secret")).toBe(RFC_SECRET);
    expect(parsed.searchParams.get("issuer")).toBe("ReplyMate Control");
    expect(parsed.searchParams.get("algorithm")).toBe("SHA1");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(decodeURIComponent(parsed.pathname)).toContain("admin@example.com");
  });

  it("publishes its configuration so the UI can state it accurately", () => {
    expect(totpConfig).toEqual({ period: 30, digits: 6, algorithm: "sha1", windowSteps: 1 });
  });
});
