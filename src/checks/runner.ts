// runCheck: dispatch to a registered probe, enforce the timeout, never throw.
import type { Monitor } from "../monitors/schema.js";
import { defaultCheckRegistry, type CheckRegistry, type CheckResult } from "./types.js";

/**
 * Runs the check for a monitor and always resolves to a CheckResult. The
 * monitor's timeout (seconds) is enforced even if the probe never settles;
 * `signal` lets the caller cancel early.
 */
export async function runCheck(
  monitor: Monitor,
  signal?: AbortSignal,
  registry: CheckRegistry = defaultCheckRegistry,
): Promise<CheckResult> {
  const checkedAt = Date.now();
  const started = performance.now();
  const timeoutMs = Math.round(monitor.timeout * 1000);
  const result = (status: CheckResult["status"], error: string | null, certExpiresAt: number | null = null): CheckResult => ({
    monitorId: monitor.id,
    status,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
    error,
    checkedAt,
    certExpiresAt,
  });

  const probe = registry.get(monitor.type);
  if (!probe) return result("down", `no check registered for type ${monitor.type}`);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(timeout.signal.aborted ? `timeout after ${timeoutMs} ms` : "check cancelled"));
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);

  try {
    const running = Promise.resolve().then(() => probe(monitor, combined));
    running.catch(() => undefined);
    const outcome = await Promise.race([running, aborted]);
    return result(outcome.status, outcome.status === "down" ? (outcome.error ?? "check failed") : null, outcome.certExpiresAt ?? null);
  } catch (error) {
    return result("down", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
  }
}
