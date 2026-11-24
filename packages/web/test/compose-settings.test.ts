import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINES, searxEngineIds } from "../src/engines.js";
import { renderSearxSettings } from "../src/searx-settings.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the committed files agree with the code", () => {
  it("docker/searxng/settings.yml is what the code renders for the default SearXNG engines (only DuckDuckGo; the others are asked by Suup itself), with no proxy and no secret", () => {
    // The file is generated: to change it, change the engine list or the renderer, then write the
    // rendered text here (it is the same function the worker uses for the container it starts).
    expect(read("../../../docker/searxng/settings.yml")).toBe(
      renderSearxSettings({ engines: searxEngineIds(DEFAULT_ENGINES) }),
    );
  });

  it("the compose files pin the same SearXNG image as the code", async () => {
    const { SEARXNG_IMAGE } = await import("../src/engines.js");
    const tag = SEARXNG_IMAGE.slice(SEARXNG_IMAGE.lastIndexOf(":") + 1);
    expect(read("../../../docker-compose.yml")).toContain(tag);
    expect(read("../../../docker-compose.prod.yml")).toContain(tag);
    // O Dokploy: quem baixa a imagem no Docker isolado é o serviço `images` do compose.
    expect(read("../../../docker-compose.dokploy.yml")).toContain(SEARXNG_IMAGE);
    expect(tag).not.toBe("latest");
  });

  it("the Dokploy compose pulls (never builds) and gives the bot images the exact names its example config uses", () => {
    const compose = read("../../../docker-compose.dokploy.yml");
    const config = JSON.parse(read("../../../suup.config.dokploy.example.json")) as {
      sandbox: { image: string; connectors: { image: string } };
      web: { reader: { image: string } };
    };
    // O build acontece no GitHub (.github/workflows/images.yml): nada é compilado na VPS.
    expect(compose).not.toContain("build:");
    for (const local of [
      config.sandbox.image,
      config.sandbox.connectors.image,
      config.web.reader.image,
    ]) {
      expect(compose).toContain(` ${local}`);
    }
  });
});
