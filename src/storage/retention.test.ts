import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMonitorRepository } from "../monitors/repository.js";
import { parseMonitor } from "../monitors/schema.js";
import { openDatabase, type Db } from "./database.js";
import { DAY_MS } from "./days.js";
import { createResultStore, type ResultStore } from "./result-store.js";
import { createRetention } from "./retention.js";
import { tempDbPath } from "./test-db.js";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

let db: Db;
let store: ResultStore;
beforeEach(() => {
  db = openDatabase(tempDbPath());
  createMonitorRepository(db).add(parseMonitor({ name: "a", url: "https://example.com" }));
  store = createResultStore(db);
});
afterEach(() => db.close());

const record = (checkedAt: number, status: "up" | "down", latencyMs: number): void =>
  store.recordResult({ monitorId: "a", status, latencyMs, error: null, checkedAt, certExpiresAt: null });

const rollups = (): unknown[] => db.prepare("SELECT * FROM daily_uptime ORDER BY day").all();
const latencies = (): unknown[] => db.prepare("SELECT * FROM daily_latency ORDER BY day").all();
const rawCount = (): number => (db.prepare("SELECT COUNT(*) AS n FROM check_results").get() as { n: number }).n;

describe("retention", () => {
  it("rolls completed days into counts and average latency, leaving today raw", () => {
    record(NOW - DAY_MS, "up", 10);
    record(NOW - DAY_MS + 1000, "down", 30);
    record(NOW - DAY_MS + 2000, "up", 20);
    record(NOW, "up", 5);
    const summary = createRetention(db).run(NOW);
    expect(summary.rolledUp).toBe(1);
    expect(rollups()).toEqual([{ monitor_id: "a", day: "2026-06-14", up_count: 2, total_count: 3 }]);
    expect(latencies()).toEqual([{ monitor_id: "a", day: "2026-06-14", avg_latency_ms: 20 }]);
  });

  it("produces the same rows when run twice", () => {
    record(NOW - DAY_MS, "up", 10);
    record(NOW - 40 * DAY_MS, "down", 10);
    const retention = createRetention(db);
    retention.run(NOW);
    const first = { r: rollups(), l: latencies(), raw: rawCount() };
    retention.run(NOW);
    retention.run(NOW + 1000);
    expect({ r: rollups(), l: latencies(), raw: rawCount() }).toEqual(first);
  });

  it("deletes raw results older than the window only after rolling their day up", () => {
    record(NOW - 45 * DAY_MS, "up", 10);
    record(NOW - 45 * DAY_MS + 1000, "down", 10);
    record(NOW - 10 * DAY_MS, "up", 10);
    const summary = createRetention(db).run(NOW);
    expect(summary.rawDeleted).toBe(2);
    expect(rawCount()).toBe(1);
    expect(rollups()).toEqual([
      { monitor_id: "a", day: "2026-05-01", up_count: 1, total_count: 2 },
      { monitor_id: "a", day: "2026-06-05", up_count: 1, total_count: 1 },
    ]);
  });

  it("writes no rollup row for days without results, and prunes rollups past their window", () => {
    record(NOW - 3 * DAY_MS, "up", 10);
    expect(createRetention(db).run(NOW).rolledUp).toBe(1);
    expect(rollups()).toHaveLength(1);
    db.prepare("INSERT INTO daily_uptime VALUES ('a', '2025-01-01', 1, 1)").run();
    db.prepare("INSERT INTO daily_latency VALUES ('a', '2025-01-01', 1)").run();
    expect(createRetention(db).run(NOW).rollupsDeleted).toBe(1);
    expect(rollups()).toHaveLength(1);
    expect(latencies()).toHaveLength(1);
  });

  it("honors custom windows", () => {
    record(NOW - 5 * DAY_MS, "up", 10);
    createRetention(db, { rawRetentionDays: 2 }).run(NOW);
    expect(rawCount()).toBe(0);
    expect(rollups()).toHaveLength(1);
  });

  it("runs at start and on its interval, and stops", async () => {
    record(Date.now() - 2 * DAY_MS, "up", 10);
    const retention = createRetention(db, { intervalMs: 20 });
    retention.start();
    expect(rollups()).toHaveLength(1);
    db.prepare("DELETE FROM daily_uptime").run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rollups()).toHaveLength(1);
    retention.stop();
    db.prepare("DELETE FROM daily_uptime").run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rollups()).toHaveLength(0);
  });
});
