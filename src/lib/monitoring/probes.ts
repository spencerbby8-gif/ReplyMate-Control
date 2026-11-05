import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "@/config/env";
import { PROVIDER_CATALOGUE, FALLBACK_SEARCH, SOURCE_REPO } from "@/config/catalog";

/**
 * Live dependency probes.
 *
 * Honest scope: these measure reachability of an endpoint from THIS server
 * (DNS + TLS + HTTP response). They do NOT authenticate — ReplyMate is BYOK, so
 * provider keys live in each user's Android Keystore and this platform holds
 * none. A probe therefore reports "reachable / HTTP 401", never "your key works".
 */

export type ProbeResult = {
  target: string;
  kind: "http" | "database" | "supabase" | "queue";
  status: "ok" | "degraded" | "down" | "unknown";
  latencyMs: number | null;
  httpStatus: number | null;
  message: string | null;
};

const TIMEOUT_MS = 8000;
const DEGRADED_MS = 1500;

async function probeHttp(target: string, url: string, kind: ProbeResult["kind"] = "http"): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "replymate-control-monitor/1.0" },
    });
    const latencyMs = Date.now() - started;
    // Any HTTP response proves DNS+TLS+routing work. 401/403/404 are expected
    // for unauthenticated calls to provider APIs and are NOT failures.
    const reachable = response.status < 500;
    return {
      target,
      kind,
      status: reachable ? (latencyMs > DEGRADED_MS ? "degraded" : "ok") : "down",
      latencyMs,
      httpStatus: response.status,
      message: reachable
        ? latencyMs > DEGRADED_MS
          ? `reachable but slow (${latencyMs}ms)`
          : `reachable · HTTP ${response.status}`
        : `server error · HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      target,
      kind,
      status: "down",
      latencyMs: Date.now() - started,
      httpStatus: null,
      message: error instanceof Error ? `${error.name}: ${error.message.slice(0, 160)}` : "unknown error",
    };
  }
}

async function probeDatabase(): Promise<ProbeResult> {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    const latencyMs = Date.now() - started;
    return {
      target: "control-plane postgres",
      kind: "database",
      status: latencyMs > DEGRADED_MS ? "degraded" : "ok",
      latencyMs,
      httpStatus: null,
      message: `query accepted in ${latencyMs}ms`,
    };
  } catch (error) {
    return {
      target: "control-plane postgres",
      kind: "database",
      status: "down",
      latencyMs: Date.now() - started,
      httpStatus: null,
      message: error instanceof Error ? error.name : "unknown",
    };
  }
}

/**
 * True for a URL pointing at this host.
 *
 * Ollama's default base URL is `http://localhost:11434/v1`. On a server there is
 * no local Ollama daemon, so that probe will always fail — and reporting it as
 * `down` reads like an incident when it is a structural fact of the environment.
 * The probe still runs and still reports the real result; the flag only lets the
 * UI say why, instead of implying an outage nobody can act on.
 */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export type ProbeTarget = {
  target: string;
  url: string;
  kind: ProbeResult["kind"];
  /** True when the URL points at this host; see isLoopback(). */
  loopback?: boolean;
};

export function defaultProbeTargets(): ProbeTarget[] {
  const targets: ProbeTarget[] = [
    {
      target: "supabase rest",
      url: env.NEXT_PUBLIC_SUPABASE_URL
        ? `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/rest/v1/`
        : "https://xdcsxxwhvpiissetbrdr.supabase.co/rest/v1/",
      kind: "supabase",
    },
    {
      target: "replymate source ledger",
      url: `https://raw.githubusercontent.com/${env.REPLYMATE_REPO || SOURCE_REPO}/HEAD/releases/RELEASES.md`,
      kind: "http",
    },
    {
      target: "fallback search (wikipedia)",
      url: FALLBACK_SEARCH.endpoints[0].replace("{title}", "Reply"),
      kind: "http",
    },
  ];

  for (const provider of PROVIDER_CATALOGUE) {
    if (!provider.defaultBaseUrl) continue;
    // Probe the API root, not a model path — we hold no key and must not
    // construct an authenticated-looking request.
    targets.push({
      target: `provider ${provider.key}`,
      url: provider.defaultBaseUrl,
      kind: "http",
      loopback: isLoopback(provider.defaultBaseUrl),
    });
  }
  return targets;
}

export async function runProbeSuite(onlyTargets?: string[]): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [await probeDatabase()];

  const candidates = defaultProbeTargets();
  const filter = onlyTargets && onlyTargets.length > 0 ? new Set(onlyTargets) : null;

  for (const candidate of candidates) {
    if (filter && !filter.has(candidate.target)) continue;
    results.push(await probeHttp(candidate.target, candidate.url, candidate.kind));
  }
  return results;
}
