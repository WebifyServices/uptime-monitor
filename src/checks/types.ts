// Shared check types and the registry that probes plug into.
import type { Monitor, MonitorType } from "../monitors/schema.js";

export type CheckStatus = "up" | "down";

/** The outcome of one check of one monitor; `checkedAt` is epoch milliseconds. */
export interface CheckResult {
  monitorId: string;
  status: CheckStatus;
  latencyMs: number;
  error: string | null;
  checkedAt: number;
  certExpiresAt: number | null;
}

/** What a probe reports; the runner adds the monitor id, latency and time. */
export interface ProbeOutcome {
  status: CheckStatus;
  error?: string | null;
  certExpiresAt?: number | null;
}

/** A check implementation. It should stop promptly when `signal` aborts and may throw. */
export type Probe = (monitor: Monitor, signal: AbortSignal) => Promise<ProbeOutcome>;

/** Maps a monitor type to the probe that checks it. */
export class CheckRegistry {
  private readonly probes = new Map<MonitorType, Probe>();

  register(type: MonitorType, probe: Probe): void {
    this.probes.set(type, probe);
  }

  get(type: MonitorType): Probe | undefined {
    return this.probes.get(type);
  }
}

/** The registry the HTTP, TCP and TLS checks register into. */
export const defaultCheckRegistry = new CheckRegistry();

/** Registers a probe for a monitor type in the default registry. */
export function registerCheck(type: MonitorType, probe: Probe): void {
  defaultCheckRegistry.register(type, probe);
}
