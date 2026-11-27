// AppConfig: the shape of uptime.yml after validation and defaults.
import { z } from "zod";
import { monitorSchema } from "../monitors/schema.js";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8080;
export const DEFAULT_STATUS_PAGE_TITLE = "Service status";
export const DEFAULT_DATABASE_PATH = "./data/uptime.sqlite";

const serverSchema = z.strictObject({
  host: z.string().min(1).default(DEFAULT_HOST),
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  statusPageTitle: z.string().min(1).default(DEFAULT_STATUS_PAGE_TITLE),
});

const storageSchema = z.strictObject({
  path: z.string().min(1).default(DEFAULT_DATABASE_PATH),
});

/** Values merged into every monitor that does not set them itself. */
export const monitorDefaultsSchema = z.strictObject({
  interval: z.number().optional(),
  timeout: z.number().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  thresholds: z
    .strictObject({
      failuresBeforeDown: z.number().optional(),
      successesBeforeRecovered: z.number().optional(),
    })
    .optional(),
});

const webhookNotifierSchema = z.strictObject({
  name: z.string().min(1),
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const emailNotifierSchema = z.strictObject({
  name: z.string().min(1),
  type: z.literal("email"),
  smtp: z.strictObject({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().optional(),
    password: z.string().optional(),
  }),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
});

/** One alert destination; the alerts worker dispatches on `type`. */
export const notifierConfigSchema = z.discriminatedUnion("type", [
  webhookNotifierSchema,
  emailNotifierSchema,
]);
export type NotifierConfig = z.output<typeof notifierConfigSchema>;

/** Which incident events on which monitors go to which notifiers. */
export const alertRuleConfigSchema = z.strictObject({
  name: z.string().min(1).optional(),
  notifiers: z.array(z.string().min(1)).min(1),
  monitors: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  events: z.array(z.enum(["down", "recovered"])).min(1).default(["down", "recovered"]),
});
export type AlertRuleConfig = z.output<typeof alertRuleConfigSchema>;

export const appConfigSchema = z
  .strictObject({
    server: serverSchema.default(() => serverSchema.parse({})),
    storage: storageSchema.default(() => storageSchema.parse({})),
    defaults: monitorDefaultsSchema.default({}),
    monitors: z.array(monitorSchema).default([]),
    notifiers: z.array(notifierConfigSchema).default([]),
    alertRules: z.array(alertRuleConfigSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seenMonitors = new Set<string>();
    config.monitors.forEach((monitor, index) => {
      if (seenMonitors.has(monitor.id)) {
        ctx.addIssue({ code: "custom", path: ["monitors", index, "id"], message: `duplicate monitor id "${monitor.id}"` });
      }
      seenMonitors.add(monitor.id);
    });
    const seenNotifiers = new Set<string>();
    config.notifiers.forEach((notifier, index) => {
      if (seenNotifiers.has(notifier.name)) {
        ctx.addIssue({ code: "custom", path: ["notifiers", index, "name"], message: `duplicate notifier name "${notifier.name}"` });
      }
      seenNotifiers.add(notifier.name);
    });
    config.alertRules.forEach((rule, ruleIndex) => {
      rule.notifiers.forEach((name, index) => {
        if (!seenNotifiers.has(name)) {
          ctx.addIssue({ code: "custom", path: ["alertRules", ruleIndex, "notifiers", index], message: `no notifier named "${name}"` });
        }
      });
    });
  });

export type AppConfig = z.output<typeof appConfigSchema>;
