import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckResult } from "../checks/types.js";
import { createMonitorRepository } from "../monitors/repository.js";
import { parseMonitor } from "../monitors/schema.js";
import { openDatabase, type Db } from "./database.js";
import { IncidentAlreadyOpenError, createResultStore, type ResultStore } from "./result-store.js";
import { tempDbPath } from "./test-db.js";

let db: Db;
let store: ResultStore;
beforeEach(() => {
  db = openDatabase(tempDbPath());
  const repo = createMonitorRepository(db);
  repo.add(parseMonitor({ name: "a", url: "https://example.com" }));
  repo.add(parseMonitor({ name: "b", url: "https://example.com" }));
  store = createResultStore(db);
});
afterEach(() => db.close());

const result = (monitorId: string, checkedAt: number, extra: Partial<CheckResult> = {}): CheckResult => ({
  monitorId,
  status: "up",
  latencyMs: 12.5,
  error: null,
  checkedAt,
  certExpiresAt: null,
  ...extra,
});

describe("result store", () => {
  it("reads results back newest first with every field intact, per monitor and limited", () => {
    const down = result("a", 2000, { status: "down", error: "refused", certExpiresAt: 99, latencyMs: 3 });
    store.recordResult(result("a", 1000));
    store.recordResult(down);
    store.recordResult(result("a", 3000));
    store.recordResult(result("b", 4000));
    const recent = store.recentResults("a", 10);
    expect(recent.map((r) => r.checkedAt)).toEqual([3000, 2000, 1000]);
    expect(recent[1]).toEqual(down);
    expect(store.recentResults("a", 2)).toHaveLength(2);
    expect(store.recentResults("b", 10)).toHaveLength(1);
  });

  it("refuses a second open incident for the same monitor", () => {
    const incident = store.openIncident("a", "refused", 5000);
    expect(incident).toMatchObject({ monitorId: "a", startedAt: 5000, resolvedAt: null, firstError: "refused" });
    expect(() => store.openIncident("a", "again")).toThrow(IncidentAlreadyOpenError);
    expect(store.openIncident("b", null).monitorId).toBe("b");
    expect(store.getOpenIncident("a")).toEqual(incident);
  });

  it("resolves an open incident and ignores a resolve when none is open", () => {
    store.openIncident("a", "refused", 5000);
    const resolved = store.resolveIncident("a", 6000);
    expect(resolved).toMatchObject({ startedAt: 5000, resolvedAt: 6000 });
    expect(store.getOpenIncident("a")).toBeUndefined();
    expect(store.resolveIncident("a", 7000)).toBeUndefined();
    expect(store.resolveIncident("b")).toBeUndefined();
  });

  it("allows a new incident after the previous one resolved", () => {
    store.openIncident("a", "x", 1);
    store.resolveIncident("a", 2);
    expect(store.openIncident("a", "y", 3).resolvedAt).toBeNull();
  });
});
