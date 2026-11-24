import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../checks/types.js";
import { createMonitorRepository, type MonitorRepository } from "../monitors/repository.js";
import { parseMonitor } from "../monitors/schema.js";
import { openDatabase, type Db } from "./database.js";
import { DAY_MS } from "./days.js";
import { createResultStore, type ResultStore } from "./result-store.js";
import { createStatusQueries, type StatusQueries } from "./status-queries.js";
import { tempDbPath } from "./test-db.js";

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

let db: Db;
let repo: MonitorRepository;
let store: ResultStore;
let queries: StatusQueries;
beforeEach(() => {
  db = openDatabase(tempDbPath());
  repo = createMonitorRepository(db);
  repo.add(parseMonitor({ name: "a", url: "https://example.com" }));
  repo.add(parseMonitor({ name: "b", url: "https://example.com", enabled: false }));
  repo.add(parseMonitor({ name: "c", url: "https://example.com" }));
  store = createResultStore(db);
  queries = createStatusQueries(db, repo);
});
afterEach(() => db.close());

const rollup = (day: string, up: number, total: number): void => {
  db.prepare("INSERT INTO daily_uptime (monitor_id, day, up_count, total_count) VALUES ('a', ?, ?, ?)").run(day, up, total);
};

const record = (monitorId: string, checkedAt: number, status: "up" | "down", latencyMs = 10): void =>
  store.recordResult({ monitorId, status, latencyMs, error: status === "down" ? "boom" : null, checkedAt, certExpiresAt: null } satisfies CheckResult);

describe("status queries", () => {
  it("reports a monitor with no results as unknown with no uptime figure, and skips disabled monitors", () => {
    const overview = queries.getStatusOverview(NOW);
    expect(overview.map((m) => m.monitorId)).toEqual(["a", "c"]);
    expect(overview[0]).toMatchObject({
      state: "unknown",
      lastCheckedAt: null,
      latencyMs: null,
      openIncident: null,
      uptime: { last24h: null, last7d: null, last30d: null, last90d: null },
    });
  });

  it("combines daily rollups with unrolled raw results and matches a hand-computed fixture", () => {
    rollup("2026-05-06", 90, 100);
    rollup("2026-06-13", 95, 100);
    for (let i = 0; i < 50; i++) record("a", NOW - 3600_000 + i * 1000, i < 49 ? "up" : "down");
    record("a", NOW - 30 * 3600_000, "down");

    const { uptime } = queries.getStatusOverview(NOW)[0]!;
    expect(uptime.last24h).toBe(98);
    expect(uptime.last7d).toBe(round((95 + 49) / 151));
    expect(uptime.last30d).toBe(round((95 + 49) / 151));
    expect(uptime.last90d).toBe(round((90 + 95 + 49) / 251));
  });

  it("leaves rollups after the window's last day out of its uptime", () => {
    rollup("2026-06-13", 1, 1);
    rollup("2026-06-14", 0, 1);
    const endOf13th = Date.UTC(2026, 5, 13, 18, 0, 0);
    expect(queries.getUptimePercent("a", 1, endOf13th)).toBe(100);
  });

  it("does not double count a rolled-up day whose raw results still exist", () => {
    for (let i = 0; i < 10; i++) record("a", NOW - DAY_MS + i * 1000, i < 9 ? "up" : "down");
    rollup("2026-06-14", 5, 10);
    expect(queries.getUptimePercent("a", 7, NOW)).toBe(50);
  });

  it("returns exactly N daily entries, oldest first, null on days without data", () => {
    record("a", NOW, "up");
    record("a", NOW - DAY_MS, "down");
    const days = queries.getDailyUptime("a", 90, NOW);
    expect(days).toHaveLength(90);
    expect(days[0]).toMatchObject({ day: "2026-03-18", uptimePercent: null, totalCount: 0 });
    expect(days[88]).toMatchObject({ day: "2026-06-14", uptimePercent: 0, totalCount: 1 });
    expect(days[89]).toMatchObject({ day: "2026-06-15", uptimePercent: 100, upCount: 1 });
    expect(days.filter((d) => d.uptimePercent !== null)).toHaveLength(2);
  });

  it("derives state, last check and open incident, and lists recent incidents newest first", () => {
    record("a", NOW - 5000, "up", 7);
    record("c", NOW - 2000, "down", 9);
    store.openIncident("c", "boom", NOW - 2000);
    const resolved = store.openIncident("a", "old", NOW - 9000);
    store.resolveIncident("a", NOW - 8000);
    const [a, c] = queries.getStatusOverview(NOW);
    expect(a).toMatchObject({ state: "up", lastCheckedAt: NOW - 5000, latencyMs: 7, openIncident: null });
    expect(c?.state).toBe("down");
    expect(c?.openIncident?.firstError).toBe("boom");
    expect(queries.recentIncidents(10).map((i) => i.monitorId)).toEqual(["c", "a"]);
    expect(queries.recentIncidents(1)).toHaveLength(1);
    expect(queries.recentIncidents(10, "a")).toEqual([{ ...resolved, resolvedAt: NOW - 8000 }]);
  });
});

const round = (ratio: number): number => Math.round(ratio * 10_000) / 100;
