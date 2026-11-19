import { z } from "zod";
import { isoDate } from "./common.js";

/** A host a bot's machine may reach (exact name, no pattern). */
export const networkHostSchema = z.object({
  host: z.string(),
  /** `user`: added by a person (CLI, app). `approval`: not listed here (those only last for one run). */
  createdBy: z.enum(["user", "approval"]),
  createdAt: isoDate,
});
export type NetworkHost = z.infer<typeof networkHostSchema>;

/** One thing the egress proxy refused for this bot. */
export const networkRefusalSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  /** `not_allowed`, `ip_literal`, `bad_host`, `bad_port`, `forbidden_address` or `dns_failed`. */
  reason: z.string(),
  message: z.string(),
  createdAt: isoDate,
});
export type NetworkRefusal = z.infer<typeof networkRefusalSchema>;

/** What a bot's machine may reach: the global defaults, the bot's own hosts, and the latest refusals. */
export const botNetworkSchema = z.object({
  defaults: z.array(z.string()),
  hosts: z.array(networkHostSchema),
  refusals: z.array(networkRefusalSchema),
});
export type BotNetwork = z.infer<typeof botNetworkSchema>;
