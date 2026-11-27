// Monitors persisted in SQLite, from the config file and from runtime additions.
import type { Db } from "../storage/database.js";
import { monitorSchema, type Monitor } from "./schema.js";

export type MonitorSource = "config" | "runtime";
export type MonitorRecord = Monitor & { source: MonitorSource };

export class MonitorExistsError extends Error {
  constructor(readonly id: string) {
    super(`a monitor with id "${id}" already exists`);
    this.name = "MonitorExistsError";
  }
}

export class ConfigMonitorRemovalError extends Error {
  constructor(readonly id: string) {
    super(`monitor "${id}" is defined in the config file; edit the config file to remove it`);
    this.name = "ConfigMonitorRemovalError";
  }
}

export class ConfigMonitorConflictError extends Error {
  constructor(readonly id: string) {
    super(`config monitor "${id}" has the same id as a monitor added at runtime; rename one of them`);
    this.name = "ConfigMonitorConflictError";
  }
}

export interface SyncSummary {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface MonitorRepository {
  /** Stores a new runtime monitor; throws MonitorExistsError on an id clash. */
  add(monitor: Monitor): MonitorRecord;
  get(id: string): MonitorRecord | undefined;
  /** All monitors, oldest first. */
  list(): MonitorRecord[];
  /** Removes a runtime monitor; refuses config monitors. Returns false when the id is unknown. */
  remove(id: string): boolean;
  /** Makes the config-sourced monitors equal to `monitors`; runtime monitors are untouched. */
  syncConfig(monitors: readonly Monitor[]): SyncSummary;
  /** Calls `listener` once after every change; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

interface Row {
  id: string;
  source: MonitorSource;
  definition: string;
}

function toRecord(row: Row): MonitorRecord {
  return { ...monitorSchema.parse(JSON.parse(row.definition)), source: row.source };
}

function serialize(monitor: Monitor): string {
  return JSON.stringify(Object.fromEntries(Object.entries(monitor).filter(([key]) => key !== "source")));
}

/** Creates the repository over an open database. */
export function createMonitorRepository(db: Db): MonitorRepository {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const selectOne = db.prepare("SELECT id, source, definition FROM monitors WHERE id = ?");
  const selectAll = db.prepare("SELECT id, source, definition FROM monitors ORDER BY created_at, rowid");
  const insert = db.prepare("INSERT INTO monitors (id, source, enabled, definition, created_at) VALUES (?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE monitors SET source = 'config', enabled = ?, definition = ? WHERE id = ?");
  const del = db.prepare("DELETE FROM monitors WHERE id = ?");

  return {
    add(monitor) {
      if (selectOne.get(monitor.id)) throw new MonitorExistsError(monitor.id);
      insert.run(monitor.id, "runtime", monitor.enabled ? 1 : 0, serialize(monitor), Date.now());
      notify();
      return { ...monitor, source: "runtime" };
    },
    get(id) {
      const row = selectOne.get(id) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },
    list() {
      return (selectAll.all() as Row[]).map(toRecord);
    },
    remove(id) {
      const row = selectOne.get(id) as Row | undefined;
      if (!row) return false;
      if (row.source === "config") throw new ConfigMonitorRemovalError(id);
      del.run(id);
      notify();
      return true;
    },
    syncConfig(monitors) {
      const summary: SyncSummary = { added: [], updated: [], removed: [] };
      db.transaction(() => {
        const wanted = new Set(monitors.map((m) => m.id));
        for (const monitor of monitors) {
          const existing = selectOne.get(monitor.id) as Row | undefined;
          if (existing && existing.source !== "config") throw new ConfigMonitorConflictError(monitor.id);
          const definition = serialize(monitor);
          if (!existing) {
            insert.run(monitor.id, "config", monitor.enabled ? 1 : 0, definition, Date.now());
            summary.added.push(monitor.id);
          } else if (existing.definition !== definition) {
            update.run(monitor.enabled ? 1 : 0, definition, monitor.id);
            summary.updated.push(monitor.id);
          }
        }
        for (const row of selectAll.all() as Row[]) {
          if (row.source === "config" && !wanted.has(row.id)) {
            del.run(row.id);
            summary.removed.push(row.id);
          }
        }
      })();
      if (summary.added.length + summary.updated.length + summary.removed.length > 0) notify();
      return summary;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
