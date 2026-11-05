import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP — implemented directly on node:crypto, no third-party
 * dependency. Compatible with Google Authenticator, 1Password, Authy, Aegis.
 *
 * Used for admin MFA. Supabase Auth TOTP is used instead when
 * AUTH_PROVIDER=supabase (see lib/auth/supabase.ts).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ALGORITHM = "sha1";

export function generateTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  return base32Encode(raw);
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(ALGORITHM, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpNow(secretBase32: string, at = Date.now()): string {
  return hotp(secretBase32, Math.floor(at / 1000 / PERIOD_SECONDS));
}

/**
 * Verifies a user-supplied code with a +/-1 step window to absorb clock skew.
 * Returns the matched step so callers can enforce single-use replay protection.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at = Date.now(),
  window = 1,
): { valid: boolean; step: number | null } {
  const clean = code.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(clean)) return { valid: false, step: null };

  const currentStep = Math.floor(at / 1000 / PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    const expected = Buffer.from(hotp(secretBase32, step));
    const provided = Buffer.from(clean);
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { valid: true, step };
    }
  }
  return { valid: false, step: null };
}

/** otpauth:// URI for QR enrolment. The label must never contain a secret. */
export function otpauthUri(opts: {
  secretBase32: string;
  account: string;
  issuer?: string;
}): string {
  const issuer = opts.issuer ?? "ReplyMate Control";
  const label = `${issuer}:${opts.account}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export const totpConfig = {
  period: PERIOD_SECONDS,
  digits: DIGITS,
  algorithm: ALGORITHM,
  windowSteps: 1,
} as const;
