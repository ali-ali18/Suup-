import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the committed files agree with the code", () => {
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
