// Read queries behind the status page and API: current state, uptime windows, daily history, incidents.
import type { MonitorRepository } from "../monitors/repository.js";
import type { Db } from "./database.js";
import { DAY_MS, dayKey, startOfDay } from "./days.js";
import type { Incident } from "./result-store.js";

export type MonitorState = "up" | "down" | "unknown";

/** Uptime percentages (two decimals) per window; null when the window holds no checks. */
export interface UptimeWindows {
  last24h: number | null;
  last7d: number | null;
  last30d: number | null;
  last90d: number | null;
}

export interface MonitorStatus {
  monitorId: string;
  name: string;
  /** down while an incident is open; up once any check has run; unknown before. */
  state: MonitorState;
  lastCheckedAt: number | null;
  latencyMs: number | null;
  openIncident: Incident | null;
  uptime: UptimeWindows;
}

export interface DailyUptime {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  uptimePercent: number | null;
  upCount: number;
  totalCount: number;
}

export interface StatusQueries {
  /** Every enabled monitor with its current state, last check, open incident and uptime. */
  getStatusOverview(now?: number): MonitorStatus[];
  /**
   * Exactly `days` entries ending with `now`'s UTC day, oldest first; null percent where no data.
   * Every figure counts only checks up to `now`.
   */
  getDailyUptime(monitorId: string, days: number, now?: number): DailyUptime[];
  /** Uptime percentage over the last `days` UTC days including today, or null with no checks. */
  getUptimePercent(monitorId: string, days: number, now?: number): number | null;
  /** Newest first; optionally for one monitor. */
  recentIncidents(limit: number, monitorId?: string): Incident[];
}

interface Counts {
  up: number | null;
  total: number;
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

const percent = (up: number, total: number): number | null =>
  total === 0 ? null : Math.round((up / total) * 10_000) / 100;

/** Creates the queries over an open database and the monitor repository. */
export function createStatusQueries(db: Db, monitors: MonitorRepository): StatusQueries {
  const rollupCounts = db.prepare(
    "SELECT SUM(up_count) AS up, COALESCE(SUM(total_count), 0) AS total FROM daily_uptime WHERE monitor_id = ? AND day >= ? AND day < ?",
  );
  const rollupDays = db.prepare(
    "SELECT day, up_count AS up, total_count AS total FROM daily_uptime WHERE monitor_id = ? AND day >= ? AND day < ?",
  );
  const rollupOn = db.prepare("SELECT up_count AS up, total_count AS total FROM daily_uptime WHERE monitor_id = ? AND day = ?");
  const rawCounts = db.prepare(
    "SELECT SUM(status = 'up') AS up, COUNT(*) AS total FROM check_results WHERE monitor_id = ? AND checked_at >= ? AND checked_at <= ?",
  );
  const unrolledCounts = db.prepare(
    `SELECT SUM(status = 'up') AS up, COUNT(*) AS total FROM check_results
     WHERE monitor_id = ? AND rolled_up = 0 AND checked_at >= ? AND checked_at <= ?`,
  );
  const unrolledDays = db.prepare(
    `SELECT strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS day, SUM(status = 'up') AS up, COUNT(*) AS total
     FROM check_results WHERE monitor_id = ? AND rolled_up = 0 AND checked_at >= ? AND checked_at < ? GROUP BY day`,
  );
  const rolledCountOn = db.prepare(
    "SELECT COUNT(*) AS total FROM check_results WHERE monitor_id = ? AND rolled_up = 1 AND checked_at >= ? AND checked_at < ?",
  );
  const lastResult = db.prepare(
    "SELECT checked_at, latency_ms FROM check_results WHERE monitor_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1",
  );
  const openIncident = db.prepare("SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL");
  const incidentsAll = db.prepare("SELECT * FROM incidents ORDER BY started_at DESC, id DESC LIMIT ?");
  const incidentsFor = db.prepare("SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC, id DESC LIMIT ?");

  const add = (a: Counts, b: Counts): Counts => ({ up: (a.up ?? 0) + (b.up ?? 0), total: a.total + b.total });

  /**
   * Counts for `now`'s own day, up to `now`. Raw results answer exactly while the day still holds
   * all of them; once pruning has thinned a rolled-up day, its whole rollup is the best answer left.
   */
  function cutoffDayCounts(monitorId: string, now: number): Counts {
    const dayStart = startOfDay(now);
    const rollup = rollupOn.get(monitorId, dayKey(now)) as Counts | undefined;
    const rolledLeft = (rolledCountOn.get(monitorId, dayStart, dayStart + DAY_MS) as Counts).total;
    if (rollup && rollup.total > rolledLeft) return add(rollup, unrolledCounts.get(monitorId, dayStart, now) as Counts);
    return rawCounts.get(monitorId, dayStart, now) as Counts;
  }

  function uptimeOverDays(monitorId: string, days: number, now: number): number | null {
    const firstDay = startOfDay(now - (days - 1) * DAY_MS);
    const cutoffDay = startOfDay(now);
    const before = add(
      rollupCounts.get(monitorId, dayKey(firstDay), dayKey(cutoffDay)) as Counts,
      unrolledCounts.get(monitorId, firstDay, cutoffDay - 1) as Counts,
    );
    const counts = add(before, cutoffDayCounts(monitorId, now));
    return percent(counts.up ?? 0, counts.total);
  }

  function uptimeLast24h(monitorId: string, now: number): number | null {
    const raw = rawCounts.get(monitorId, now - DAY_MS, now) as Counts;
    return percent(raw.up ?? 0, raw.total);
  }

  const queries: StatusQueries = {
    getStatusOverview(now = Date.now()) {
      return monitors
        .list()
        .filter((monitor) => monitor.enabled)
        .map((monitor) => {
          const last = lastResult.get(monitor.id) as { checked_at: number; latency_ms: number } | undefined;
          const openRow = openIncident.get(monitor.id) as IncidentRow | undefined;
          const state: MonitorState = openRow ? "down" : last ? "up" : "unknown";
          return {
            monitorId: monitor.id,
            name: monitor.name,
            state,
            lastCheckedAt: last?.checked_at ?? null,
            latencyMs: last?.latency_ms ?? null,
            openIncident: openRow ? toIncident(openRow) : null,
            uptime: {
              last24h: uptimeLast24h(monitor.id, now),
              last7d: uptimeOverDays(monitor.id, 7, now),
              last30d: uptimeOverDays(monitor.id, 30, now),
              last90d: uptimeOverDays(monitor.id, 90, now),
            },
          };
        });
    },
    getDailyUptime(monitorId, days, now = Date.now()) {
      const firstDay = startOfDay(now - (days - 1) * DAY_MS);
      const cutoffDay = startOfDay(now);
      const byDay = new Map<string, Counts>();
      const merge = (day: string, counts: Counts): void => {
        byDay.set(day, add(byDay.get(day) ?? { up: 0, total: 0 }, counts));
      };
      for (const row of rollupDays.all(monitorId, dayKey(firstDay), dayKey(cutoffDay)) as Array<Counts & { day: string }>) {
        merge(row.day, row);
      }
      for (const row of unrolledDays.all(monitorId, firstDay, cutoffDay) as Array<Counts & { day: string }>) {
        merge(row.day, row);
      }
      merge(dayKey(now), cutoffDayCounts(monitorId, now));
      return Array.from({ length: days }, (_, index) => {
        const day = dayKey(firstDay + index * DAY_MS);
        const counts = byDay.get(day);
        const upCount = counts?.up ?? 0;
        const totalCount = counts?.total ?? 0;
        return { day, uptimePercent: percent(upCount, totalCount), upCount, totalCount };
      });
    },
    getUptimePercent(monitorId, days, now = Date.now()) {
      return uptimeOverDays(monitorId, days, now);
    },
    recentIncidents(limit, monitorId) {
      const rows = (monitorId === undefined ? incidentsAll.all(limit) : incidentsFor.all(monitorId, limit)) as IncidentRow[];
      return rows.map(toIncident);
    },
  };
  return queries;
}
