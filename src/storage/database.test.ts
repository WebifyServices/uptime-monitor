import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError, applyMigrations, openDatabase, type Db } from "./database.js";
import { tempDbPath } from "./test-db.js";

const open: Db[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});
const track = (db: Db): Db => {
  open.push(db);
  return db;
};

const tables = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("openDatabase", () => {
  it("creates every table on a new path and applies nothing on an up-to-date database", () => {
    const path = tempDbPath();
    const db = track(openDatabase(path));
    expect(tables(db)).toEqual(["alert_deliveries", "check_results", "daily_uptime", "incidents", "monitors", "schema_version"]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
    open.pop();

    const again = track(openDatabase(path));
    expect(again.prepare("SELECT COUNT(*) AS n FROM schema_version").get()).toEqual({ n: 1 });
  });

  it("creates missing parent directories for a new database path", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uptime-db-")), "data", "nested", "uptime.sqlite");
    const db = openDatabase(path);
    db.close();
    expect(existsSync(path)).toBe(true);
  });

  it("rolls back a failing migration and names its number", () => {
    const db = track(openDatabase(tempDbPath()));
    const migrations = [
      { version: 1, sql: "CREATE TABLE a (x INTEGER)" },
      { version: 2, sql: "CREATE TABLE b (x INTEGER); INSERT INTO missing_table VALUES (1);" },
    ];
    const fresh = track(openDatabase(tempDbPath(), [migrations[0]!]));
    let error: unknown;
    try {
      applyMigrations(fresh, migrations);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/migration 2/);
    expect(tables(fresh)).not.toContain("b");
    expect(fresh.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 1 });
    expect(db).toBeDefined();
  });

  it("deletes a monitor's results, incidents and daily rollups by cascade", () => {
    const db = track(openDatabase(tempDbPath()));
    db.prepare("INSERT INTO monitors (id, source, enabled, definition, created_at) VALUES ('m', 'runtime', 1, '{}', 0)").run();
    db.prepare("INSERT INTO check_results (monitor_id, checked_at, status, latency_ms) VALUES ('m', 1, 'up', 5)").run();
    db.prepare("INSERT INTO incidents (monitor_id, started_at) VALUES ('m', 1)").run();
    db.prepare("INSERT INTO daily_uptime (monitor_id, day, up_count, total_count) VALUES ('m', '2026-01-01', 1, 1)").run();
    db.prepare("DELETE FROM monitors WHERE id = 'm'").run();
    for (const table of ["check_results", "incidents", "daily_uptime"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
});
