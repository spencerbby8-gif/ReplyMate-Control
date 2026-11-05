import { describe, expect, it } from "vitest";
import { SAFE_METHODS, allowedHosts, csrfFailureResponse, verifyCsrf } from "@/lib/auth/csrf";

/**
 * CSRF regression suite.
 *
 * Before this existed the only defence was `SameSite=Lax` on the session cookie,
 * which is a browser behaviour the server does not control. These tests pin the
 * explicit origin check that replaced it.
 */

function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

const HOST = "control.example.com";

describe("safe methods are exempt", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get", "head"])("allows %s without any origin header", (method) => {
    const decision = verifyCsrf(method, headers({}), HOST);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.basis).toBe("safe-method");
  });

  it("publishes exactly the three methods that may not mutate", () => {
    expect([...SAFE_METHODS].sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });
});

describe("Sec-Fetch-Site is trusted when present", () => {
  it.each(["same-origin", "same-site", "none"])("accepts %s", (value) => {
    const decision = verifyCsrf("POST", headers({ "sec-fetch-site": value }), HOST);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.basis).toBe("sec-fetch-site");
  });

  it.each(["cross-site", "same-site-ish", "CROSS-SITE"])("refuses %s", (value) => {
    const decision = verifyCsrf("POST", headers({ "sec-fetch-site": value.toLowerCase() }), HOST);
    if (value === "CROSS-SITE") {
      // Normalised to lowercase before comparison, so this is refused too.
      expect(decision.ok).toBe(false);
      return;
    }
    expect(decision.ok).toBe(false);
  });

  it("refuses cross-site even when a matching Origin is also supplied", () => {
    // Sec-Fetch-Site is the stronger signal: a forged Origin must not override it.
    const decision = verifyCsrf(
      "POST",
      headers({ "sec-fetch-site": "cross-site", origin: `https://${HOST}` }),
      HOST,
    );
    expect(decision.ok).toBe(false);
  });
});

describe("Origin fallback when Sec-Fetch-Site is absent", () => {
  it("accepts a same-host Origin", () => {
    const decision = verifyCsrf("POST", headers({ origin: `https://${HOST}` }), HOST);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.basis).toBe("origin-match");
  });

  it("accepts a same-host Referer with no Origin", () => {
    const decision = verifyCsrf("POST", headers({ referer: `https://${HOST}/dashboard` }), HOST);
    expect(decision.ok).toBe(true);
  });

  it("refuses a cross-origin Origin", () => {
    const decision = verifyCsrf("POST", headers({ origin: "https://evil.example" }), HOST);
    expect(decision.ok).toBe(false);
  });

  it("refuses when Origin and Referer disagree with the host", () => {
    const decision = verifyCsrf(
      "POST",
      headers({ origin: "https://evil.example", referer: "https://evil.example/attack" }),
      HOST,
    );
    expect(decision.ok).toBe(false);
  });

  it("is case-insensitive about the host", () => {
    const decision = verifyCsrf("POST", headers({ origin: `https://${HOST.toUpperCase()}` }), HOST);
    expect(decision.ok).toBe(true);
  });

  it("refuses a malformed Origin rather than failing open", () => {
    const decision = verifyCsrf("POST", headers({ origin: "not a url at all" }), HOST);
    expect(decision.ok).toBe(false);
  });

  it("accepts a non-browser client that sends neither header", () => {
    // curl and server-side clients have no victim session to ride.
    const decision = verifyCsrf("POST", headers({}), HOST);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.basis).toBe("no-browser-context");
  });
});

describe("allowed hosts", () => {
  it("always includes the request host", () => {
    expect(allowedHosts(HOST).has(HOST)).toBe(true);
  });

  it("includes CONTROL_PUBLIC_URL when it is a valid URL", () => {
    const previous = process.env.CONTROL_PUBLIC_URL;
    process.env.CONTROL_PUBLIC_URL = "https://admin.replymate.test";
    try {
      const hosts = allowedHosts(HOST);
      expect(hosts.has("admin.replymate.test")).toBe(true);
      expect(hosts.has(HOST)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CONTROL_PUBLIC_URL;
      else process.env.CONTROL_PUBLIC_URL = previous;
    }
  });

  it("ignores a malformed CONTROL_PUBLIC_URL instead of widening the allow-list", () => {
    const previous = process.env.CONTROL_PUBLIC_URL;
    process.env.CONTROL_PUBLIC_URL = "not-a-url";
    try {
      const hosts = allowedHosts(HOST);
      expect(hosts.size).toBe(1);
      expect(hosts.has(HOST)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CONTROL_PUBLIC_URL;
      else process.env.CONTROL_PUBLIC_URL = previous;
    }
  });

  it("drops empty extra hosts", () => {
    expect(allowedHosts(HOST, ["", ""]).size).toBe(1);
  });
});

describe("route-handler helper", () => {
  function makeRequest(init: { method: string; headers: Record<string, string> }) {
    return new Request("https://control.example.com/api/control", {
      method: init.method,
      headers: init.headers,
    });
  }

  it("returns null for an acceptable request", () => {
    expect(csrfFailureResponse(makeRequest({ method: "POST", headers: { "sec-fetch-site": "same-origin" } }))).toBeNull();
  });

  it("returns a 403 JSON response for a cross-site request", () => {
    const response = csrfFailureResponse(
      makeRequest({ method: "POST", headers: { "sec-fetch-site": "cross-site" } }),
      "req-123",
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("carries the request id so a refusal can be traced to its audit row", async () => {
    const response = csrfFailureResponse(
      makeRequest({ method: "POST", headers: { origin: "https://evil.example" } }),
      "req-trace-1",
    );
    const body = (await response?.json()) as { code: string; requestId: string };
    expect(body.code).toBe("csrf_rejected");
    expect(body.requestId).toBe("req-trace-1");
  });

  it("never blocks GET", () => {
    expect(csrfFailureResponse(makeRequest({ method: "GET", headers: {} }))).toBeNull();
  });
});
