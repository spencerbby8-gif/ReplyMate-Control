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
 * Best-effort client IP. Only used for audit context and lockout — never for
 * authorization decisions (a spoofable header must not grant anything).
 */
export function clientIp(request: NextRequest | Request): string | null {
  const headers = "headers" in request ? request.headers : null;
  if (!headers) return null;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip");
}

export function userAgent(request: NextRequest | Request): string | null {
  return request.headers.get("user-agent");
}

export function newRequestId(): string {
  return randomUUID() as string;
}
