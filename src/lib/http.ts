import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

export type JsonError = { error: string; code: string; requestId: string; details?: unknown };

export function jsonError(
  message: string,
  status: number,
  code = "error",
  requestId: string = randomUUID() as string,
  details?: unknown,
) {
  const body: JsonError = { error: message, code, requestId };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

export function jsonOk<T>(data: T, status = 200, requestId?: string) {
  return Response.json(
    requestId ? { data, requestId } : { data },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Client IP, resolved with explicit respect for the proxy topology.
 *
 * Only used for audit context and login throttling — NEVER for an authorization
 * decision, because a spoofable header must not be able to grant anything.
 *
 * WHY THE ORDER DEPENDS ON `TRUST_PROXY`:
 *
 * `X-Forwarded-For` is a comma-separated list. The LEFTMOST entry is whatever the
 * original client claimed and is trivially spoofable; each proxy appends the
 * address it actually saw. So:
 *
 *   - Behind a trusted proxy that appends (`TRUST_PROXY=append`), the correct
 *     source is the entry just before our own proxy — taken here as the LAST
 *     entry, which the proxy itself wrote and a client cannot forge.
 *   - When the platform overwrites the header entirely (`TRUST_PROXY=overwrite`,
 *     which is what this deployment does — verified in TASK-007: 24 probes across
 *     three spoofed XFF values collapsed onto ONE source digest), the leftmost
 *     entry is already the real client and taking it is correct.
 *   - With no proxy (`TRUST_PROXY=none`) the header is ignored entirely and only
 *     a platform-set `X-Real-IP` / `CF-Connecting-IP` is used.
 *
 * The default is `overwrite` because that matches the observed behaviour here and
 * is the conservative choice: it cannot be widened by a client, only narrowed.
 */
export type TrustProxy = "none" | "overwrite" | "append";

export function trustProxyMode(): TrustProxy {
  const raw = (process.env.TRUST_PROXY ?? "overwrite").trim().toLowerCase();
  return raw === "none" || raw === "append" ? raw : "overwrite";
}

export function clientIp(request: NextRequest | Request): string | null {
  const headers = "headers" in request ? request.headers : null;
  if (!headers) return null;

  const mode = trustProxyMode();
  const forwarded = headers.get("x-forwarded-for");

  if (mode !== "none" && forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) {
      return mode === "append" ? entries[entries.length - 1] : entries[0];
    }
  }

  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip");
}

export function userAgent(request: NextRequest | Request): string | null {
  return request.headers.get("user-agent");
}

export function newRequestId(): string {
  return randomUUID() as string;
}
