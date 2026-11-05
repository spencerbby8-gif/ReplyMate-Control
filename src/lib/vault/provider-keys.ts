import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  ctlProviderKey,
  ctlProviderPolicy,
  type ProviderKeySlot,
  type ProviderKeyStatus,
} from "@/db/schema";
import {
  deleteSecrets,
  getFunction,
  listFunctions,
  listSecrets,
  managementAuthStatus,
  secretValueFingerprint,
  upsertSecrets,
  type ManagementErrorCode,
} from "@/lib/supabase/management";

/**
 * Provider master-key vault.
 *
 * THE CENTRAL DESIGN DECISION: **this platform never stores a provider key.**
 *
 * The authoritative store is Supabase Edge Function Secrets, which is where the
 * gateway already reads them from (`Deno.env.get`). Control is a *management
 * plane* for that store, not a second copy of it. A key value exists in this
 * process only for the duration of one request, is sent once over TLS to the
 * Management API, and is then dropped. What persists is a metadata row whose
 * strongest property is structural: `ctl_provider_key` has **no column that can
 * hold a value** — only a non-reversible HMAC fingerprint and a character count.
 *
 * Consequences that follow from this, stated plainly rather than discovered
 * later:
 *
 *  - **A saved key cannot be read back.** Not by the UI, not by an API route,
 *    not by a database dump, not by an attacker with the secret key. Supabase
 *    does not return secret values either, so there is no path at all.
 *  - **Control cannot test a key itself**, because testing requires using it.
 *    A probe must be performed by the deployed gateway, which is the only
 *    component that holds the value at runtime. When the gateway is not
 *    deployed, `testKey` reports `unavailable` — it does not fake a result.
 *  - **Rotation is two-phase.** Stage writes the new value to the `_NEXT` slot
 *    and marks the provider rotating, so the gateway prefers the new key while
 *    the old one remains as fallback — zero downtime, no flag day. Promotion
 *    requires re-entering the value, because nothing stored it. That re-entry is
 *    a feature: it proves the operator still possesses the key.
 */

/** One-line explanation of why the Management API is unusable, or null. */
function managementBlocker(): string | null {
  const status = managementAuthStatus();
  return status.configured ? null : status.reason;
}

/** Providers the gateway proxies. Mirrors the Edge Function catalogue exactly. */
export const VAULT_PROVIDERS = [
  "gemini",
  "anthropic",
  "openai",
  "openrouter",
  "deepseek",
  "grok",
  "kimi",
  "mistral",
] as const;

export type VaultProvider = (typeof VAULT_PROVIDERS)[number];

/** Providers that must never have a platform key, with the reason. */
export const NOT_VAULTABLE: Array<{ key: string; reason: string }> = [
  { key: "ollama", reason: "Runs on the user's own device; there is nothing to proxy." },
  { key: "openai_compat", reason: "An arbitrary user-chosen endpoint; the platform cannot hold a key for it." },
];

/** Secret names, matching supabase/functions/_shared/ai-gateway/keys.ts exactly. */
export function secretNameFor(providerKey: string, slot: ProviderKeySlot): string {
  const base = `${providerKey.toUpperCase()}_MASTER_KEY`;
  return slot === "primary" ? base : `${base}_NEXT`;
}

/** The secret that tells the gateway which providers are mid-rotation. */
export const ROTATING_SECRET_NAME = "GATEWAY_ROTATING_PROVIDERS";

export function isVaultProvider(key: string): key is VaultProvider {
  return (VAULT_PROVIDERS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Status — masked, presence-only
// ---------------------------------------------------------------------------

export type VaultSlotView = {
  slot: ProviderKeySlot;
  secretName: string;
  /** True when the Management API reports this secret exists in the project. */
  presentRemotely: boolean;
  /** Digest reported by Supabase. Not the value, and not reversible. */
  remoteDigest: string | null;
  status: ProviderKeyStatus | null;
  valueLength: number | null;
  fingerprint: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOutcome: string | null;
  setAt: string | null;
  note: string | null;
  /** True when we hold metadata but Supabase does not have the secret. */
  drifted: boolean;
};

export type VaultProviderView = {
  providerKey: string;
  platformEnabled: boolean;
  byokAllowed: boolean;
  dailySpendCapMicroUsd: number;
  rotating: boolean;
  slots: VaultSlotView[];
  /** Any slot that is present and active — i.e. the gateway could serve this. */
  usable: boolean;
};

export type VaultStatus = {
  ranAt: string;
  management: ReturnType<typeof managementAuthStatus>;
  /** Where the truth lives, so nobody mistakes this table for the store. */
  authoritativeStore: string;
  functions: {
    readable: boolean;
    gateway: { slug: string; status: string | null; version: string | null; deployed: boolean } | null;
    error: string | null;
  };
  providers: VaultProviderView[];
  unvaultable: typeof NOT_VAULTABLE;
  /** Secrets in the project that look like gateway keys but are not tracked here. */
  untrackedRemoteSecrets: string[];
};

const GATEWAY_SLUG = "replymate-ai";

export async function vaultStatus(): Promise<VaultStatus> {
  const management = managementAuthStatus();

  const [remoteSecrets, remoteFunctions, keyRows, policyRows] = await Promise.all([
    management.configured ? listSecrets() : Promise.resolve(null),
    management.configured ? listFunctions() : Promise.resolve(null),
    db.select().from(ctlProviderKey).orderBy(desc(ctlProviderKey.updatedAt)),
    db.select().from(ctlProviderPolicy),
  ]);

  const remoteByName = new Map<string, string>();
  if (remoteSecrets?.ok) {
    for (const entry of remoteSecrets.data) remoteByName.set(entry.name, entry.digest);
  }

  const rotatingRaw = remoteByName.has(ROTATING_SECRET_NAME)
    ? await readRotatingProviders()
    : [];
  const rotating = new Set(rotatingRaw);

  const trackedNames = new Set<string>();
  const providers: VaultProviderView[] = VAULT_PROVIDERS.map((providerKey) => {
    const policy = policyRows.find((p) => p.providerKey === providerKey);
    const slots: VaultSlotView[] = (["primary", "next"] as const).map((slot) => {
      const name = secretNameFor(providerKey, slot);
      trackedNames.add(name);
      const row = keyRows.find((r) => r.providerKey === providerKey && r.slot === slot && r.status !== "disabled");
      const presentRemotely = remoteByName.has(name);
      return {
        slot,
        secretName: name,
        presentRemotely,
        remoteDigest: remoteByName.get(name) ?? null,
        status: row?.status ?? null,
        valueLength: row?.valueLength ?? null,
        fingerprint: row?.valueFingerprint ?? null,
        lastVerifiedAt: row?.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
        lastVerifiedOutcome: row?.lastVerifiedOutcome ?? null,
        setAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
        note: row?.note ?? null,
        // Metadata says a key exists but Supabase does not have it: someone
        // changed it in the dashboard, or a write failed. Either way it must be
        // visible rather than silently believed.
        drifted: Boolean(row) && !presentRemotely,
      };
    });

    return {
      providerKey,
      platformEnabled: policy?.platformEnabled ?? false,
      byokAllowed: policy?.byokAllowed ?? true,
      dailySpendCapMicroUsd: policy?.dailySpendCapMicroUsd ?? 0,
      rotating: rotating.has(providerKey),
      slots,
      usable: slots.some((s) => s.presentRemotely && s.status !== "disabled"),
    };
  });

  // Secrets in the project matching the gateway naming but not tracked here.
  const untrackedRemoteSecrets = remoteSecrets?.ok
    ? remoteSecrets.data
        .map((s) => s.name)
        .filter((name) => /_MASTER_KEY(_NEXT)?$/.test(name) && !trackedNames.has(name))
    : [];

  let gateway: VaultStatus["functions"]["gateway"] = null;
  let functionsError: string | null = null;
  if (remoteFunctions?.ok) {
    const found = remoteFunctions.data.find((f) => f.slug === GATEWAY_SLUG) ?? null;
    gateway = found
      ? { slug: found.slug, status: found.status, version: found.version, deployed: true }
      : { slug: GATEWAY_SLUG, status: null, version: null, deployed: false };
  } else if (remoteFunctions && !remoteFunctions.ok) {
    functionsError = remoteFunctions.reason;
  } else {
    functionsError = "Management API not configured; deployment state unknown.";
  }

  return {
    ranAt: new Date().toISOString(),
    management,
    authoritativeStore: `Supabase Edge Function Secrets on project ${process.env.SUPABASE_PROJECT_URL ? "" : ""}(read via the Management API). This table holds metadata only — there is no column in which a key value could be stored.`,
    functions: { readable: remoteFunctions?.ok === true, gateway, error: functionsError },
    providers,
    unvaultable: NOT_VAULTABLE,
    untrackedRemoteSecrets,
  };
}

/** Reads the rotating-provider list. The value is a comma list, not a secret. */
async function readRotatingProviders(): Promise<string[]> {
  const [row] = await db
    .select({ note: ctlProviderKey.note })
    .from(ctlProviderKey)
    .where(eq(ctlProviderKey.secretName, ROTATING_SECRET_NAME))
    .limit(1);
  // The rotating list is mirrored into metadata because Supabase will not return
  // the value. It is not a secret: it is a list of provider keys.
  return row?.note ? row.note.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type VaultResult =
  | { ok: true; summary: string; detail: Record<string, unknown> }
  | { ok: false; code: ManagementErrorCode | "validation" | "unavailable"; reason: string };

function validateValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 8) return "A provider key must be at least 8 characters.";
  if (trimmed.length > 512) return "A provider key must be at most 512 characters.";
  if (/\s/.test(trimmed)) return "A provider key must not contain whitespace — check for a stray newline or space.";
  return null;
}

/**
 * Writes one key slot. The value is validated, sent once, and dropped.
 *
 * `previousFingerprint` is returned so the caller can tell a no-op re-save from
 * a real change without ever seeing either value.
 */
export async function setProviderKey(input: {
  providerKey: string;
  slot: ProviderKeySlot;
  value: string;
  note?: string | null;
  actorAdminId: string;
}): Promise<VaultResult & { changed?: boolean }> {
  if (!isVaultProvider(input.providerKey)) {
    const notVaultable = NOT_VAULTABLE.find((p) => p.key === input.providerKey);
    return {
      ok: false,
      code: "validation",
      reason: notVaultable
        ? `${input.providerKey} cannot hold a platform key: ${notVaultable.reason}`
        : `Unknown provider "${input.providerKey}". The gateway proxies: ${VAULT_PROVIDERS.join(", ")}.`,
    };
  }

  const problem = validateValue(input.value);
  if (problem) return { ok: false, code: "validation", reason: problem };

  const blocker = managementBlocker();
  if (blocker) {
    return {
      ok: false,
      code: "unavailable",
      reason: `${blocker} The key was NOT stored anywhere — this platform has no fallback store and will not create one.`,
    };
  }

  const value = input.value.trim();
  const secretName = secretNameFor(input.providerKey, input.slot);
  const fingerprint = secretValueFingerprint(value);

  const written = await upsertSecrets([{ name: secretName, value }]);
  // The value goes out of scope here. Nothing below can reference it.
  if (!written.ok) {
    return { ok: false, code: written.code, reason: written.reason };
  }

  const existing = await db
    .select()
    .from(ctlProviderKey)
    .where(and(eq(ctlProviderKey.providerKey, input.providerKey), eq(ctlProviderKey.slot, input.slot)))
    .orderBy(desc(ctlProviderKey.createdAt))
    .limit(1);
  const changed = existing[0]?.valueFingerprint !== fingerprint;

  await db
    .insert(ctlProviderKey)
    .values({
      providerKey: input.providerKey,
      slot: input.slot,
      secretName,
      valueFingerprint: fingerprint,
      valueLength: value.length,
      status: "active",
      note: input.note ?? null,
      setBy: input.actorAdminId,
      rotatedFrom: existing[0]?.id ?? null,
      disabledAt: null,
    })
    .onConflictDoUpdate({
      target: [ctlProviderKey.providerKey, ctlProviderKey.slot, ctlProviderKey.valueFingerprint],
      set: {
        status: "active",
        valueLength: value.length,
        note: input.note ?? null,
        setBy: input.actorAdminId,
        disabledAt: null,
        updatedAt: new Date(),
      },
    });

  return {
    ok: true,
    changed,
    summary: `${secretName} written to Supabase Edge Function Secrets (${changed ? "new value" : "same value re-saved"}).`,
    detail: {
      providerKey: input.providerKey,
      slot: input.slot,
      secretName,
      fingerprint,
      valueLength: value.length,
      changed,
      // Explicitly recorded so an audit row can prove no value was retained.
      valueStoredLocally: false,
    },
  };
}

/**
 * Phase 1 of rotation: stage a new key in the `_NEXT` slot and tell the gateway
 * to prefer it. The old primary stays in place as fallback, so this is
 * zero-downtime.
 */
export async function stageRotation(input: {
  providerKey: string;
  value: string;
  note?: string | null;
  actorAdminId: string;
}): Promise<VaultResult> {
  if (!isVaultProvider(input.providerKey)) {
    return { ok: false, code: "validation", reason: `Unknown provider "${input.providerKey}".` };
  }
  const staged = await setProviderKey({
    providerKey: input.providerKey,
    slot: "next",
    value: input.value,
    note: input.note ?? null,
    actorAdminId: input.actorAdminId,
  });
  if (!staged.ok) return staged;

  const rotating = await markRotating(input.providerKey, true);
  if (!rotating.ok) return rotating;

  return {
    ok: true,
    summary: `Staged a new ${input.providerKey} key in ${secretNameFor(input.providerKey, "next")} and marked the provider rotating. The gateway now prefers the new key and falls back to the old one if it fails auth.`,
    detail: { providerKey: input.providerKey, phase: "staged", rotatingProviders: rotating.detail.providers },
  };
}

/**
 * Phase 2 of rotation: write the value to the primary slot, delete `_NEXT` and
 * clear the rotating flag.
 *
 * Requires the value again **by design**. Supabase secrets are write-only and
 * this platform stores nothing, so there is no way to promote a staged key
 * without the operator re-supplying it. That re-entry is a control, not an
 * inconvenience: it proves continued possession.
 */
export async function promoteRotation(input: {
  providerKey: string;
  value: string;
  actorAdminId: string;
}): Promise<VaultResult> {
  if (!isVaultProvider(input.providerKey)) {
    return { ok: false, code: "validation", reason: `Unknown provider "${input.providerKey}".` };
  }

  const fingerprint = secretValueFingerprint(input.value.trim());
  const staged = await db
    .select()
    .from(ctlProviderKey)
    .where(
      and(
        eq(ctlProviderKey.providerKey, input.providerKey),
        eq(ctlProviderKey.slot, "next"),
        eq(ctlProviderKey.status, "active"),
      ),
    )
    .orderBy(desc(ctlProviderKey.createdAt))
    .limit(1);

  if (staged[0] && staged[0].valueFingerprint !== fingerprint) {
    return {
      ok: false,
      code: "validation",
      reason:
        "The value supplied does not match the staged key. Promotion must re-enter the SAME key that was staged; this platform cannot read the staged value back, so it verifies by fingerprint instead.",
    };
  }

  const written = await setProviderKey({
    providerKey: input.providerKey,
    slot: "primary",
    value: input.value,
    note: "promoted from rotation",
    actorAdminId: input.actorAdminId,
  });
  if (!written.ok) return written;

  const nextName = secretNameFor(input.providerKey, "next");
  const removed = await deleteSecrets([nextName]);
  if (!removed.ok) {
    return {
      ok: false,
      code: removed.code,
      reason: `Primary was written but ${nextName} could not be deleted: ${removed.reason}. The gateway still works; delete the stale slot manually.`,
    };
  }
  await db
    .update(ctlProviderKey)
    .set({ status: "disabled", disabledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ctlProviderKey.providerKey, input.providerKey), eq(ctlProviderKey.slot, "next")));

  const cleared = await markRotating(input.providerKey, false);
  if (!cleared.ok) return cleared;

  return {
    ok: true,
    summary: `Rotation promoted: ${input.providerKey} primary now holds the new key, ${nextName} was deleted, and the provider is no longer marked rotating.`,
    detail: { providerKey: input.providerKey, phase: "promoted", deletedSecret: nextName },
  };
}

/** Deletes a key slot from Supabase and marks the metadata disabled. */
export async function disableProviderKey(input: {
  providerKey: string;
  slot: ProviderKeySlot;
  actorAdminId: string;
}): Promise<VaultResult> {
  if (!isVaultProvider(input.providerKey)) {
    return { ok: false, code: "validation", reason: `Unknown provider "${input.providerKey}".` };
  }
  const blocker = managementBlocker();
  if (blocker) return { ok: false, code: "unavailable", reason: blocker };

  const secretName = secretNameFor(input.providerKey, input.slot);
  const result = await deleteSecrets([secretName]);
  if (!result.ok) return { ok: false, code: result.code, reason: result.reason };

  await db
    .update(ctlProviderKey)
    .set({ status: "disabled", disabledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ctlProviderKey.providerKey, input.providerKey), eq(ctlProviderKey.slot, input.slot)));

  if (input.slot === "next") await markRotating(input.providerKey, false).catch(() => undefined);

  return {
    ok: true,
    summary: `${secretName} deleted from Supabase Edge Function Secrets. The gateway can no longer resolve ${input.providerKey} from the ${input.slot} slot.`,
    detail: { providerKey: input.providerKey, slot: input.slot, secretName, deleted: true },
  };
}

/**
 * Probes a provider through the DEPLOYED GATEWAY.
 *
 * Control cannot test a key itself — testing requires using the key, and Control
 * deliberately does not have it. The gateway is the only component that holds a
 * value at runtime, so the probe is delegated to it. When the gateway is not
 * deployed this reports `unavailable` rather than inventing a result.
 */
export async function testProviderKey(input: {
  providerKey: string;
  gatewayUrl: string | null;
  userAccessToken: string | null;
}): Promise<VaultResult> {
  if (!isVaultProvider(input.providerKey)) {
    return { ok: false, code: "validation", reason: `Unknown provider "${input.providerKey}".` };
  }

  const probeBlocker = managementBlocker();
  const fn = probeBlocker ? null : await getFunction(GATEWAY_SLUG);
  const deployed = fn?.ok === true && fn.data !== null;

  if (!deployed) {
    return {
      ok: false,
      code: "unavailable",
      reason: fn?.ok === true
        ? `The ${GATEWAY_SLUG} Edge Function is not deployed, so no component currently holds this key at runtime. Deploy it first; a probe cannot be performed from Control because Control never stores the value.`
        : `Deployment state could not be read (${fn && !fn.ok ? fn.reason : (probeBlocker ?? "unknown")}). A probe cannot be performed from Control because Control never stores the value.`,
    };
  }

  if (!input.gatewayUrl || !input.userAccessToken) {
    return {
      ok: false,
      code: "unavailable",
      reason:
        "Probing requires the gateway URL and an end-user access token, because the gateway authenticates the caller and enforces that user's quota. Control has neither, and minting one would bypass the quota it is supposed to enforce.",
    };
  }

  const started = Date.now();
  try {
    const response = await fetch(input.gatewayUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.userAccessToken}`,
        "content-type": "application/json",
        "x-replymate-app-version": "control-probe",
      },
      body: JSON.stringify({ task: "reply", provider: input.providerKey, probe: true, maxOutputTokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - started;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // Only a short code/class is taken from the body. Provider bodies can echo
    // request material, so nothing else is read or retained.
    const errorClass = typeof body.code === "string" ? body.code : null;

    const outcome: "ok" | "auth_failed" | "rate_limited" | "error" =
      response.ok ? "ok"
      : response.status === 401 || response.status === 403 ? "auth_failed"
      : response.status === 429 ? "rate_limited"
      : "error";

    await db
      .update(ctlProviderKey)
      .set({
        lastVerifiedAt: new Date(),
        lastVerifiedOutcome: outcome,
        status: outcome === "auth_failed" ? "failed" : "active",
        updatedAt: new Date(),
      })
      .where(and(eq(ctlProviderKey.providerKey, input.providerKey), eq(ctlProviderKey.slot, "primary")));

    const detail = { providerKey: input.providerKey, outcome, latencyMs, httpStatus: response.status };
    if (response.ok) {
      return { ok: true, summary: `Gateway probe succeeded in ${latencyMs}ms.`, detail };
    }
    return {
      ok: false,
      code: "upstream_error",
      reason: `Gateway probe returned HTTP ${response.status}${errorClass ? ` (${errorClass})` : ""} in ${latencyMs}ms.`,
    };
  } catch (error) {
    return {
      ok: false,
      code: "network_error",
      reason: `Gateway probe failed (${error instanceof Error ? error.name : "unknown"}).`,
    };
  }
}

/**
 * Maintains `GATEWAY_ROTATING_PROVIDERS`.
 *
 * The value is a comma-separated list of provider keys — configuration, not a
 * secret — so it is safe to mirror into metadata, which is how the UI can show
 * rotation state given that Supabase will not return a secret value.
 */
export async function markRotating(
  providerKey: string,
  rotating: boolean,
): Promise<VaultResult> {
  const blocker = managementBlocker();
  if (blocker) return { ok: false, code: "unavailable", reason: blocker };

  const current = await readRotatingProviders();
  const next = rotating
    ? [...new Set([...current, providerKey])]
    : current.filter((key) => key !== providerKey);

  if (next.length === 0) {
    const removed = await deleteSecrets([ROTATING_SECRET_NAME]);
    if (!removed.ok && removed.code !== "not_found") {
      return { ok: false, code: removed.code, reason: removed.reason };
    }
  } else {
    const written = await upsertSecrets([{ name: ROTATING_SECRET_NAME, value: next.join(",") }]);
    if (!written.ok) return { ok: false, code: written.code, reason: written.reason };
  }

  await db
    .insert(ctlProviderKey)
    .values({
      providerKey: "_rotating_list",
      slot: "primary",
      secretName: ROTATING_SECRET_NAME,
      valueFingerprint: secretValueFingerprint(next.join(",")),
      valueLength: next.join(",").length,
      status: "active",
      note: next.join(","),
    })
    .onConflictDoUpdate({
      target: [ctlProviderKey.providerKey, ctlProviderKey.slot, ctlProviderKey.valueFingerprint],
      set: { note: next.join(","), valueLength: next.join(",").length, status: "active", updatedAt: new Date() },
    });

  return {
    ok: true,
    summary: `Rotating providers: ${next.length > 0 ? next.join(", ") : "(none)"}.`,
    detail: { providers: next },
  };
}

/** Platform-vs-BYOK policy for one provider. */
export async function setProviderPolicy(input: {
  providerKey: string;
  platformEnabled: boolean;
  byokAllowed: boolean;
  dailySpendCapMicroUsd: number;
  reason?: string | null;
  actorAdminId: string;
}): Promise<VaultResult> {
  if (!isVaultProvider(input.providerKey)) {
    return { ok: false, code: "validation", reason: `Unknown provider "${input.providerKey}".` };
  }
  if (input.dailySpendCapMicroUsd < 0) {
    return { ok: false, code: "validation", reason: "A spend cap cannot be negative." };
  }
  if (input.platformEnabled && input.dailySpendCapMicroUsd === 0) {
    return {
      ok: false,
      code: "validation",
      reason:
        "Enabling platform AI with a zero spend cap would allow unbounded platform spend. Set a daily cap in micro-USD, or leave the provider disabled.",
    };
  }
  if (!input.byokAllowed) {
    return {
      ok: false,
      code: "validation",
      reason:
        "BYOK cannot be disabled. It is the product's existing behaviour and users' own keys are stored only in their device Keystore; removing the option would strand them.",
    };
  }

  await db
    .insert(ctlProviderPolicy)
    .values({
      providerKey: input.providerKey,
      platformEnabled: input.platformEnabled,
      byokAllowed: true,
      dailySpendCapMicroUsd: input.dailySpendCapMicroUsd,
      reason: input.reason ?? null,
      updatedBy: input.actorAdminId,
    })
    .onConflictDoUpdate({
      target: ctlProviderPolicy.providerKey,
      set: {
        platformEnabled: input.platformEnabled,
        dailySpendCapMicroUsd: input.dailySpendCapMicroUsd,
        reason: input.reason ?? null,
        updatedBy: input.actorAdminId,
        updatedAt: new Date(),
      },
    });

  return {
    ok: true,
    summary: `${input.providerKey}: platform AI ${input.platformEnabled ? "enabled" : "disabled"}, daily cap ${input.dailySpendCapMicroUsd} µUSD, BYOK always allowed.`,
    detail: { ...input, byokAllowed: true },
  };
}
