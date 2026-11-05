import { createHmac } from "node:crypto";

/**
 * Supabase Management API client — Edge Function secrets and functions.
 *
 * WHY A SEPARATE CREDENTIAL IS REQUIRED
 * The project keys this app already holds (`SUPABASE_PUBLISHABLE_KEY`,
 * `SUPABASE_SECRET_KEY`) authenticate against the project's data plane
 * (PostgREST / GoTrue / Storage). They are NOT valid against
 * `api.supabase.com`. Verified live in TASK-002: the Management API answers a
 * project secret key with `401 {"message":"JWT could not be decoded"}`. Managing
 * Edge Function secrets therefore needs a **personal access token** issued by the
 * Supabase account, supplied as `SUPABASE_ACCESS_TOKEN`.
 *
 * MINIMUM PERMISSIONS (documented before requesting anything)
 * Fine-grained token permissions, per the Management API reference:
 *   edge_functions_secrets_read    GET    /v1/projects/{ref}/secrets
 *   edge_functions_secrets_write   POST   /v1/projects/{ref}/secrets
 *   edge_functions_secrets_write   DELETE /v1/projects/{ref}/secrets
 *   edge_functions_read            GET    /v1/projects/{ref}/functions
 *   edge_functions_write           POST   /v1/projects/{ref}/functions  (deploy)
 * Legacy OAuth scopes, if a non-fine-grained token is used:
 *   secrets:read, secrets:write, edge_functions:read, edge_functions:write
 *
 * Deliberately NOT requested: projects:write, database:write, storage:*,
 * api_gateway_keys_*, auth_signing_keys_*, organization_*. A token that can
 * pause, restart or recreate the project is not needed to rotate a provider key,
 * and asking for it would widen the blast radius of a leaked token for nothing.
 *
 * SECRET HYGIENE
 *  - The token is read from a non-prefixed variable, so it cannot be inlined into
 *    a client bundle. `assertNoSecretInPublicVars()` additionally refuses an
 *    `sbp_`-shaped value behind any NEXT_PUBLIC_ name.
 *  - `listSecrets()` returns NAMES AND DIGESTS ONLY. Supabase does not return
 *    secret values from that endpoint; if a value field ever appeared it is
 *    stripped before the result leaves this module.
 *  - Write methods accept a value, send it once over TLS, and do not retain it.
 *    No value is logged, returned, audited or cached.
 *  - Errors are reduced to a status code and a short class, because provider
 *    error bodies can echo request material.
 */

const API_BASE = "https://api.supabase.com";
const TIMEOUT_MS = 25_000;

export type ManagementAuth =
  | { configured: true; tokenPrefix: string; tokenLength: number; apiBase: string }
  | { configured: false; reason: string };

export type SecretEntry = { name: string; digest: string };

export type EdgeFunctionSummary = {
  slug: string;
  name: string | null;
  status: string | null;
  version: string | null;
  verifyJwt: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ManagementResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number | null; code: ManagementErrorCode; reason: string };

export type ManagementErrorCode =
  | "not_configured"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "conflict"
  | "upstream_error"
  | "network_error"
  | "bad_response";

function token(): string | null {
  const raw = process.env.SUPABASE_ACCESS_TOKEN?.trim().replace(/^["']|["']$/g, "");
  return raw && raw.length >= 20 ? raw : null;
}

function projectRef(): string | null {
  const url = process.env.SUPABASE_PROJECT_URL?.trim().replace(/^["']|["']$/g, "");
  if (!url) return null;
  const match = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|com)/i);
  return match ? match[1] : null;
}

/** Presence and shape only. Never the token. */
export function managementAuthStatus(): ManagementAuth {
  const value = token();
  if (!value) {
    return {
      configured: false,
      reason:
        "SUPABASE_ACCESS_TOKEN is not set. The Management API requires a personal/fine-grained access token; the project publishable and secret keys are not accepted (verified live: 401 'JWT could not be decoded').",
    };
  }
  if (!projectRef()) {
    return { configured: false, reason: "SUPABASE_PROJECT_URL is not set or is not a *.supabase.co URL." };
  }
  return {
    configured: true,
    // Prefix and length only — enough to tell an `sbp_` legacy token from a
    // fine-grained `sbp_`-style one without revealing anything usable.
    tokenPrefix: value.slice(0, 4),
    tokenLength: value.length,
    apiBase: API_BASE,
  };
}

/** Non-reversible fingerprint of a secret VALUE, for change detection. */
export function secretValueFingerprint(value: string): string {
  return createHmac("sha256", "rmctl-vault-fingerprint").update(value).digest("hex").slice(0, 16);
}

function classify(status: number): ManagementErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "bad_response";
}

/**
 * Explains a refusal in terms of the PERMISSION that is missing, so an operator
 * knows which scope to add rather than guessing.
 */
function permissionHint(status: number, method: string, path: string): string {
  if (status !== 401 && status !== 403) return "";
  if (path.includes("/secrets")) {
    return method === "GET"
      ? " Required permission: edge_functions_secrets_read (legacy scope secrets:read)."
      : " Required permission: edge_functions_secrets_write (legacy scope secrets:write).";
  }
  if (path.includes("/functions")) {
    return method === "GET"
      ? " Required permission: edge_functions_read (legacy scope edge_functions:read)."
      : " Required permission: edge_functions_write (legacy scope edge_functions:write).";
  }
  return "";
}

async function call<T>(method: "GET" | "POST" | "DELETE" | "PATCH", path: string, body?: unknown): Promise<ManagementResult<T>> {
  const value = token();
  const ref = projectRef();
  if (!value || !ref) {
    const status = managementAuthStatus();
    return {
      ok: false,
      status: null,
      code: "not_configured",
      reason: status.configured ? "Management API is not configured." : status.reason,
    };
  }

  const url = `${API_BASE}${path.replace("{ref}", ref)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${value}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      // The body may contain a secret value. It is sent once and not retained;
      // nothing about it is logged on any path, success or failure.
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      code: "network_error",
      // Error NAME only: a fetch error message can embed the URL, and the URL is
      // safe but the habit of echoing transport errors is what leaks bodies.
      reason: `Management API unreachable (${error instanceof Error ? error.name : "unknown"}).${permissionHint(0, method, path)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: classify(response.status),
      reason: `Management API returned HTTP ${response.status} for ${method} ${path.replace(ref, "{ref}")}.${permissionHint(response.status, method, path)}`,
    };
  }

  if (response.status === 204) return { ok: true, data: undefined as T, status: 204 };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, status: response.status, code: "bad_response", reason: "Management API returned a non-JSON body." };
  }
  return { ok: true, data: parsed as T, status: response.status };
}

/**
 * Lists project secrets — which are the Edge Function environment variables.
 *
 * Returns NAMES AND DIGESTS ONLY. Any `value`-shaped field is stripped here so a
 * future API change cannot start leaking secrets into this app's pages, audit log
 * or browser.
 */
export async function listSecrets(): Promise<ManagementResult<SecretEntry[]>> {
  const result = await call<Array<Record<string, unknown>>>("GET", "/v1/projects/{ref}/secrets");
  if (!result.ok) return result;

  const entries: SecretEntry[] = (result.data ?? []).map((row) => ({
    name: String(row.name ?? ""),
    digest: String(row.digest ?? ""),
  }));
  return { ok: true, data: entries, status: result.status };
}

/** Creates or overwrites secrets. Values are sent once and never retained. */
export async function upsertSecrets(
  secrets: Array<{ name: string; value: string }>,
): Promise<ManagementResult<{ written: string[] }>> {
  if (secrets.length === 0) {
    return { ok: false, status: null, code: "bad_response", reason: "Nothing to write." };
  }
  const invalid = secrets.filter((s) => !/^[A-Z][A-Z0-9_]*$/.test(s.name));
  if (invalid.length > 0) {
    return {
      ok: false,
      status: null,
      code: "bad_response",
      reason: `Secret names must be UPPER_SNAKE_CASE: ${invalid.map((s) => s.name).join(", ")}.`,
    };
  }
  const result = await call<unknown>("POST", "/v1/projects/{ref}/secrets", secrets);
  if (!result.ok) return result;
  // Return NAMES only. The response body is discarded.
  return { ok: true, data: { written: secrets.map((s) => s.name) }, status: result.status };
}

/** Deletes secrets by name. */
export async function deleteSecrets(names: string[]): Promise<ManagementResult<{ deleted: string[] }>> {
  if (names.length === 0) {
    return { ok: false, status: null, code: "bad_response", reason: "Nothing to delete." };
  }
  const result = await call<unknown>("DELETE", "/v1/projects/{ref}/secrets", names);
  if (!result.ok) return result;
  return { ok: true, data: { deleted: names }, status: result.status };
}

export async function listFunctions(): Promise<ManagementResult<EdgeFunctionSummary[]>> {
  const result = await call<Array<Record<string, unknown>>>("GET", "/v1/projects/{ref}/functions");
  if (!result.ok) return result;
  const rows = (result.data ?? []).map((row) => ({
    slug: String(row.slug ?? row.id ?? ""),
    name: row.name === undefined || row.name === null ? null : String(row.name),
    status: row.status === undefined || row.status === null ? null : String(row.status),
    version: row.version === undefined || row.version === null ? null : String(row.version),
    verifyJwt: typeof row.verify_jwt === "boolean" ? row.verify_jwt : null,
    createdAt: row.created_at === undefined || row.created_at === null ? null : String(row.created_at),
    updatedAt: row.updated_at === undefined || row.updated_at === null ? null : String(row.updated_at),
  }));
  return { ok: true, data: rows, status: result.status };
}

/**
 * Deployment status only.
 *
 * Actually deploying a bundle is deliberately NOT implemented here: the deploy
 * endpoint expects a multipart ESZIP bundle, and shipping code to production is
 * an owner-approved action performed by `scripts/deploy-edge-function.ts`, not
 * something an admin button should do silently. See TASK-012.
 */
export async function getFunction(slug: string): Promise<ManagementResult<EdgeFunctionSummary | null>> {
  const result = await call<Record<string, unknown>>("GET", `/v1/projects/{ref}/functions/${encodeURIComponent(slug)}`);
  if (!result.ok) {
    if (result.code === "not_found") return { ok: true, data: null, status: result.status ?? 404 };
    return result;
  }
  const row = result.data ?? {};
  return {
    ok: true,
    status: result.status,
    data: {
      slug: String(row.slug ?? slug),
      name: row.name === undefined || row.name === null ? null : String(row.name),
      status: row.status === undefined || row.status === null ? null : String(row.status),
      version: row.version === undefined || row.version === null ? null : String(row.version),
      verifyJwt: typeof row.verify_jwt === "boolean" ? row.verify_jwt : null,
      createdAt: row.created_at === undefined || row.created_at === null ? null : String(row.created_at),
      updatedAt: row.updated_at === undefined || row.updated_at === null ? null : String(row.updated_at),
    },
  };
}
