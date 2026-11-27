import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../storage/database.js";
import { tempDbPath } from "../storage/test-db.js";
import { ConfigMonitorConflictError, ConfigMonitorRemovalError, MonitorExistsError, createMonitorRepository, type MonitorRepository } from "./repository.js";
import { parseMonitor } from "./schema.js";

const make = (name: string, extra: Record<string, unknown> = {}) =>
  parseMonitor({ name, url: `https://example.com/${name}`, ...extra });

let db: Db;
let repo: MonitorRepository;
beforeEach(() => {
  db = openDatabase(tempDbPath());
  repo = createMonitorRepository(db);
});
afterEach(() => db.close());

describe("monitor repository", () => {
  it("adds, gets, lists and removes runtime monitors", () => {
    const added = repo.add(make("a"));
    expect(added.source).toBe("runtime");
    expect(repo.get("a")).toEqual(added);
    repo.add(make("b"));
    expect(repo.list().map((m) => m.id)).toEqual(["a", "b"]);
    expect(repo.remove("a")).toBe(true);
    expect(repo.remove("a")).toBe(false);
    expect(repo.get("a")).toBeUndefined();
  });

  it("refuses a duplicate id", () => {
    repo.add(make("a"));
    expect(() => repo.add(make("a"))).toThrow(MonitorExistsError);
  });

  it("leaves the table unchanged when the same config is synced twice", () => {
    const config = [make("a"), make("b", { interval: 30 })];
    expect(repo.syncConfig(config).added).toEqual(["a", "b"]);
    const before = db.prepare("SELECT * FROM monitors ORDER BY id").all();
    expect(repo.syncConfig(config)).toEqual({ added: [], updated: [], removed: [] });
    expect(db.prepare("SELECT * FROM monitors ORDER BY id").all()).toEqual(before);
  });

  it("removes monitors dropped from the config but keeps runtime monitors", () => {
    repo.add(make("runtime"));
    repo.syncConfig([make("a"), make("b")]);
    const summary = repo.syncConfig([make("a")]);
    expect(summary.removed).toEqual(["b"]);
    expect(repo.list().map((m) => m.id).sort()).toEqual(["a", "runtime"]);
  });

  it("refuses a config monitor whose id belongs to a runtime monitor and changes nothing", () => {
    repo.add(make("shared", { interval: 300 }));
    repo.syncConfig([make("a")]);
    expect(() => repo.syncConfig([make("a"), make("shared")])).toThrow(ConfigMonitorConflictError);
    expect(repo.get("shared")).toMatchObject({ source: "runtime", interval: 300 });
    repo.syncConfig([make("a")]);
    expect(repo.get("shared")).toMatchObject({ source: "runtime", interval: 300 });
  });

  it("keeps monitors readable when records read back are synced again", () => {
    repo.syncConfig([make("a"), make("b")]);
    repo.syncConfig(repo.list());
    expect(repo.list().map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("updates a config monitor whose definition changed", () => {
    repo.syncConfig([make("a")]);
    expect(repo.syncConfig([make("a", { interval: 120 })]).updated).toEqual(["a"]);
    expect(repo.get("a")?.interval).toBe(120);
  });

  it("refuses to remove a config monitor and says to edit the config file", () => {
    repo.syncConfig([make("a")]);
    expect(() => repo.remove("a")).toThrow(ConfigMonitorRemovalError);
    expect(() => repo.remove("a")).toThrow(/edit the config file/);
    expect(repo.get("a")).toBeDefined();
  });

  it("notifies subscribers once per change and not for no-ops", () => {
    let calls = 0;
    const unsubscribe = repo.subscribe(() => calls++);
    repo.add(make("a"));
    expect(calls).toBe(1);
    repo.syncConfig([make("c"), make("d")]);
    expect(calls).toBe(2);
    repo.syncConfig([make("c"), make("d")]);
    expect(calls).toBe(2);
    repo.remove("a");
    expect(calls).toBe(3);
    repo.remove("a");
    expect(calls).toBe(3);
    unsubscribe();
    repo.add(make("e"));
    expect(calls).toBe(3);
  });

  it("round-trips every field through storage", () => {
    const monitor = make("full", { tags: ["x"], enabled: false, thresholds: { failuresBeforeDown: 1 } });
    repo.add(monitor);
    expect(repo.get("full")).toEqual({ ...monitor, source: "runtime" });
  });
});
