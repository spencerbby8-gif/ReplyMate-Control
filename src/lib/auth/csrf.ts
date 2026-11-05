/**
 * CSRF defence for state-changing requests.
 *
 * Layer 1 is the session cookie: `HttpOnly` + `SameSite=Lax`, which already
 * stops a cross-site form or `fetch` from carrying the cookie at all.
 *
 * Layer 2 is this module — an explicit origin check. It exists because
 * `SameSite` is a browser behaviour we do not control, is not implemented
 * uniformly by every client, and says nothing about a malicious same-network
 * page that manages a top-level navigation. Defence in depth costs one header
 * comparison, so we pay it.
 *
 * Policy:
 *  - Requests carrying `Sec-Fetch-Site` (all current browsers) must be
 *    `same-origin`, `same-site`, or `none` (typed URL / bookmark).
 *  - Where that header is absent — curl, native clients, older browsers — the
 *    `Origin` header must match the host we are serving from, or both `Origin`
 *    and `Referer` must be absent (a non-browser client, which cannot be driven
 *    by a victim's session in the first place).
 *  - `GET`/`HEAD`/`OPTIONS` are exempt: they must not mutate anything, and every
 *    mutation in this app is a POST/PUT/PATCH/DELETE.
 */

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfDecision =
  | { ok: true; basis: "safe-method" | "sec-fetch-site" | "origin-match" | "no-browser-context" }
  | { ok: false; reason: string };

/** Hosts we accept as same-origin. Derived from configuration, never hardcoded. */
export function allowedHosts(requestHost: string | null, extra: string[] = []): Set<string> {
  const hosts = new Set<string>(extra.filter(Boolean));
  if (requestHost) hosts.add(requestHost.toLowerCase());
  const configured = process.env.CONTROL_PUBLIC_URL;
  if (configured) {
    try {
      hosts.add(new URL(configured).host.toLowerCase());
    } catch {
      // A malformed CONTROL_PUBLIC_URL must not silently widen the allow-list.
    }
  }
  return hosts;
}

/**
 * Convenience wrapper for route handlers: returns null when the request is
 * acceptable, or a ready-to-send 403 Response when it is not.
 */
export function csrfFailureResponse(request: Request, requestId?: string): Response | null {
  let host: string | null = null;
  try {
    host = new URL(request.url).host;
  } catch {
    host = request.headers.get("host");
  }
  const decision = verifyCsrf(request.method, request.headers, host);
  if (decision.ok) return null;
  return Response.json(
    { error: decision.reason, code: "csrf_rejected", ...(requestId ? { requestId } : {}) },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

export function verifyCsrf(
  method: string,
  headers: { get(name: string): string | null },
  requestHost: string | null,
): CsrfDecision {
  if (SAFE_METHODS.has(method.toUpperCase())) {
    return { ok: true, basis: "safe-method" };
  }

  const secFetchSite = headers.get("sec-fetch-site")?.toLowerCase() ?? null;
  if (secFetchSite !== null) {
    if (secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none") {
      return { ok: true, basis: "sec-fetch-site" };
    }
    return {
      ok: false,
      reason: `Cross-site request refused (Sec-Fetch-Site: ${secFetchSite}).`,
    };
  }

  const origin = headers.get("origin");
  const referer = headers.get("referer");
  const hosts = allowedHosts(requestHost);

  if (!origin && !referer) {
    // No browser context: curl, a server-side client, a native app. There is no
    // victim session to ride, so there is nothing to forge.
    return { ok: true, basis: "no-browser-context" };
  }

  for (const candidate of [origin, referer]) {
    if (!candidate) continue;
    try {
      const host = new URL(candidate).host.toLowerCase();
      if (hosts.has(host)) return { ok: true, basis: "origin-match" };
    } catch {
      // Fall through to the refusal below.
    }
  }

  return {
    ok: false,
    reason: "Origin does not match this deployment. Cross-origin state-changing requests are refused.",
  };
}
