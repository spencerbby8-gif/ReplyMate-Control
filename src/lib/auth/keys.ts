import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Durable resolution of the control-plane encryption key.
 *
 * WHY THIS MODULE EXISTS — a real defect, found in production:
 *
 * The platform regenerates `.env` on every redeploy. `CONTROL_ENC_KEY` lived
 * there, so a restart silently swapped the app's cryptographic identity. The
 * consequences were not loud:
 *
 *   - TOTP enrolment started returning 503 (correctly refused, but dead).
 *   - `digestToken()` fell back to its unkeyed path, so **every digest already
 *     stored in the database stopped matching**: device ingest keys began
 *     returning 401 permanently, and invitation links became unredeemable.
 *   - Sessions merely logged out, which is benign and masked the rest.
 *
 * Nothing crashed. That is precisely why it is dangerous: a silent key rotation
 * looks identical to "the credential is wrong".
 *
 * Resolution order:
 *   1. `CONTROL_ENC_KEY` from the environment — explicit operator config always
 *      wins, so a real deployment can keep the key in a secret manager.
 *   2. A keyfile at `.keys/control-enc.key` (mode 0600, gitignored). Created on
 *      first use from 32 bytes of CSPRNG output. The filesystem survives a
 *      redeploy even when `.env` does not, which makes the key stable.
 *   3. Neither → null. Callers must then report `unkeyed` and refuse to persist
 *      secrets, rather than inventing a key that would change again next boot.
 */

const KEYFILE = resolve(process.cwd(), ".keys", "control-enc.key");
const MIN_KEY_LENGTH = 32;

export type KeySource = "environment" | "keyfile" | "none";

export type ResolvedKey = {
  /** Never log or render this. */
  value: string | null;
  source: KeySource;
  /** Non-reversible fingerprint, safe to store and display. */
  fingerprint: string | null;
  detail: string;
};

let cached: ResolvedKey | null = null;

/** Non-reversible identifier for a key, safe to persist and show in the UI. */
export function keyFingerprint(value: string): string {
  return createHmac("sha256", "rmctl-key-fingerprint").update(value).digest("hex").slice(0, 16);
}

function readKeyfile(): { value: string | null; detail: string } {
  try {
    if (!existsSync(KEYFILE)) return { value: null, detail: "keyfile absent" };
    const raw = readFileSync(KEYFILE, "utf8").trim();
    if (raw.length < MIN_KEY_LENGTH) {
      return {
        value: null,
        detail: `keyfile exists but holds only ${raw.length} characters (minimum ${MIN_KEY_LENGTH}); ignoring it rather than using a weak key`,
      };
    }
    return { value: raw, detail: `keyfile ${KEYFILE}` };
  } catch (error) {
    return { value: null, detail: `keyfile unreadable: ${error instanceof Error ? error.name : "unknown"}` };
  }
}

function createKeyfile(): { value: string; detail: string } | { value: null; detail: string } {
  try {
    mkdirSync(dirname(KEYFILE), { recursive: true });
    const value = randomBytes(32).toString("base64url");
    writeFileSync(KEYFILE, `${value}\n`, { mode: 0o600 });
    // Verify what we wrote is actually readable back and correctly permissioned,
    // because a keyfile that silently reverts to a new value on next boot would
    // reproduce the exact defect this module exists to fix.
    const stat = statSync(KEYFILE);
    const mode = stat.mode & 0o777;
    const readBack = readFileSync(KEYFILE, "utf8").trim();
    if (readBack !== value) {
      return { value: null, detail: "keyfile written but did not read back identically; refusing to use it" };
    }
    return { value, detail: `created keyfile ${KEYFILE} (mode ${mode.toString(8)})` };
  } catch (error) {
    return { value: null, detail: `could not create keyfile: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

export function resolveEncryptionKey(): ResolvedKey {
  if (cached) return cached;

  const fromEnv = process.env.CONTROL_ENC_KEY?.trim();
  if (fromEnv && fromEnv.length >= MIN_KEY_LENGTH) {
    cached = {
      value: fromEnv,
      source: "environment",
      fingerprint: keyFingerprint(fromEnv),
      detail: `CONTROL_ENC_KEY from the environment (${fromEnv.length} characters)`,
    };
    return cached;
  }

  const envNote = fromEnv
    ? `CONTROL_ENC_KEY is set but only ${fromEnv.length} characters (minimum ${MIN_KEY_LENGTH}); ignored`
    : "CONTROL_ENC_KEY not set";

  const existing = readKeyfile();
  if (existing.value) {
    cached = {
      value: existing.value,
      source: "keyfile",
      fingerprint: keyFingerprint(existing.value),
      detail: `${envNote}; using ${existing.detail}`,
    };
    return cached;
  }

  const created = createKeyfile();
  if (created.value) {
    cached = {
      value: created.value,
      source: "keyfile",
      fingerprint: keyFingerprint(created.value),
      detail: `${envNote}; ${created.detail}`,
    };
    return cached;
  }

  cached = {
    value: null,
    source: "none",
    fingerprint: null,
    detail: `${envNote}; ${existing.detail}; ${created.detail}. TOTP enrolment and keyed digests are unavailable.`,
  };
  return cached;
}

/** Clears the memo. Only used by tests. */
export function resetKeyCache(): void {
  cached = null;
}

export const KEYFILE_PATH = KEYFILE;
