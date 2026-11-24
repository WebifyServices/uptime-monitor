// Check results and incident records.
import type { CheckResult } from "../checks/types.js";
import type { Db } from "./database.js";

/** An outage window for one monitor; `resolvedAt` is null while it is open. */
export interface Incident {
  id: number;
  monitorId: string;
  startedAt: number;
  resolvedAt: number | null;
  firstError: string | null;
}

export class IncidentAlreadyOpenError extends Error {
  constructor(readonly monitorId: string) {
    super(`monitor "${monitorId}" already has an open incident`);
    this.name = "IncidentAlreadyOpenError";
  }
}

export interface ResultStore {
  recordResult(result: CheckResult): void;
  /** Newest first. */
  recentResults(monitorId: string, limit: number): CheckResult[];
  /** Opens an incident; throws IncidentAlreadyOpenError if one is already open. */
  openIncident(monitorId: string, firstError: string | null, startedAt?: number): Incident;
  /** Resolves the open incident and returns it; undefined (and no change) when none is open. */
  resolveIncident(monitorId: string, resolvedAt?: number): Incident | undefined;
  getOpenIncident(monitorId: string): Incident | undefined;
}

interface ResultRow {
  monitor_id: string;
  checked_at: number;
  status: "up" | "down";
  latency_ms: number;
  error: string | null;
  cert_expires_at: number | null;
}

interface IncidentRow {
  id: number;
  monitor_id: string;
  started_at: number;
  resolved_at: number | null;
  first_error: string | null;
}

const toIncident = (row: IncidentRow): Incident => ({
  id: row.id,
  monitorId: row.monitor_id,
  startedAt: row.started_at,
  resolvedAt: row.resolved_at,
  firstError: row.first_error,
});

/** Creates the store over an open, migrated database. */
export function createResultStore(db: Db): ResultStore {
  const insertResult = db.prepare(
    "INSERT INTO check_results (monitor_id, checked_at, status, latency_ms, error, cert_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectResults = db.prepare(
    "SELECT monitor_id, checked_at, status, latency_ms, error, cert_expires_at FROM check_results WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?",
  );
  const selectOpen = db.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL");
  const insertIncident = db.prepare("INSERT INTO incidents (monitor_id, started_at, first_error) VALUES (?, ?, ?)");
  const closeIncident = db.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?");
  const selectIncident = db.prepare("SELECT * FROM incidents WHERE id = ?");

  return {
    recordResult(result) {
      insertResult.run(result.monitorId, result.checkedAt, result.status, result.latencyMs, result.error, result.certExpiresAt);
    },
    recentResults(monitorId, limit) {
      return (selectResults.all(monitorId, limit) as ResultRow[]).map((row) => ({
        monitorId: row.monitor_id,
        status: row.status,
        latencyMs: row.latency_ms,
        error: row.error,
        checkedAt: row.checked_at,
        certExpiresAt: row.cert_expires_at,
      }));
    },
    openIncident(monitorId, firstError, startedAt = Date.now()) {
      if (selectOpen.get(monitorId)) throw new IncidentAlreadyOpenError(monitorId);
      const { lastInsertRowid } = insertIncident.run(monitorId, startedAt, firstError);
      return toIncident(selectIncident.get(lastInsertRowid) as IncidentRow);
    },
    resolveIncident(monitorId, resolvedAt = Date.now()) {
      const open = selectOpen.get(monitorId) as IncidentRow | undefined;
      if (!open) return undefined;
      closeIncident.run(resolvedAt, open.id);
      return toIncident(selectIncident.get(open.id) as IncidentRow);
    },
    getOpenIncident(monitorId) {
      const row = selectOpen.get(monitorId) as IncidentRow | undefined;
      return row ? toIncident(row) : undefined;
    },
  };
}
