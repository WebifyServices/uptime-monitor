// The Monitor record shared by the config file, storage, checks and the API.
import { z } from "zod";

export const MIN_INTERVAL_SECONDS = 10;
/** One day: keeps every interval and timeout well inside the range a Node timer can hold. */
export const MAX_INTERVAL_SECONDS = 86_400;
export const DEFAULT_INTERVAL_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 10;
export const DEFAULT_FAILURES_BEFORE_DOWN = 3;
export const DEFAULT_SUCCESSES_BEFORE_RECOVERED = 2;
export const DEFAULT_TLS_WARN_DAYS = 14;

export const monitorTypeSchema = z.enum(["http", "tcp", "tls"]);
export type MonitorType = z.infer<typeof monitorTypeSchema>;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Turns a display name into a lowercase slug usable as a monitor id. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const statusRange = z
  .union([z.number().int(), z.string(), z.strictObject({ from: z.number().int(), to: z.number().int() })])
  .transform((value, ctx) => {
    if (typeof value === "object") {
      if (value.from < 100 || value.to > 599 || value.from > value.to) {
        ctx.addIssue({ code: "custom", message: "expected a status range between 100 and 599" });
        return z.NEVER;
      }
      return value;
    }
    const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(String(value).trim());
    const from = match?.[1] ? Number(match[1]) : NaN;
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || from < 100 || to > 599 || from > to) {
      ctx.addIssue({
        code: "custom",
        message: `expected a status code like 200 or a range like 200-399, got "${value}"`,
      });
      return z.NEVER;
    }
    return { from, to };
  });

const httpOptionsSchema = z.strictObject({
  method: z
    .enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    .default("GET"),
  expectedStatus: z
    .array(statusRange)
    .min(1)
    .default(() => [{ from: 200, to: 399 }]),
  bodyContains: z.string().min(1).optional(),
});

const tlsOptionsSchema = z.strictObject({
  warnDays: z.number().int().min(1).default(DEFAULT_TLS_WARN_DAYS),
  allowSelfSigned: z.boolean().default(false),
});

const thresholdsSchema = z.strictObject({
  failuresBeforeDown: z.number().int().min(1).default(DEFAULT_FAILURES_BEFORE_DOWN),
  successesBeforeRecovered: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SUCCESSES_BEFORE_RECOVERED),
});

const monitorShape = z.strictObject({
  id: z.string().regex(SLUG, "must be a lowercase slug such as my-site").optional(),
  name: z.string().trim().min(1),
  type: monitorTypeSchema.default("http"),
  target: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  interval: z
    .number()
    .min(MIN_INTERVAL_SECONDS, `must be at least ${MIN_INTERVAL_SECONDS} seconds`)
    .max(MAX_INTERVAL_SECONDS, `must be at most ${MAX_INTERVAL_SECONDS} seconds (one day)`)
    .default(DEFAULT_INTERVAL_SECONDS),
  timeout: z.number().positive().default(DEFAULT_TIMEOUT_SECONDS),
  enabled: z.boolean().default(true),
  tags: z.array(z.string().trim().min(1)).default([]),
  http: httpOptionsSchema.optional(),
  tls: tlsOptionsSchema.optional(),
  thresholds: thresholdsSchema.default(() => ({
    failuresBeforeDown: DEFAULT_FAILURES_BEFORE_DOWN,
    successesBeforeRecovered: DEFAULT_SUCCESSES_BEFORE_RECOVERED,
  })),
});

function hasMalformedPort(target: string): boolean {
  return /^(\[[^\]]+\]|[^:]+):/.test(target) && !/^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.test(target);
}

function hostAndPort(target: string): { host: string; port: number | null } {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
  if (!match?.[1] || !match[2]) return { host: target, port: null };
  return { host: match[1], port: Number(match[2]) };
}

/**
 * Monitor definition. Input accepts `url` as an alias of `target` for HTTP
 * monitors; `interval` and `timeout` are in seconds.
 */
export const monitorSchema = monitorShape
  .superRefine((raw, ctx) => {
    const target = raw.target ?? raw.url;
    if (!target) {
      ctx.addIssue({ code: "custom", path: [raw.type === "http" ? "url" : "target"], message: "is required" });
      return;
    }
    if (raw.target && raw.url && raw.target !== raw.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "conflicts with target; set only one" });
    }
    if (raw.type === "http") {
      let protocol = "";
      try {
        protocol = new URL(target).protocol;
      } catch {
        protocol = "";
      }
      if (protocol !== "http:" && protocol !== "https:") {
        ctx.addIssue({ code: "custom", path: ["target"], message: "must be an http:// or https:// URL" });
      }
    }
    if (raw.type === "tcp") {
      const { port } = hostAndPort(target);
      if (port === null || port < 1 || port > 65535) {
        ctx.addIssue({ code: "custom", path: ["target"], message: "must be host:port with a port from 1 to 65535" });
      }
    }
    if (raw.type === "tls") {
      const { port } = hostAndPort(target);
      if (hasMalformedPort(target) || (port !== null && (port < 1 || port > 65535))) {
        ctx.addIssue({ code: "custom", path: ["target"], message: "port must be from 1 to 65535" });
      }
    }
    if (raw.timeout >= raw.interval) {
      ctx.addIssue({ code: "custom", path: ["timeout"], message: `must be shorter than the interval (${raw.interval} s)` });
    }
    if (raw.type !== "http" && raw.http) {
      ctx.addIssue({ code: "custom", path: ["http"], message: "only applies to http monitors" });
    }
    if (raw.type !== "tls" && raw.tls) {
      ctx.addIssue({ code: "custom", path: ["tls"], message: "only applies to tls monitors" });
    }
  })
  .transform((raw, ctx) => {
    const { url, target: explicitTarget, id: explicitId, http, tls, type, ...rest } = raw;
    const target = (explicitTarget ?? url ?? "").trim();
    const id = explicitId ?? slugify(rest.name);
    if (!SLUG.test(id)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "cannot be derived from the name; set a lowercase slug id" });
      return z.NEVER;
    }
    return {
      id,
      ...rest,
      type,
      target,
      ...(type === "http" ? { http: http ?? httpOptionsSchema.parse({}) } : {}),
      ...(type === "tls" ? { tls: tls ?? tlsOptionsSchema.parse({}) } : {}),
    };
  });

/** A validated monitor with every default applied; inferred from the schema. */
export type Monitor = z.output<typeof monitorSchema>;
export type MonitorInput = z.input<typeof monitorSchema>;

export class MonitorValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
    this.name = "MonitorValidationError";
  }
}

/** Formats a zod issue path such as ["monitors", 2, "timeout"] as monitors[2].timeout. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    const key = String(part);
    return acc ? `${acc}.${key}` : key;
  }, "");
}

/** Validates unknown input into a Monitor, throwing MonitorValidationError naming each bad field. */
export function parseMonitor(input: unknown): Monitor {
  const result = monitorSchema.safeParse(input);
  if (result.success) return result.data;
  throw new MonitorValidationError(
    result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  );
}

/** Splits a monitor target into host and optional port (IPv6 hosts keep their brackets). */
export function splitTarget(target: string): { host: string; port: number | null } {
  return hostAndPort(target);
}
