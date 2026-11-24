// Rolls completed days of raw results into daily rollups and deletes raw results past the retention window.
import type { Db } from "./database.js";
import { DAY_MS, dayKey, startOfDay } from "./days.js";

export const DEFAULT_RAW_RETENTION_DAYS = 30;
export const DEFAULT_ROLLUP_RETENTION_DAYS = 400;
export const RETENTION_INTERVAL_MS = 3_600_000;

export interface RetentionOptions {
  rawRetentionDays?: number;
  rollupRetentionDays?: number;
  intervalMs?: number;
  /** Called when a scheduled run throws; the schedule keeps going. */
  onError?: (error: unknown) => void;
}

export interface RetentionSummary {
  /** Monitor-days written (or rewritten) to the rollup. */
  rolledUp: number;
  rawDeleted: number;
  rollupsDeleted: number;
}

export interface Retention {
  /** Rolls up every completed day, then prunes; repeating it changes nothing further. */
  run(now?: number): RetentionSummary;
  /** Runs once now, then hourly; the timer never keeps the process alive. */
  start(): void;
  stop(): void;
}

/** Creates retention over an open database. */
export function createRetention(db: Db, options: RetentionOptions = {}): Retention {
  const rawDays = options.rawRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS;
  const rollupDays = options.rollupRetentionDays ?? DEFAULT_ROLLUP_RETENTION_DAYS;
  const intervalMs = options.intervalMs ?? RETENTION_INTERVAL_MS;

  const upsertUptime = db.prepare(
    `INSERT INTO daily_uptime (monitor_id, day, up_count, total_count)
     SELECT monitor_id, strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS day, SUM(status = 'up'), COUNT(*)
     FROM check_results r WHERE checked_at < ?
       AND (checked_at >= ? OR NOT EXISTS (
         SELECT 1 FROM daily_uptime u WHERE u.monitor_id = r.monitor_id AND u.day = strftime('%Y-%m-%d', r.checked_at / 1000, 'unixepoch')))
     GROUP BY monitor_id, day
     ON CONFLICT (monitor_id, day) DO UPDATE SET up_count = excluded.up_count, total_count = excluded.total_count`,
  );
  const upsertLatency = db.prepare(
    `INSERT INTO daily_latency (monitor_id, day, avg_latency_ms)
     SELECT monitor_id, strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS day, AVG(latency_ms)
     FROM check_results r WHERE checked_at < ?
       AND (checked_at >= ? OR NOT EXISTS (
         SELECT 1 FROM daily_latency l WHERE l.monitor_id = r.monitor_id AND l.day = strftime('%Y-%m-%d', r.checked_at / 1000, 'unixepoch')))
     GROUP BY monitor_id, day
     ON CONFLICT (monitor_id, day) DO UPDATE SET avg_latency_ms = excluded.avg_latency_ms`,
  );
  const deleteRaw = db.prepare(
    `DELETE FROM check_results WHERE checked_at < ? AND id NOT IN (
       SELECT (SELECT id FROM check_results l WHERE l.monitor_id = m.monitor_id ORDER BY checked_at DESC, id DESC LIMIT 1)
       FROM (SELECT DISTINCT monitor_id FROM check_results) m)`,
  );
  const deleteUptime = db.prepare("DELETE FROM daily_uptime WHERE day < ?");
  const deleteLatency = db.prepare("DELETE FROM daily_latency WHERE day < ?");

  let timer: NodeJS.Timeout | undefined;

  const run = (now: number = Date.now()): RetentionSummary => {
    const today = startOfDay(now);
    const rawCutoff = today - rawDays * DAY_MS;
    const rollupCutoff = dayKey(today - rollupDays * DAY_MS);
    return db.transaction((): RetentionSummary => {
      const rolledUp = upsertUptime.run(today, rawCutoff).changes;
      upsertLatency.run(today, rawCutoff);
      const rawDeleted = deleteRaw.run(Math.min(rawCutoff, today)).changes;
      const rollupsDeleted = deleteUptime.run(rollupCutoff).changes;
      deleteLatency.run(rollupCutoff);
      return { rolledUp, rawDeleted, rollupsDeleted };
    })();
  };

  const guarded = (): void => {
    try {
      run();
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    run,
    start() {
      if (timer) return;
      guarded();
      timer = setInterval(guarded, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
