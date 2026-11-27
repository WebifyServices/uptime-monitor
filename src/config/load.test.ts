import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig, resolveConfigPath } from "./load.js";

const exampleEnv = { WEBHOOK_TOKEN: "t", SMTP_PASSWORD: "p" };

describe("loadConfig", () => {
  it("loads the example file with every documented default applied", () => {
    const config = loadConfig("uptime.example.yml", exampleEnv);
    expect(config.server).toEqual({ host: "0.0.0.0", port: 8080, statusPageTitle: "Service status" });
    expect(config.monitors.map((m) => m.id)).toEqual(["example-website", "example-database", "example-certificate"]);
    expect(config.monitors[1]).toMatchObject({ type: "tcp", interval: 30, timeout: 10 });
    expect(config.notifiers.map((n) => n.name)).toEqual(["ops-webhook", "ops-email"]);
    expect(config.alertRules).toHaveLength(1);
  });

  it("applies defaults to an empty file", () => {
    const config = parseConfig("", {});
    expect(config.server.port).toBe(8080);
    expect(config.monitors).toEqual([]);
    expect(config.storage.path).toBe("./data/uptime.sqlite");
  });

  it("merges the defaults section into monitors without overriding their own values", () => {
    const config = parseConfig(
      `defaults:
  interval: 30
  thresholds:
    failuresBeforeDown: 5
monitors:
  - { name: A, url: "https://example.com" }
  - { name: B, url: "https://example.com", interval: 120, thresholds: { successesBeforeRecovered: 4 } }
`,
      {},
    );
    expect(config.monitors[0]).toMatchObject({ interval: 30, thresholds: { failuresBeforeDown: 5, successesBeforeRecovered: 2 } });
    expect(config.monitors[1]).toMatchObject({ interval: 120, thresholds: { failuresBeforeDown: 5, successesBeforeRecovered: 4 } });
  });

  it("substitutes ${NAME} from the environment", () => {
    const config = parseConfig(
      "notifiers:\n  - { name: hook, type: webhook, url: \"https://example.com/${PATHPART}\" }\n",
      { PATHPART: "abc" },
    );
    expect(config.notifiers[0]).toMatchObject({ url: "https://example.com/abc" });
  });

  it("fails naming an environment variable that is not set", () => {
    expect(() => parseConfig("notifiers:\n  - { name: hook, type: webhook, url: \"${MISSING_URL}\" }\n", {})).toThrow(/MISSING_URL/);
  });

  it("rejects a malformed monitor thresholds value instead of replacing it with the defaults", () => {
    const text = (value: string) => `defaults:
  thresholds:
    failuresBeforeDown: 5
monitors:
  - { name: A, url: "https://example.com", thresholds: ${value} }
`;
    expect(() => parseConfig(text("3"), {})).toThrow(/monitors\[0\]\.thresholds/);
    expect(() => parseConfig(text("null"), {})).toThrow(/monitors\[0\]\.thresholds/);
  });

  it("reports validation errors with the YAML path", () => {
    const text = `monitors:
  - { name: A, url: "https://example.com" }
  - { name: B, url: "https://example.com" }
  - { name: C, url: "https://example.com", interval: 20, timeout: 30 }
`;
    expect(() => parseConfig(text, {})).toThrow(/monitors\[2\]\.timeout/);
  });

  it("rejects duplicate monitor ids and duplicate notifier names", () => {
    expect(() =>
      parseConfig(`monitors:\n  - { name: A, url: "https://example.com" }\n  - { id: a, name: Other, url: "https://example.com" }\n`, {}),
    ).toThrow(/monitors\[1\]\.id.*duplicate/);
    expect(() =>
      parseConfig(
        `notifiers:\n  - { name: n, type: webhook, url: "https://example.com" }\n  - { name: n, type: webhook, url: "https://example.com" }\n`,
        {},
      ),
    ).toThrow(/notifiers\[1\]\.name.*duplicate/);
  });

  it("rejects an alert rule that names a notifier the config does not define", () => {
    const text = `notifiers:\n  - { name: ops, type: webhook, url: "https://example.com" }\nalertRules:\n  - { notifiers: [ops, opss] }\n`;
    expect(() => parseConfig(text, {})).toThrow(/alertRules\[0\]\.notifiers\[1\].*opss/);
  });

  it("rejects unknown top-level keys and invalid YAML", () => {
    expect(() => parseConfig("serverr: {}\n", {})).toThrow(ConfigError);
    expect(() => parseConfig("monitors: [\n", {})).toThrow(/invalid YAML/);
  });

  it("reports an unreadable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "uptime-config-"));
    expect(() => loadConfig(join(dir, "missing.yml"), {})).toThrow(/cannot read config file/);
  });

  it("reads a file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "uptime-config-"));
    const path = join(dir, "uptime.yml");
    writeFileSync(path, "server:\n  port: 9000\n");
    expect(loadConfig(path, {}).server.port).toBe(9000);
  });
});

describe("resolveConfigPath", () => {
  it("prefers the flag, then UPTIME_CONFIG, then ./uptime.yml", () => {
    expect(resolveConfigPath("a.yml", { UPTIME_CONFIG: "b.yml" })).toBe("a.yml");
    expect(resolveConfigPath(undefined, { UPTIME_CONFIG: "b.yml" })).toBe("b.yml");
    expect(resolveConfigPath(undefined, {})).toBe("./uptime.yml");
  });
});
