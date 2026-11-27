// UTC calendar-day helpers shared by retention and the status queries.
export const DAY_MS = 86_400_000;

/** The UTC day of an epoch-millisecond time, as YYYY-MM-DD. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch milliseconds at 00:00 UTC of the day containing `ms`. */
export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
