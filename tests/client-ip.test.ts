import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientIp, trustProxyMode } from "@/lib/http";

/**
 * Proxy-aware client IP resolution.
 *
 * The IP feeds the login throttle, so getting it wrong is a security property,
 * not a cosmetic one. Taking the leftmost X-Forwarded-For entry unconditionally
 * lets a client spoof a fresh source per attempt and walk straight around the
 * per-source limit.
 */

function req(headers: Record<string, string>): Request {
  return new Request("https://control.example.com/api/auth/login", { method: "POST", headers });
}

const previous = process.env.TRUST_PROXY;
afterEach(() => {
  if (previous === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previous;
});
beforeEach(() => {
  delete process.env.TRUST_PROXY;
});

describe("mode resolution", () => {
  it("defaults to overwrite, which cannot be widened by a client", () => {
    expect(trustProxyMode()).toBe("overwrite");
  });

  it.each(["none", "append", "overwrite"])("accepts %s", (mode) => {
    process.env.TRUST_PROXY = mode;
    expect(trustProxyMode()).toBe(mode);
  });

  it("falls back to overwrite on an unrecognised value", () => {
    process.env.TRUST_PROXY = "whatever";
    expect(trustProxyMode()).toBe("overwrite");
  });

  it("is case- and whitespace-insensitive", () => {
    process.env.TRUST_PROXY = "  APPEND ";
    expect(trustProxyMode()).toBe("append");
  });
});

describe("overwrite mode (the default, and what this platform does)", () => {
  it("takes the leftmost entry, which the proxy itself wrote", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip then cf-connecting-ip", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({ "cf-connecting-ip": "192.0.2.7" }))).toBe("192.0.2.7");
  });

  it("prefers x-forwarded-for over x-real-ip", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.4" }))).toBe("203.0.113.9");
  });

  it("returns null when nothing identifies the source", () => {
    expect(clientIp(req({}))).toBeNull();
  });
});

describe("append mode (a proxy chain that appends)", () => {
  beforeEach(() => {
    process.env.TRUST_PROXY = "append";
  });

  it("takes the LAST entry, which our own proxy wrote and a client cannot forge", () => {
    expect(clientIp(req({ "x-forwarded-for": "spoofed.by.client, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("does not let a client mint a fresh source per attempt", () => {
    // The attack: vary the leftmost value on every request. In append mode the
    // throttle sees one stable source regardless.
    const seen = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((spoof) => clientIp(req({ "x-forwarded-for": `${spoof}, 203.0.113.9` }))),
    );
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe("203.0.113.9");
  });

  it("handles a single entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("none mode (no proxy; headers are client-controlled)", () => {
  beforeEach(() => {
    process.env.TRUST_PROXY = "none";
  });

  it("ignores x-forwarded-for entirely", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
  });

  it("still accepts a platform-set real-ip header", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });
});

describe("malformed input never throws", () => {
  it.each([",", " , , ", ",,", "   "])(
    "survives a junk x-forwarded-for value %j",
    (value) => {
      expect(() => clientIp(req({ "x-forwarded-for": value }))).not.toThrow();
    },
  );

  it("returns null rather than an empty string for a comma-only header", () => {
    expect(clientIp(req({ "x-forwarded-for": ",,," }))).toBeNull();
  });
});
