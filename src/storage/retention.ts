// Rolls completed days of raw results into daily rollups and deletes raw results past the retention window.
import type { Db } from "./database.js";
import { MAX_THRESHOLD } from "../monitors/schema.js";
import { DAY_MS, dayKey, startOfDay } from "./days.js";

export const DEFAULT_RAW_RETENTION_DAYS = 30;
export const DEFAULT_ROLLUP_RETENTION_DAYS = 400;
export const RETENTION_INTERVAL_MS = 3_600_000;

export interface RetentionOptions {
  rawRetentionDays?: number;
  rollupRetentionDays?: number;
  intervalMs?: number;
  /**
   * Results each monitor keeps past the raw window, newest first, so a restart can rebuild the
   * detector's streaks. Never below MAX_THRESHOLD in production; tests lower it.
   */
  keepLatestPerMonitor?: number;
  /** Called when a scheduled run throws; the schedule keeps going. */
  onError?: (error: unknown) => void;
}

export interface RetentionSummary {
  /** Monitor-days whose rollup was created or added to. */
  rolledUp: number;
  rawDeleted: number;
  rollupsDeleted: number;
}

export interface Retention {
  /**
   * Adds every result from a completed day to its day's rollup exactly once, then prunes;
   * repeating it changes nothing further. A result that lands after its day was rolled up is
   * added on the next run, and pruning never takes anything out of a rollup.
   */
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
  const keepLatest = options.keepLatestPerMonitor ?? MAX_THRESHOLD;

  const addUptime = db.prepare(
    `INSERT INTO daily_uptime (monitor_id, day, up_count, total_count)
     SELECT monitor_id, strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS day, SUM(status = 'up'), COUNT(*)
     FROM check_results WHERE rolled_up = 0 AND checked_at < ? GROUP BY monitor_id, day
     ON CONFLICT (monitor_id, day) DO UPDATE SET
       up_count = daily_uptime.up_count + excluded.up_count,
       total_count = daily_uptime.total_count + excluded.total_count`,
  );
  const addLatency = db.prepare(
    `INSERT INTO daily_latency (monitor_id, day, avg_latency_ms, sample_count)
     SELECT monitor_id, strftime('%Y-%m-%d', checked_at / 1000, 'unixepoch') AS day, AVG(latency_ms), COUNT(*)
     FROM check_results WHERE rolled_up = 0 AND checked_at < ? GROUP BY monitor_id, day
     ON CONFLICT (monitor_id, day) DO UPDATE SET
       avg_latency_ms = (daily_latency.avg_latency_ms * daily_latency.sample_count + excluded.avg_latency_ms * excluded.sample_count)
         / (daily_latency.sample_count + excluded.sample_count),
       sample_count = daily_latency.sample_count + excluded.sample_count`,
  );
  const markRolledUp = db.prepare("UPDATE check_results SET rolled_up = 1 WHERE rolled_up = 0 AND checked_at < ?");
  const deleteRaw = db.prepare(
    `DELETE FROM check_results WHERE rolled_up = 1 AND checked_at < ? AND id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY checked_at DESC, id DESC) AS rank FROM check_results
       ) WHERE rank <= ?)`,
  );
  const deleteUptime = db.prepare("DELETE FROM daily_uptime WHERE day < ?");
  const deleteLatency = db.prepare("DELETE FROM daily_latency WHERE day < ?");

  let timer: NodeJS.Timeout | undefined;

  const run = (now: number = Date.now()): RetentionSummary => {
    const today = startOfDay(now);
    const rawCutoff = today - rawDays * DAY_MS;
    const rollupCutoff = dayKey(today - rollupDays * DAY_MS);
    return db.transaction((): RetentionSummary => {
      const rolledUp = addUptime.run(today).changes;
      addLatency.run(today);
      markRolledUp.run(today);
      const rawDeleted = deleteRaw.run(Math.min(rawCutoff, today), keepLatest).changes;
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
