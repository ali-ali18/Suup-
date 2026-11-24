import { describe, expect, it } from "vitest";
import {
  CONNECTOR_CATALOG,
  catalogEntry,
  catalogToolOverrides,
  isConnectorName,
  parseConnectorSpec,
  SEARCH_PLUGIN_CATALOG,
  searchPluginOf,
  secretNamesOf,
} from "../src/index.js";

describe("connector gallery", () => {
  it("every entry is declared data that a connector accepts", () => {
    const ids = CONNECTOR_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONNECTOR_CATALOG) {
      expect(isConnectorName(entry.id), entry.id).toBe(true);
      expect(entry.description.length).toBeLessThanOrEqual(120);
      expect(entry.source.startsWith("https://")).toBe(true);
      expect(entry.readTools.filter((t) => entry.writeTools.includes(t))).toEqual([]);
      if (entry.availability === "unverified") {
        expect(entry.transport).toBeNull();
        expect(entry.unverifiedReason).toBeDefined();
        continue;
      }
      expect(entry.transport).not.toBeNull();
      const spec = parseConnectorSpec({
        name: entry.id,
        transport:
          entry.auth.kind === "oauth" && entry.transport?.kind === "http"
            ? { ...entry.transport, oauth: {} }
            : entry.transport,
        tools: catalogToolOverrides(entry),
      });
      if (spec.transport.kind === "http") {
        expect(entry.egressHosts).toContain(new URL(spec.transport.url).hostname);
      }
      if (entry.auth.kind === "token") {
        expect(secretNamesOf(spec)).toEqual([entry.auth.secret]);
        const headers = entry.transport?.kind === "http" ? entry.transport.headers : {};
        expect(headers[entry.auth.header]).toEqual({
          secret: entry.auth.secret,
          ...(entry.auth.prefix === undefined ? {} : { prefix: entry.auth.prefix }),
        });
      } else {
        expect(secretNamesOf(spec)).toEqual([]);
      }
    }
  });

  it("the entries and their kinds of login are the ones the research supports", () => {
    expect(CONNECTOR_CATALOG.map((e) => [e.id, e.auth.kind, e.availability])).toEqual([
      ["github", "token", "ready"],
      ["notion", "oauth", "ready"],
      ["linear", "oauth", "ready"],
      ["figma", "oauth", "ready"],
      ["stackoverflow", "oauth", "unverified"],
      ["google-workspace", "oauth_owner_client", "unverified"],
      ["composio", "token", "ready"],
    ]);
    // Not verified anywhere: left out.
    expect(catalogEntry("higgsfield")).toBeUndefined();
    // Composio says out loud that a third party keeps the logins.
    expect(catalogEntry("composio")?.disclosure).toBe(
      "Pelo Composio, seus logins ficam guardados na nuvem deles.",
    );
    expect(catalogEntry("composio")?.icon).toBeNull();
    expect(catalogEntry("figma")?.notes.join(" ")).toContain("6 usos por mês");
    expect(catalogEntry("stackoverflow")?.notes.join(" ")).toContain("100 usos por dia");
  });

  it("default grants are exact tool names: reads run, writes ask", () => {
    const github = catalogEntry("github");
    if (github === undefined) throw new Error("github");
    const overrides = catalogToolOverrides(github);
    expect(overrides.get_file_contents).toEqual({ risk: "read" });
    expect(overrides.issue_read).toEqual({ risk: "read" });
    expect(Object.values(overrides).every((o) => o.risk === "read")).toBe(true);
    expect(Object.keys(overrides)).toEqual([...github.readTools]);
    expect(catalogToolOverrides({ ...github, readTools: ["a"], writeTools: ["b"] })).toEqual({
      a: { risk: "read" },
      b: { risk: "external_irreversible" },
    });
    // An exact name, not a pattern: no entry lists anything but plain names.
    for (const entry of CONNECTOR_CATALOG) {
      for (const tool of [...entry.readTools, ...entry.writeTools]) {
        expect(tool.includes("*")).toBe(false);
      }
    }
  });
});

describe("tools the gallery never offers", () => {
  it("Composio denies its shell, workbench, free proxy and blocking wait by exact name, and keeps the four that ask", () => {
    const composio = catalogEntry("composio");
    expect(composio?.deniedTools).toEqual([
      "COMPOSIO_REMOTE_BASH_TOOL",
      "COMPOSIO_REMOTE_WORKBENCH",
      "COMPOSIO_PROXY_EXECUTE",
      "COMPOSIO_WAIT_FOR_CONNECTIONS",
    ]);
    const overrides = catalogToolOverrides(composio as NonNullable<typeof composio>);
    expect(overrides.COMPOSIO_PROXY_EXECUTE).toEqual({ denied: true });
    for (const kept of [
      "COMPOSIO_SEARCH_TOOLS",
      "COMPOSIO_GET_TOOL_SCHEMAS",
      "COMPOSIO_MANAGE_CONNECTIONS",
      "COMPOSIO_MULTI_EXECUTE_TOOL",
    ]) {
      expect(overrides[kept], kept).toBeUndefined();
      expect(composio?.deniedTools).not.toContain(kept);
    }
    expect(composio?.authHosts).toEqual(["connect.composio.dev"]);
    expect(composio?.authLinkSegment).toBe("link");
    // The spec the override makes is accepted by a connector.
    const spec = parseConnectorSpec({
      name: "composio",
      transport: composio?.transport,
      tools: overrides,
    });
    expect(spec.tools.COMPOSIO_PROXY_EXECUTE?.denied).toBe(true);
  });
});

describe("search plugins of the gallery", () => {
  it("are Tavily and Brave in 'Pesquisa na web', point at their engine by exact id and are no connector", () => {
    expect(SEARCH_PLUGIN_CATALOG.map((e) => [e.id, e.provider, e.category])).toEqual([
      ["tavily", "tavily", "Pesquisa na web"],
      ["brave", "brave", "Pesquisa na web"],
    ]);
    const connectorIds = new Set(CONNECTOR_CATALOG.map((e) => e.id));
    for (const entry of SEARCH_PLUGIN_CATALOG) {
      expect(connectorIds.has(entry.id), entry.id).toBe(false);
      expect(entry.source.startsWith("https://")).toBe(true);
      expect(entry.keySteps.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(120);
    }
    expect(searchPluginOf("tavily")?.name).toBe("Tavily");
    // Firecrawl stays out; an unknown engine has no entry.
    expect(searchPluginOf("firecrawl")).toBeUndefined();
    expect(searchPluginOf("Tavily")).toBeUndefined();
  });
});
