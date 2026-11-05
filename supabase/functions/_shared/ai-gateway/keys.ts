/**
 * Master-key selection and rotation.
 *
 * Keys live ONLY in Edge Function secrets (`Deno.env.get`). They are never
 * stored in a database table, never returned to a client, and never logged.
 *
 * Rotation model: a provider may have a current key and an optional successor.
 * During rotation both are accepted for reads, writes go to the successor, and a
 * key that fails with an auth error is marked bad so the next call skips it.
 * This lets an operator rotate without downtime and without a flag day.
 */

export type KeySlot = "primary" | "next";

export type ResolvedKey = {
  providerKey: string;
  slot: KeySlot;
  /** The secret NAME, never the value — safe to log and to return in diagnostics. */
  secretName: string;
};

const SUFFIX: Record<KeySlot, string> = { primary: "", next: "_NEXT" };

/**
 * Names of the secrets a provider may use.
 *
 * Exported so an operator can see exactly which variables to set, and so the
 * deployment checklist can be generated rather than remembered.
 */
export function secretNamesFor(providerKey: string): Record<KeySlot, string> {
  const base = `${providerKey.toUpperCase()}_MASTER_KEY`;
  return { primary: base, next: `${base}${SUFFIX.next}` };
}

export function requiredSecretNames(providerKeys: string[]): string[] {
  return providerKeys.flatMap((key) => {
    const names = secretNamesFor(key);
    return [names.primary];
  });
}

export type KeyResolver = {
  /** Which secret names hold a non-empty value. */
  available: (providerKey: string) => boolean;
  /** Chooses the slot to use, preferring `next` during a rotation window. */
  resolve: (providerKey: string) => ResolvedKey | null;
  /** Reports configuration state without ever exposing a value. */
  report: () => Array<{ providerKey: string; primary: boolean; next: boolean }>;
};

export function createKeyResolver(options: {
  providerKeys: string[];
  readSecret: (name: string) => string | undefined;
  /** Providers currently mid-rotation: prefer the `next` slot for these. */
  rotating?: string[];
  /** Provider keys known to be failing auth right now. */
  knownBad?: Array<{ providerKey: string; slot: KeySlot }>;
}): KeyResolver {
  const rotating = new Set(options.rotating ?? []);
  const bad = new Set((options.knownBad ?? []).map((entry) => `${entry.providerKey}:${entry.slot}`));

  const valueFor = (providerKey: string, slot: KeySlot): string | undefined => {
    const name = secretNamesFor(providerKey)[slot];
    const value = options.readSecret(name);
    return value && value.trim().length > 0 ? value : undefined;
  };

  return {
    available: (providerKey) =>
      Boolean(valueFor(providerKey, "primary")) || Boolean(valueFor(providerKey, "next")),

    resolve: (providerKey) => {
      const order: KeySlot[] = rotating.has(providerKey) ? ["next", "primary"] : ["primary", "next"];
      for (const slot of order) {
        if (bad.has(`${providerKey}:${slot}`)) continue;
        if (valueFor(providerKey, slot)) {
          return { providerKey, slot, secretName: secretNamesFor(providerKey)[slot] };
        }
      }
      return null;
    },

    report: () =>
      options.providerKeys.map((providerKey) => ({
        providerKey,
        primary: Boolean(valueFor(providerKey, "primary")),
        next: Boolean(valueFor(providerKey, "next")),
      })),
  };
}

/**
 * Reads the actual key value for a resolved slot.
 *
 * Kept separate from `resolve()` so the value only exists at the moment of the
 * provider call and is never carried in a loggable structure.
 */
export function readKeyValue(
  resolved: ResolvedKey,
  readSecret: (name: string) => string | undefined,
): string | null {
  const value = readSecret(resolved.secretName);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Masks a key for any diagnostic output. Returns a length hint only. */
export function describeKey(value: string | null): string {
  return value ? `set (${value.length} chars)` : "absent";
}
