// Test helper: a real SQLite file in a fresh temporary directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "uptime-db-")), "test.sqlite");
}
