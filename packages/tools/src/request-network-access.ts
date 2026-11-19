import { defineTool, parseAllowlistHost } from "@suup/core";
import { z } from "zod";

const input = z.object({
  host: z
    .string()
    .trim()
    .min(3)
    .max(253)
    .describe(
      'The exact host name you need, e.g. "api.example.com": no scheme, no path, no wildcard, no IP address. One name per request.',
    ),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .describe("One sentence for the user: why you need to reach this host."),
});

export const requestNetworkAccessTool = defineTool({
  name: "request_network_access",
  description: [
    "Asks the user to let your machine reach ONE more internet host (by its exact name).",
    "Your machine has no direct network: it goes out through a proxy that only lets through hosts on an allowlist.",
    "When a command fails with `network: host X is not allowed for this bot`, call this with that host and a short reason; the user sees a card with the exact host and decides.",
    "If they approve, the host is reachable until this run ends, and you can run the command again. If they refuse, do not look for another way around: tell the user what you could not do.",
    "Subdomains are different hosts: allowing `example.com` does not allow `api.example.com`.",
  ].join(" "),
  input,
  // It only ever asks: the grant happens after the user approved the card with this exact host.
  // The level is fixed (no `classify`), so the card always appears unless the user wrote a rule.
  risk: "external_irreversible",
  describe: ({ host, reason }) =>
    `Allow network access to ${host} until the end of this run. Reason: ${reason}`,
  async execute({ host }, ctx) {
    const checked = parseAllowlistHost(host);
    if (!checked.ok) {
      return {
        isError: true,
        content: `Cannot allow that: ${checked.message}. Give a full host name such as api.example.com.`,
      };
    }
    if (ctx.network === undefined) {
      return {
        isError: true,
        content:
          "This machine has no network proxy to allow hosts on (it is not the isolated machine), so there is nothing to grant.",
      };
    }
    try {
      const { host: granted, added } = await ctx.network.allowForRun(checked.host);
      return {
        content: `${granted} is allowed for the rest of this run${added ? "" : " (it already was)"}. Run the command again.`,
      };
    } catch (error) {
      return {
        isError: true,
        content: `Could not allow ${checked.host}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});
