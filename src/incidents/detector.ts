// Turns the stream of check results into per-monitor state and incidents, emitting IncidentEvent on each transition.
import type { CheckResult } from "../checks/types.js";
import type { Incident, ResultStore } from "../storage/result-store.js";

export type DetectorState = "up" | "down" | "unknown";

/** How many consecutive results flip a monitor down, and back up. */
export interface Thresholds {
  failuresBeforeDown: number;
  successesBeforeRecovered: number;
}

/**
 * Emitted once when an incident opens and once when it resolves.
 * `incident` is the stored record as it stands after the transition;
 * `result` is the check result that caused it.
 */
export type IncidentEvent =
  | { type: "opened"; monitorId: string; incident: Incident; result: CheckResult }
  | { type: "resolved"; monitorId: string; incident: Incident; result: CheckResult };

export type IncidentListener = (event: IncidentEvent) => void;

export interface MonitorCounters {
  state: DetectorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export interface IncidentDetector {
  /**
   * Rebuilds a monitor's state from its open incident and recent stored results.
   * Call once per monitor at startup, before new results arrive; emits nothing.
   */
  restore(monitorId: string, thresholds: Thresholds): MonitorCounters;
  /**
   * Feeds one check result (already recorded or not; the detector never writes results).
   * Returns the event it caused, if any, after also passing it to every listener.
   */
  handleResult(result: CheckResult, thresholds: Thresholds): IncidentEvent | undefined;
  getState(monitorId: string): MonitorCounters;
  /** Calls `listener` for every event; returns an unsubscribe function. */
  subscribe(listener: IncidentListener): () => void;
}

const UNKNOWN: MonitorCounters = { state: "unknown", consecutiveFailures: 0, consecutiveSuccesses: 0 };

function streak(results: readonly CheckResult[], status: CheckResult["status"]): number {
  let count = 0;
  for (const result of results) {
    if (result.status !== status) break;
    count++;
  }
  return count;
}

/** Creates a detector that persists incidents through the result store. */
export function createIncidentDetector(store: ResultStore): IncidentDetector {
  const counters = new Map<string, MonitorCounters>();
  const listeners = new Set<IncidentListener>();

  const emit = (event: IncidentEvent): IncidentEvent => {
    for (const listener of [...listeners]) listener(event);
    return event;
  };

  return {
    restore(monitorId, thresholds) {
      const recent = store.recentResults(monitorId, Math.max(thresholds.failuresBeforeDown, thresholds.successesBeforeRecovered));
      const open = store.getOpenIncident(monitorId);
      const restored: MonitorCounters = {
        state: open ? "down" : recent.length > 0 ? "up" : "unknown",
        consecutiveFailures: streak(recent, "down"),
        consecutiveSuccesses: streak(recent, "up"),
      };
      counters.set(monitorId, restored);
      return { ...restored };
    },
    handleResult(result, thresholds) {
      const current = counters.get(result.monitorId) ?? { ...UNKNOWN };
      counters.set(result.monitorId, current);

      if (result.status === "down") {
        current.consecutiveFailures++;
        current.consecutiveSuccesses = 0;
        if (current.state === "down" || current.consecutiveFailures < thresholds.failuresBeforeDown) return undefined;
        current.state = "down";
        const existing = store.getOpenIncident(result.monitorId);
        if (existing) return undefined;
        const incident = store.openIncident(result.monitorId, result.error, result.checkedAt);
        return emit({ type: "opened", monitorId: result.monitorId, incident, result });
      }

      current.consecutiveSuccesses++;
      current.consecutiveFailures = 0;
      if (current.state === "unknown") current.state = "up";
      if (current.state !== "down" || current.consecutiveSuccesses < thresholds.successesBeforeRecovered) return undefined;
      current.state = "up";
      const incident = store.resolveIncident(result.monitorId, result.checkedAt);
      if (!incident) return undefined;
      return emit({ type: "resolved", monitorId: result.monitorId, incident, result });
    },
    getState(monitorId) {
      return { ...(counters.get(monitorId) ?? UNKNOWN) };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
