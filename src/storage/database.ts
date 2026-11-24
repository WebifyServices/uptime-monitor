// Opens the SQLite file and brings its schema to the latest migration.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrations as builtInMigrations, type Migration } from "./migrations.js";

export type Db = Database.Database;

export class MigrationError extends Error {
  constructor(readonly version: number, cause: unknown) {
    super(`migration ${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "MigrationError";
  }
}

/** Applies every migration newer than the recorded schema_version, each in its own transaction. */
export function applyMigrations(db: Db, migrations: readonly Migration[]): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null };
  const current = row.version ?? 0;
  const applied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(migration.version, Date.now());
    });
    try {
      run();
    } catch (error) {
      throw new MigrationError(migration.version, error);
    }
    applied.push(migration.version);
  }
  return applied;
}

/** Opens (creating if needed) the database at `path` with WAL and foreign keys on, and migrates it. */
export function openDatabase(path: string, migrations: readonly Migration[] = builtInMigrations): Db {
  if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
