import { describe, expect, it } from "vitest";
import { parseMonitor } from "../monitors/schema.js";
import { runCheck } from "./runner.js";
import { CheckRegistry, type Probe } from "./types.js";

const monitor = parseMonitor({ name: "m", url: "https://example.com", interval: 10, timeout: 1 });

function registryWith(probe: Probe): CheckRegistry {
  const registry = new CheckRegistry();
  registry.register("http", probe);
  return registry;
}

describe("runCheck", () => {
  it("returns the probe's outcome as a CheckResult", async () => {
    const result = await runCheck(monitor, undefined, registryWith(async () => ({ status: "up", certExpiresAt: 123 })));
    expect(result).toMatchObject({ monitorId: "m", status: "up", error: null, certExpiresAt: 123 });
    expect(result.checkedAt).toBeGreaterThan(0);
  });

  it("dispatches by monitor type", async () => {
    const registry = new CheckRegistry();
    registry.register("tcp", async () => ({ status: "down", error: "refused" }));
    const tcp = parseMonitor({ name: "t", type: "tcp", target: "localhost:1" });
    expect(await runCheck(tcp, undefined, registry)).toMatchObject({ status: "down", error: "refused" });
    expect(await runCheck(monitor, undefined, registry)).toMatchObject({ status: "down", error: "no check registered for type http" });
  });

  it("returns a down result for a probe that never settles, within the timeout plus one second", async () => {
    const started = performance.now();
    const result = await runCheck(monitor, undefined, registryWith(() => new Promise(() => undefined)));
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ status: "down", error: "timeout after 1000 ms" });
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns a down result carrying the message of a probe that throws", async () => {
    const result = await runCheck(monitor, undefined, registryWith(async () => {
      throw new Error("boom");
    }));
    expect(result).toMatchObject({ status: "down", error: "boom" });
  });

  it("handles a probe that throws synchronously", async () => {
    const result = await runCheck(monitor, undefined, registryWith(() => {
      throw new Error("sync boom");
    }));
    expect(result).toMatchObject({ status: "down", error: "sync boom" });
  });

  it("measures latency with a monotonic clock", async () => {
    const result = await runCheck(monitor, undefined, registryWith(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: "up" };
    }));
    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    expect(result.latencyMs).toBeLessThan(500);
  });

  it("gives the probe a signal that aborts at the timeout", async () => {
    let aborted = false;
    await runCheck(monitor, undefined, registryWith((_m, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("late"));
      });
    })));
    expect(aborted).toBe(true);
  });

  it("never starts the probe when the caller's signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await runCheck(monitor, controller.signal, registryWith(() => {
      calls += 1;
      return Promise.resolve({ status: "up" });
    }));
    expect(outcome).toMatchObject({ status: "down", error: "check cancelled" });
    expect(calls).toBe(0);
  });

  it("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const pending = runCheck(monitor, controller.signal, registryWith(() => new Promise(() => undefined)));
    controller.abort();
    expect(await pending).toMatchObject({ status: "down", error: "check cancelled" });
  });
});
