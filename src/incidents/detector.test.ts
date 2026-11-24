import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../checks/types.js";
import { createMonitorRepository } from "../monitors/repository.js";
import { parseMonitor } from "../monitors/schema.js";
import { openDatabase, type Db } from "../storage/database.js";
import { createResultStore, type ResultStore } from "../storage/result-store.js";
import { tempDbPath } from "../storage/test-db.js";
import { createIncidentDetector, type IncidentDetector, type IncidentEvent, type Thresholds } from "./detector.js";

const thresholds: Thresholds = { failuresBeforeDown: 3, successesBeforeRecovered: 2 };

let db: Db;
let store: ResultStore;
let detector: IncidentDetector;
let clock: number;
let events: IncidentEvent[];

beforeEach(() => {
  db = openDatabase(tempDbPath());
  createMonitorRepository(db).add(parseMonitor({ name: "a", url: "https://example.com" }));
  store = createResultStore(db);
  detector = createIncidentDetector(store);
  events = [];
  detector.subscribe((event) => events.push(event));
  clock = 1_000_000;
});
afterEach(() => db.close());

function feed(target: IncidentDetector, status: "up" | "down", record = true): IncidentEvent | undefined {
  clock += 1000;
  const result: CheckResult = {
    monitorId: "a",
    status,
    latencyMs: 5,
    error: status === "down" ? `fail at ${clock}` : null,
    checkedAt: clock,
    certExpiresAt: null,
  };
  if (record) store.recordResult(result);
  return target.handleResult(result, thresholds);
}

describe("incident detector", () => {
  it("opens one incident on the third consecutive failure and nothing before", () => {
    expect(feed(detector, "down")).toBeUndefined();
    expect(feed(detector, "down")).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(store.getOpenIncident("a")).toBeUndefined();
    const event = feed(detector, "down");
    expect(event).toMatchObject({ type: "opened", monitorId: "a" });
    expect(events).toEqual([event]);
    expect(store.getOpenIncident("a")).toEqual(event?.incident);
    expect(event?.incident.firstError).toBe(`fail at ${clock}`);
    expect(feed(detector, "down")).toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("resolves on the final up of up, down, up, up and emits one resolved event", () => {
    for (let i = 0; i < 3; i++) feed(detector, "down");
    expect(feed(detector, "up")).toBeUndefined();
    expect(feed(detector, "down")).toBeUndefined();
    expect(feed(detector, "up")).toBeUndefined();
    const event = feed(detector, "up");
    expect(event).toMatchObject({ type: "resolved", monitorId: "a" });
    expect(event?.incident.resolvedAt).toBe(clock);
    expect(store.getOpenIncident("a")).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["opened", "resolved"]);
  });

  it("does not reopen or re-emit after a restart in the middle of an incident", () => {
    for (let i = 0; i < 3; i++) feed(detector, "down");
    const restarted = createIncidentDetector(store);
    const restartedEvents: IncidentEvent[] = [];
    restarted.subscribe((event) => restartedEvents.push(event));
    expect(restarted.restore("a", thresholds).state).toBe("down");
    expect(feed(restarted, "down")).toBeUndefined();
    expect(feed(restarted, "down")).toBeUndefined();
    expect(restartedEvents).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 1 });
    feed(restarted, "up");
    expect(feed(restarted, "up")).toMatchObject({ type: "resolved" });
  });

  it("rebuilds partial streaks from recent results at startup", () => {
    feed(detector, "down");
    feed(detector, "down");
    const restarted = createIncidentDetector(store);
    expect(restarted.restore("a", thresholds)).toEqual({ state: "up", consecutiveFailures: 2, consecutiveSuccesses: 0 });
    expect(feed(restarted, "down")).toMatchObject({ type: "opened" });
  });

  it("moves a new monitor from unknown to up without an event", () => {
    expect(detector.getState("a").state).toBe("unknown");
    expect(feed(detector, "up")).toBeUndefined();
    expect(detector.getState("a").state).toBe("up");
    expect(detector.restore("a", thresholds).state).toBe("up");
    expect(events).toHaveLength(0);
    expect(createIncidentDetector(store).restore("zzz", thresholds).state).toBe("unknown");
  });

  it("opens a second incident for a later outage and stops notifying unsubscribed listeners", () => {
    const seen: IncidentEvent[] = [];
    const off = detector.subscribe((event) => seen.push(event));
    for (let i = 0; i < 3; i++) feed(detector, "down");
    off();
    feed(detector, "up");
    feed(detector, "up");
    for (let i = 0; i < 3; i++) feed(detector, "down");
    expect(events.map((e) => e.type)).toEqual(["opened", "resolved", "opened"]);
    expect(seen).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM incidents").get()).toEqual({ n: 2 });
  });
});
