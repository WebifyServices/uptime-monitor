// Numbered SQL migrations; append new entries, never edit an applied one.
export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE monitors (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('config', 'runtime')),
        enabled INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        checked_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('up', 'down')),
        latency_ms REAL NOT NULL,
        error TEXT,
        cert_expires_at INTEGER
      );
      CREATE INDEX idx_check_results_monitor_time ON check_results (monitor_id, checked_at DESC);

      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        resolved_at INTEGER,
        first_error TEXT
      );
      CREATE INDEX idx_incidents_monitor_time ON incidents (monitor_id, started_at DESC);
      CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (monitor_id) WHERE resolved_at IS NULL;

      CREATE TABLE daily_uptime (
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        up_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        PRIMARY KEY (monitor_id, day)
      );

      CREATE TABLE alert_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        notifier TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('down', 'recovered')),
        attempted_at INTEGER NOT NULL,
        success INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX idx_alert_deliveries_incident ON alert_deliveries (incident_id);
    `,
  },
];
