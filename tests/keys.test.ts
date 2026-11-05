import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYFILE_PATH, keyFingerprint, resetKeyCache, resolveEncryptionKey } from "@/lib/auth/keys";
import { digestKeyStrength, digestToken, encryptionKeyStatus, generateToken } from "@/lib/auth/crypto";

/**
 * Durable encryption-key resolution.
 *
 * Regression target: `CONTROL_ENC_KEY` lived only in `.env`, which the hosting
 * platform regenerates on redeploy. The key therefore rotated silently and every
 * stored token digest stopped matching — device ingest keys began returning 401
 * permanently, indistinguishable from a wrong credential. Nothing crashed, which
 * is what made it dangerous.
 */

const ENV_KEY = "vitest-durable-key-value-that-is-long-enough-0000";
const original = process.env.CONTROL_ENC_KEY;

beforeEach(() => {
  process.env.CONTROL_ENC_KEY = ENV_KEY;
  resetKeyCache();
});

afterEach(() => {
  if (original === undefined) delete process.env.CONTROL_ENC_KEY;
  else process.env.CONTROL_ENC_KEY = original;
  resetKeyCache();
});

describe("an explicit environment key always wins", () => {
  it("resolves from the environment when it is long enough", () => {
    const resolved = resolveEncryptionKey();
    expect(resolved.source).toBe("environment");
    expect(resolved.value).toBe(ENV_KEY);
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("ignores an environment key that is too short rather than using a weak one", () => {
    process.env.CONTROL_ENC_KEY = "short";
    resetKeyCache();
    const resolved = resolveEncryptionKey();
    expect(resolved.source).not.toBe("environment");
    expect(resolved.detail).toMatch(/only 5 characters/);
  });

  it("treats a whitespace-padded key as trimmed", () => {
    process.env.CONTROL_ENC_KEY = `  ${ENV_KEY}  `;
    resetKeyCache();
    expect(resolveEncryptionKey().value).toBe(ENV_KEY);
  });
});

describe("the keyfile is the durable fallback", () => {
  it("is created on first use when the environment has no key", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    const resolved = resolveEncryptionKey();
    expect(resolved.source).toBe("keyfile");
    expect(resolved.value).not.toBeNull();
    expect(resolved.value!.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(KEYFILE_PATH)).toBe(true);
  });

  it("writes the keyfile with 0600 permissions", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    resolveEncryptionKey();
    const mode = statSync(KEYFILE_PATH).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("returns the SAME key across resolutions, which is the whole point", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    const first = resolveEncryptionKey();
    // Simulate a redeploy: the module cache is cold again, but the keyfile is
    // still on disk, so the key must be identical.
    resetKeyCache();
    const second = resolveEncryptionKey();
    expect(second.value).toBe(first.value);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("survives an environment change, unlike a key stored only in .env", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    const fromFile = resolveEncryptionKey().value;
    // The platform regenerates .env; with no CONTROL_ENC_KEY in it we still get
    // the same key from disk.
    resetKeyCache();
    process.env.CONTROL_ENC_KEY = "";
    resetKeyCache();
    expect(resolveEncryptionKey().value).toBe(fromFile);
  });

  it("reads back what it wrote, so a silently-reverting file is refused", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    const resolved = resolveEncryptionKey();
    expect(readFileSync(KEYFILE_PATH, "utf8").trim()).toBe(resolved.value);
  });
});

describe("fingerprints identify a key without revealing it", () => {
  it("is deterministic", () => {
    expect(keyFingerprint(ENV_KEY)).toBe(keyFingerprint(ENV_KEY));
  });

  it("differs for different keys", () => {
    expect(keyFingerprint(ENV_KEY)).not.toBe(keyFingerprint(`${ENV_KEY}-other`));
  });

  it("is 16 hex characters and contains no part of the key", () => {
    const fingerprint = keyFingerprint(ENV_KEY);
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).not.toContain(ENV_KEY.slice(0, 8));
    expect(ENV_KEY).not.toContain(fingerprint);
  });

  it("is not reversible by trying the key itself as a digest", () => {
    expect(keyFingerprint(ENV_KEY)).not.toBe(ENV_KEY);
  });
});

describe("crypto reports its key state truthfully", () => {
  it("reports keyed strength when a key resolves", () => {
    expect(digestKeyStrength()).toBe("keyed");
    expect(encryptionKeyStatus().available).toBe(true);
    expect(encryptionKeyStatus().source).toBe("environment");
  });

  it("reports the keyfile source when the environment has none", () => {
    delete process.env.CONTROL_ENC_KEY;
    resetKeyCache();
    expect(encryptionKeyStatus().source).toBe("keyfile");
    expect(digestKeyStrength()).toBe("keyed");
  });

  it("keeps token digests stable across a cold cache", () => {
    const token = generateToken();
    const before = digestToken(token);
    resetKeyCache();
    expect(digestToken(token)).toBe(before);
  });

  it("produces a DIFFERENT digest when the key changes — the failure mode made explicit", () => {
    const token = generateToken();
    const underEnvKey = digestToken(token);
    process.env.CONTROL_ENC_KEY = "a-completely-different-key-value-that-is-long";
    resetKeyCache();
    expect(digestToken(token)).not.toBe(underEnvKey);
  });
});
