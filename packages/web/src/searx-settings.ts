// Owns the `settings.yml` of the SearXNG container. SearXNG is used UNMODIFIED (it is AGPL v3: the
// duty to offer source arises when the program is modified, docs/BUSCA.md); everything we change is
// in this settings file, on top of the image's own defaults. The file holds no secret: the
// `secret_key` comes from the environment (`SEARXNG_SECRET`), generated for each install.
//
// The text is written as YAML by hand for this fixed shape; strings go through JSON quoting, which
// is valid YAML.
import { engineById } from "./engines.js";

export interface SearxSettingsInput {
  engines: readonly string[];
  /** The egress proxy URL SearXNG sends every outgoing request through, or none (dev compose). */
  proxyUrl?: string;
  /** Seconds before a slow engine is given up. */
  requestTimeout?: number;
  bindAddress?: string;
  port?: number;
}

const q = (value: string): string => JSON.stringify(value);

export function renderSearxSettings(input: SearxSettingsInput): string {
  const lines: string[] = [
    "# Generated from packages/web/src/searx-settings.ts. Do not edit by hand: change the engine list in",
    "# suup.config.json (web.search.engines) or in the code. See docs/BUSCA.md.",
    "# No secret here: secret_key comes from the environment variable SEARXNG_SECRET.",
    "use_default_settings:",
    "  engines:",
    "    keep_only:",
    ...input.engines.map((id) => `      - ${q(id)}`),
    "general:",
    '  instance_name: "Suup search"',
    "  debug: false",
    "  enable_metrics: false",
    "search:",
    "  safe_search: 1",
    '  autocomplete: ""',
    "  formats:",
    "    - html",
    "    - json",
    "server:",
    `  port: ${input.port ?? 8080}`,
    `  bind_address: ${q(input.bindAddress ?? "0.0.0.0")}`,
    "  # Single-user, internal use: nobody reaches this from outside, so there is no bot to stop.",
    "  limiter: false",
    "  public_instance: false",
    "  image_proxy: false",
    '  method: "GET"',
    "ui:",
    "  static_use_hash: false",
    "outgoing:",
    `  request_timeout: ${input.requestTimeout ?? 6}`,
    `  max_request_timeout: ${(input.requestTimeout ?? 6) + 4}`,
    "  enable_http2: false",
    '  useragent_suffix: "Suup"',
  ];
  if (input.proxyUrl !== undefined) {
    lines.push("  proxies:", `    all://: ${q(input.proxyUrl)}`);
  }
  // An engine that the image has switched off by default must be switched on explicitly.
  const enabled = input.engines.filter((id) => engineById(id) !== undefined);
  if (enabled.length > 0) {
    lines.push("engines:");
    for (const id of enabled) lines.push(`  - name: ${q(id)}`, "    disabled: false");
  }
  return `${lines.join("\n")}\n`;
}
