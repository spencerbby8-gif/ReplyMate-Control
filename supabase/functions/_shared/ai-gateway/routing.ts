import { GATEWAY_PROVIDERS, effectiveOutputCap, providerByKey, type ThinkingLevel } from "./catalogue.ts";

/**
 * Model routing and controlled fallback.
 *
 * Routes are ordered by priority within a task. A route is skipped rather than
 * failed when its provider has no master key configured, which is what makes
 * fallback work: an unconfigured provider must not take down a task that another
 * provider could serve.
 */

export type RoutePolicy = {
  task: string;
  providerKey: string;
  model: string;
  priority: number;
  thinking: ThinkingLevel;
  enabled: boolean;
  /** Minimum client version the route applies to, or null for all. */
  minAppVersion?: string | null;
};

export type RouteDecision =
  | {
      ok: true;
      route: RoutePolicy;
      maxOutputTokens: number;
      skipped: Array<{ providerKey: string; reason: string }>;
    }
  | { ok: false; reason: string; skipped: Array<{ providerKey: string; reason: string }> };

export function compareAppVersion(a: string, b: string): number {
  const pa = a.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
  const pb = b.split(".").map((segment) => Number.parseInt(segment, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Selects the route to use.
 *
 * `hasKey` is supplied by the caller because only the Edge Function knows which
 * master-key secrets are actually set. This module stays pure and testable.
 */
export function resolveRoute(input: {
  task: string;
  routes: RoutePolicy[];
  appVersion: string | null;
  hasKey: (providerKey: string) => boolean;
}): RouteDecision {
  const skipped: Array<{ providerKey: string; reason: string }> = [];

  const candidates = input.routes
    .filter((route) => route.enabled && route.task === input.task)
    .filter((route) => {
      if (!route.minAppVersion) return true;
      if (!input.appVersion) {
        skipped.push({ providerKey: route.providerKey, reason: "client sent no app version; gated route skipped" });
        return false;
      }
      const ok = compareAppVersion(input.appVersion, route.minAppVersion) >= 0;
      if (!ok) {
        skipped.push({
          providerKey: route.providerKey,
          reason: `app ${input.appVersion} < required ${route.minAppVersion}`,
        });
      }
      return ok;
    })
    .sort((a, b) => a.priority - b.priority || a.providerKey.localeCompare(b.providerKey));

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `No enabled route for task "${input.task}". The client should fall back to its own BYOK path.`,
      skipped,
    };
  }

  for (const route of candidates) {
    if (!providerByKey(route.providerKey)) {
      skipped.push({ providerKey: route.providerKey, reason: "not proxied by the gateway" });
      continue;
    }
    if (!input.hasKey(route.providerKey)) {
      // Skipping rather than failing is the whole point of a fallback chain.
      skipped.push({ providerKey: route.providerKey, reason: "no master key configured" });
      continue;
    }
    return { ok: true, route, maxOutputTokens: effectiveOutputCap(route.thinking), skipped };
  }

  return {
    ok: false,
    reason: `Every route for task "${input.task}" was skipped. Configure a master key or enable a route.`,
    skipped,
  };
}

/** Which providers the gateway can proxy, for the client's capability probe. */
export function proxiedProviders() {
  return GATEWAY_PROVIDERS.map((provider) => ({
    key: provider.key,
    label: provider.label,
    dialect: provider.apiStyle,
    reasoning: provider.reasoning,
    search: provider.search,
  }));
}
