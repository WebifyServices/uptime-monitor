import { describe, expect, it } from "vitest";
import { MonitorValidationError, parseMonitor, splitTarget, type Monitor } from "./schema.js";

describe("parseMonitor", () => {
  it("fills the documented defaults for a minimal HTTP monitor", () => {
    const monitor = parseMonitor({ name: "My Site", url: "https://example.com" });
    expect(monitor).toMatchObject({
      id: "my-site",
      type: "http",
      target: "https://example.com",
      interval: 60,
      timeout: 10,
      enabled: true,
      tags: [],
      http: { method: "GET", expectedStatus: [{ from: 200, to: 399 }] },
      thresholds: { failuresBeforeDown: 3, successesBeforeRecovered: 2 },
    });
  });

  it("keeps an explicit id and parses status codes and ranges", () => {
    const monitor = parseMonitor({
      id: "api",
      name: "API",
      target: "https://example.com/health",
      http: { expectedStatus: [200, "301-302"], bodyContains: "ok" },
    });
    expect(monitor.id).toBe("api");
    expect(monitor.http?.expectedStatus).toEqual([
      { from: 200, to: 200 },
      { from: 301, to: 302 },
    ]);
    expect(monitor.http?.bodyContains).toBe("ok");
  });

  it("defaults TLS options for a tls monitor", () => {
    const monitor = parseMonitor({ name: "Cert", type: "tls", target: "example.com" });
    expect(monitor.tls).toEqual({ warnDays: 14, allowSelfSigned: false });
    expect(monitor.http).toBeUndefined();
  });

  function issuesFor(input: unknown): string {
    try {
      parseMonitor(input);
    } catch (error) {
      expect(error).toBeInstanceOf(MonitorValidationError);
      return (error as Error).message;
    }
    throw new Error("expected parseMonitor to throw");
  }

  it("rejects an interval below 10 seconds, naming the field", () => {
    expect(issuesFor({ name: "x", url: "https://example.com", interval: 5, timeout: 2 })).toMatch(/interval/);
  });

  it("rejects an interval longer than a day, so no timer overflows", () => {
    expect(issuesFor({ name: "x", url: "https://example.com", interval: 3_000_000, timeout: 2_200_000 })).toMatch(/interval/);
  });

  it("rejects a timeout that is not shorter than the interval", () => {
    expect(issuesFor({ name: "x", url: "https://example.com", interval: 20, timeout: 20 })).toMatch(/timeout/);
  });

  it("rejects an unknown type", () => {
    expect(issuesFor({ name: "x", type: "icmp", target: "example.com" })).toMatch(/type/);
  });

  it("rejects a malformed explicit TLS port but accepts an omitted one", () => {
    expect(issuesFor({ name: "x", type: "tls", target: "example.com:100000" })).toMatch(/target/);
    expect(issuesFor({ name: "x", type: "tls", target: "example.com:abc" })).toMatch(/target/);
    expect(parseMonitor({ name: "x", type: "tls", target: "example.com" }).target).toBe("example.com");
    expect(parseMonitor({ name: "x", type: "tls", target: "example.com:8443" }).target).toBe("example.com:8443");
  });

  it("accepts IPv6 TLS and TCP targets, bracketed with or without a port", () => {
    expect(parseMonitor({ name: "x", type: "tls", target: "[::1]" }).target).toBe("[::1]");
    expect(parseMonitor({ name: "x", type: "tls", target: "[::1]:8443" }).target).toBe("[::1]:8443");
    expect(parseMonitor({ name: "x", type: "tcp", target: "[2001:db8::1]:5432" }).target).toBe("[2001:db8::1]:5432");
    expect(issuesFor({ name: "x", type: "tls", target: "[::1]:abc" })).toMatch(/target/);
    expect(issuesFor({ name: "x", type: "tls", target: "[::1" })).toMatch(/target/);
    expect(issuesFor({ name: "x", type: "tcp", target: "[::1]" })).toMatch(/target/);
  });

  it("splits a target into host and port", () => {
    expect(splitTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(splitTarget("example.com")).toEqual({ host: "example.com", port: null });
    expect(splitTarget("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
    expect(splitTarget("[::1]")).toEqual({ host: "::1", port: null });
  });

  it("rejects a TCP target without a port", () => {
    expect(issuesFor({ name: "x", type: "tcp", target: "example.com" })).toMatch(/target/);
  });

  it("rejects a non-http URL for an http monitor", () => {
    expect(issuesFor({ name: "x", url: "ftp://example.com" })).toMatch(/target/);
  });

  it("rejects an id that is not a slug", () => {
    expect(issuesFor({ id: "Bad Id", name: "x", url: "https://example.com" })).toMatch(/id/);
  });

  it("rejects a name that yields no slug when no id is given", () => {
    expect(issuesFor({ name: "!!!", url: "https://example.com" })).toMatch(/id/);
  });

  it("infers the Monitor type from the schema", () => {
    const monitor: Monitor = parseMonitor({ name: "x", url: "https://example.com" });
    const interval: number = monitor.interval;
    expect(interval).toBe(60);
  });
});
