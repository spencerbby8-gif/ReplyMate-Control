import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { resolveEncryptionKey, type KeySource } from "./keys";

/**
 * Crypto primitives for the control plane.
 *
 * - Passwords: scrypt (N=16384, r=8, p=1), 32-byte random salt, 64-byte key.
 * - Tokens: 256-bit CSPRNG, stored ONLY as SHA-256 digests.
 * - TOTP secrets: AES-256-GCM under a key derived from CONTROL_ENC_KEY.
 *
 * Nothing here ever logs a plaintext credential.
 */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(32);
  const derived = await scryptAsync(plain, salt, SCRYPT_PARAMS.keylen);
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scryptAsync(plain, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function scryptAsync(
  secret: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number } = {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Opaque single-use token. Caller stores only `digestToken(token)`. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Keyed digest used for session and invitation tokens.
 *
 * This replaced an HMAC with a pepper that was hardcoded in source, which added
 * nothing: anyone who could read the repository could read the pepper. The
 * digest is now keyed from `CONTROL_ENC_KEY`, so a database leak alone does not
 * let an attacker build a lookup table against stolen digests.
 *
 * When `CONTROL_ENC_KEY` is absent it degrades to plain SHA-256 and says so via
 * `digestKeyStrength()`. Tokens are still 256-bit CSPRNG output, so this is a
 * loss of defence-in-depth, not of correctness — but the UI reports it instead
 * of implying protection that is not there.
 */
/**
 * A fixed, clearly-labelled fallback. It exists so the app still functions with
 * no key at all, but `digestKeyStrength()` reports `unkeyed` and the login page
 * displays it: a deployment in this state has lost the ability to match any
 * digest minted under a real key, and that must be visible.
 */
const FALLBACK_DIGEST_KEY = "rmctl-digest-unkeyed-fallback";

function digestKey(): Buffer {
  const resolved = resolveEncryptionKey();
  return Buffer.from(resolved.value ?? FALLBACK_DIGEST_KEY);
}

export function digestToken(value: string): string {
  return createHmac("sha256", digestKey()).update(value).digest("hex");
}

export function digestKeyStrength(): "keyed" | "unkeyed" {
  return resolveEncryptionKey().value !== null ? "keyed" : "unkeyed";
}

export function newId(): string {
  return randomUUID();
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Authenticated encryption for the TOTP shared secret
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer | null {
  const resolved = resolveEncryptionKey();
  if (!resolved.value) return null;
  return createHmac("sha256", "rmctl-aead-key").update(resolved.value).digest();
}

export function encryptionAvailable(): boolean {
  return encryptionKey() !== null;
}

/** Where the active key came from, for the UI. Never returns the key itself. */
export function encryptionKeyStatus(): {
  available: boolean;
  source: KeySource;
  fingerprint: string | null;
  detail: string;
} {
  const resolved = resolveEncryptionKey();
  return {
    available: resolved.value !== null,
    source: resolved.source,
    fingerprint: resolved.fingerprint,
    detail: resolved.detail,
  };
}

export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      "CONTROL_ENC_KEY is not configured (min 32 chars). Refusing to persist a TOTP secret in plaintext.",
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("CONTROL_ENC_KEY is not configured.");
  const [version, ivB64, tagB64, ctB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Masks a value for logs/audit. Names the withheld thing; never carries it. */
export function maskSecret(label: string): string {
  return `${label}:[redacted]`;
}
